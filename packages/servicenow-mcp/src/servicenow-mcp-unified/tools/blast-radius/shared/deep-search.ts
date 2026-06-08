/**
 * Blast Radius — 3-phase deep dependency search.
 *
 * Given a set of search patterns (e.g. `new IncidentUtils(` or
 * `GlideRecord('incident')`), walk every ServiceNow table that can hold
 * script / condition content and find records whose relevant fields LIKE
 * any of the patterns.
 *
 * Phase 1 — Curated catalog (known artifact types, parallel)
 *   Iterates `ARTIFACT_SPECS` from metadata-tables.ts. These 25+ types
 *   ship with human-curated `scriptFields` + `conditionFields` lists, so
 *   hits here carry full type-label attribution.
 *
 * Phase 2 — Discovery (sys_dictionary)
 *   One REST query for every (table, field) pair whose `internal_type`
 *   is in the script/condition family. Diff against Phase 1 → the
 *   long-tail of custom, plugin, or undocumented tables we haven't
 *   explicitly catalogued. Cached per-session for 5 min.
 *
 * Phase 3 — Long-tail (concurrency-limited REST)
 *   For each extra (table, field) pair found by Phase 2: LIKE query,
 *   post-filter, emit `dependents` tagged as `other` with source_table /
 *   source_field so the UI can still surface them.
 */

import { ARTIFACT_SPECS, type ArtifactSearchSpec } from "./metadata-tables.js"
import { runWithLimit } from "./concurrency.js"

// Internal types ─────────────────────────────────────────────────────────

export interface SearchPattern {
  /** The raw text to LIKE on the ServiceNow side. */
  like: string
  /**
   * Optional stricter regex used to post-filter out substring-false-positives.
   * If omitted, the LIKE text itself must appear as a literal substring.
   */
  confirm?: RegExp
}

export interface DeepSearchOptions {
  patterns: SearchPattern[]
  /** Limit total dependents returned across all phases. */
  limit: number
  /** Optional scope filter: only accept dependents where sys_scope matches. */
  scopeFilterSysId?: string
  /** Sys_id of the artifact itself — drops self-references. */
  selfSysId?: string
  /** Parallelism for Phase-3 long-tail search. */
  phase3Concurrency?: number
}

export interface DependentRecord {
  sys_id: string
  name: string
  type: string
  source_table: string
  source_field: string
  scope: string | null
  cross_scope: boolean
  table_column?: string | null // `collection` / `table` / etc, when the record has one
}

export interface SearchStats {
  phase_1: { tables: number; duration_ms: number; errors: number }
  phase_2: { discovered_pairs: number; new_pairs: number; duration_ms: number; cached: boolean }
  phase_3: { tables: number; duration_ms: number; concurrency: number; errors: number }
  total_duration_ms: number
  truncated: boolean
}

export interface DeepSearchResult {
  dependents: DependentRecord[]
  stats: SearchStats
}

// sys_dictionary discovery cache ────────────────────────────────────────

interface DiscoveryCacheEntry {
  pairs: Array<{ table: string; field: string; internal_type: string }>
  expiresAt: number
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>()
const DISCOVERY_TTL_MS = 5 * 60 * 1000

/** Types in sys_dictionary.internal_type that indicate script-bearing fields. */
const SCRIPT_INTERNAL_TYPES = ["script", "script_plain", "script_server", "xml", "condition_string"]

// ────────────────────────────────────────────────────────────────────────

/**
 * Main entry. Runs all three phases. Never throws — per-phase errors are
 * swallowed and counted in `stats.*.errors` so one 403 on an exotic table
 * doesn't kill the whole analysis.
 */
export async function searchDependents(
  client: any,
  cacheKey: string,
  options: DeepSearchOptions,
): Promise<DeepSearchResult> {
  const started = Date.now()
  const dependents: DependentRecord[] = []
  const seen = new Set<string>() // `<table>:<sys_id>` dedup

  const stats: SearchStats = {
    phase_1: { tables: 0, duration_ms: 0, errors: 0 },
    phase_2: { discovered_pairs: 0, new_pairs: 0, duration_ms: 0, cached: false },
    phase_3: { tables: 0, duration_ms: 0, concurrency: options.phase3Concurrency ?? 10, errors: 0 },
    total_duration_ms: 0,
    truncated: false,
  }

  const addDependents = (records: DependentRecord[]): void => {
    for (const rec of records) {
      if (dependents.length >= options.limit) {
        stats.truncated = true
        return
      }
      const key = `${rec.source_table}:${rec.sys_id}`
      if (seen.has(key)) continue
      seen.add(key)
      dependents.push(rec)
    }
  }

  // Phase 1 — curated catalog ───────────────────────────────────────────
  const phase1Start = Date.now()
  const phase1Tables = new Set<string>() // tables already covered by Phase 1
  const phase1Fields = new Set<string>() // `<table>:<field>` pairs
  const phase1Results = await Promise.allSettled(
    ARTIFACT_SPECS.map(async (spec) => {
      const fields = [...spec.scriptFields, ...(spec.conditionFields ?? [])]
      if (fields.length === 0) return { type: spec.type, records: [] as DependentRecord[] }
      phase1Tables.add(spec.table)
      for (const f of fields) phase1Fields.add(`${spec.table}:${f}`)
      const records = await searchOnePair(client, spec.table, fields, options, spec)
      return { type: spec.type, records }
    }),
  )
  for (const r of phase1Results) {
    if (r.status === "fulfilled") {
      addDependents(r.value.records)
    } else {
      stats.phase_1.errors += 1
    }
    if (dependents.length >= options.limit) break
  }
  stats.phase_1.tables = phase1Tables.size
  stats.phase_1.duration_ms = Date.now() - phase1Start

  if (stats.truncated) {
    stats.total_duration_ms = Date.now() - started
    return { dependents, stats }
  }

  // Phase 2 — sys_dictionary discovery ──────────────────────────────────
  const phase2Start = Date.now()
  const discovery = await getDiscoveredPairs(client, cacheKey)
  stats.phase_2.discovered_pairs = discovery.pairs.length
  stats.phase_2.cached = discovery.cached
  const extraPairs = discovery.pairs.filter(
    (p) => !phase1Fields.has(`${p.table}:${p.field}`) && !isUninterestingTable(p.table),
  )
  // Group by table — one query per table, asking for all script-bearing
  // fields on that table at once.
  const byTable = new Map<string, string[]>()
  for (const p of extraPairs) {
    const list = byTable.get(p.table) ?? []
    list.push(p.field)
    byTable.set(p.table, list)
  }
  stats.phase_2.new_pairs = extraPairs.length
  stats.phase_2.duration_ms = Date.now() - phase2Start

  // Phase 3 — long-tail batch ──────────────────────────────────────────
  const phase3Start = Date.now()
  const phase3Entries = Array.from(byTable.entries())
  stats.phase_3.tables = phase3Entries.length
  const phase3Tasks = phase3Entries.map(([table, fields]) => async () => {
    return searchOnePair(client, table, fields, options, undefined)
  })
  const phase3Results = await runWithLimit(phase3Tasks, stats.phase_3.concurrency)
  for (const res of phase3Results) {
    if (res === null) {
      stats.phase_3.errors += 1
      continue
    }
    addDependents(res)
    if (dependents.length >= options.limit) break
  }
  stats.phase_3.duration_ms = Date.now() - phase3Start

  stats.total_duration_ms = Date.now() - started
  return { dependents, stats }
}

// ────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────

async function getDiscoveredPairs(
  client: any,
  cacheKey: string,
): Promise<{ pairs: Array<{ table: string; field: string; internal_type: string }>; cached: boolean }> {
  const cached = discoveryCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return { pairs: cached.pairs, cached: true }
  }
  try {
    const response = await client.get("/api/now/table/sys_dictionary", {
      params: {
        sysparm_query: `elementISNOTEMPTY^active=true^internal_typeIN${SCRIPT_INTERNAL_TYPES.join(",")}`,
        sysparm_fields: "name,element,internal_type",
        sysparm_limit: 5000,
      },
    })
    const rows = response.data.result || []
    const pairs = rows
      .map((r: any) => ({
        table: String(r.name || ""),
        field: String(r.element || ""),
        internal_type: String(r.internal_type || ""),
      }))
      .filter((p: any) => p.table && p.field)
    discoveryCache.set(cacheKey, { pairs, expiresAt: Date.now() + DISCOVERY_TTL_MS })
    return { pairs, cached: false }
  } catch {
    // Discovery failures are non-fatal — we still get Phase-1 coverage.
    return { pairs: [], cached: false }
  }
}

/**
 * Heuristic: skip tables that are noisy/pointless to grep.
 *   - Any `sys_update_xml` payload etc. — too huge, not real dependencies.
 *   - Table history shadows that just duplicate other tables.
 */
function isUninterestingTable(table: string): boolean {
  if (!table) return true
  if (table === "sys_update_xml") return true
  if (table === "sys_metadata_delete") return true
  if (table === "sys_audit") return true
  if (table === "sys_history_line") return true
  if (table === "sys_history_set") return true
  return false
}

/**
 * Run a single LIKE query against one table covering one or more fields,
 * apply post-filter, and return normalised DependentRecord entries.
 */
async function searchOnePair(
  client: any,
  table: string,
  fields: string[],
  options: DeepSearchOptions,
  spec: ArtifactSearchSpec | undefined,
): Promise<DependentRecord[]> {
  // Build an OR of (field LIKE pattern) across all fields × all patterns.
  const likeConditions: string[] = []
  for (const field of fields) {
    for (const p of options.patterns) {
      likeConditions.push(`${field}LIKE${p.like}`)
    }
  }
  if (likeConditions.length === 0) return []
  const queryParts = [likeConditions.join("^OR")]
  if (options.scopeFilterSysId) {
    queryParts.push(`sys_scope=${options.scopeFilterSysId}`)
  }

  // Curated specs have a hand-picked selectFields string; discovered
  // tables fall back to a generic grab-bag that every table has.
  const selectFields = spec
    ? uniqueCsv(spec.selectFields + "," + fields.join(","))
    : uniqueCsv(`sys_id,sys_scope,${fields.join(",")}`)

  const perTableLimit = Math.min(
    Math.ceil(options.limit / 3),
    Math.max(25, Math.ceil(options.limit / Math.max(1, fields.length))),
  )

  let response: any
  try {
    response = await client.get(`/api/now/table/${encodeURIComponent(table)}`, {
      params: {
        sysparm_query: queryParts.join("^"),
        sysparm_fields: selectFields,
        sysparm_limit: perTableLimit,
        sysparm_display_value: "false",
      },
    })
  } catch {
    return []
  }

  const records: any[] = response.data?.result || []
  const out: DependentRecord[] = []

  for (const record of records) {
    if (options.selfSysId && record.sys_id === options.selfSysId) continue

    // Which field actually matched? We try each field in declared order.
    const matchingField = fields.find((f) => {
      const val = fieldValue(record[f])
      if (!val) return false
      return options.patterns.some((p) => confirmHit(val, p))
    })
    if (!matchingField) continue

    const recordScope = fieldValue(record.sys_scope)
    const cross_scope = options.scopeFilterSysId
      ? recordScope !== options.scopeFilterSysId
      : false

    const nameCol = spec?.nameField ?? detectNameField(record)
    out.push({
      sys_id: String(record.sys_id),
      name: nameCol ? String(record[nameCol] ?? "") : tryAnyName(record) || "(unnamed)",
      type: spec?.type ?? "other",
      source_table: table,
      source_field: matchingField,
      scope: recordScope || null,
      cross_scope,
      table_column: fieldValue(record.collection) || fieldValue(record.table) || null,
    })
  }

  return out
}

function confirmHit(body: string, pattern: SearchPattern): boolean {
  if (pattern.confirm) return pattern.confirm.test(body)
  return body.includes(pattern.like)
}

function fieldValue(v: any): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  if (typeof v === "object") {
    return String(v.value ?? v.display_value ?? "")
  }
  return String(v)
}

function detectNameField(record: Record<string, any>): string | undefined {
  for (const candidate of ["name", "short_description", "api_name", "element"]) {
    if (record[candidate] != null && record[candidate] !== "") return candidate
  }
  return undefined
}

function tryAnyName(record: Record<string, any>): string | undefined {
  for (const candidate of ["name", "short_description", "api_name", "element", "id", "operation_uri"]) {
    const v = fieldValue(record[candidate])
    if (v) return v
  }
  return undefined
}

function uniqueCsv(csv: string): string {
  const seen = new Set<string>()
  for (const part of csv.split(",").map((s) => s.trim()).filter(Boolean)) {
    seen.add(part)
  }
  return Array.from(seen).join(",")
}
