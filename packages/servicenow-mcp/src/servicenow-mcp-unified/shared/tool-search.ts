/**
 * Tool Search - Session-based tool enabling for lazy loading mode
 *
 * Ported from the original JavaScript implementation to TypeScript.
 *
 * This module provides:
 *   - Tool index for lightweight search (name + description only)
 *   - Per-(tenant, session) enabled-tools tracking via an injectable store
 *   - File-based default store for stdio, memory-backed for HTTP
 *
 * Multi-tenant safety (PR-6a): all state operations take a `tenantId` so
 * two tenants with the same session ID cannot see each other's enabled
 * tools. The default tenantId `"stdio"` is safe only in the single-user
 * stdio context; HTTP callers must always pass the resolved tenant ID
 * (`ctx.serviceNow.tenantId`). See also `ToolSessionStore`.
 *
 * Callers should derive that ID with `resolveTenantScope()` from
 * `shared/tenant-scope.ts` (re-exported below) rather than writing
 * `context.tenantId ?? "stdio"` inline: the helper fails closed on a
 * multi-tenant transport instead of quietly parking an unidentified caller in
 * the shared stdio bucket. The default parameter is kept only for the
 * single-tenant stdio embedders (`src/enterprise-proxy/*`) that call these
 * functions with no tenant at all.
 *
 * The store keys on (tenant, session) with nested maps, never with a composed
 * string, so the scope goes in verbatim. Caches that DO flatten a tenant into
 * one string key must compose it with `tenantScopedKey()`.
 *
 * @see https://www.anthropic.com/engineering/advanced-tool-use
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { mcpDebug } from "../../shared/mcp-debug.js"
import { FileToolSessionStore, type ToolSessionStore } from "./tool-session-store.js"
import { STDIO_TENANT } from "./tenant-scope.js"

// Re-exported so callers that already reach for the tenancy rule through this
// module keep working. `shared/tenant-scope.ts` is the definition; it is
// import-free so that low-level modules (auth.ts, scripted-exec.ts) can key on
// a tenant without depending on the tool index.
export { STDIO_TENANT, resolveTenantScope, tenantScopedKey } from "./tenant-scope.js"

/**
 * Tool index entry - lightweight representation for search
 */
export interface ToolIndexEntry {
  id: string
  description: string
  category: string
  keywords: string[]
  deferred: boolean
}

/**
 * Build the index the transports register at bootstrap.
 *
 * `stdio.ts` and `http-entry.ts` each carried their own copy of this mapping,
 * and the retrieval eval needs the same one. Either copy drifting — a
 * different truncation length, a field the ranker reads that only one of them
 * fills — silently changes what a session can find, and nothing fails.
 *
 * `deferred` is the one thing the callers genuinely disagree on: stdio defers
 * the whole catalog so `tool_search` is the only way in, HTTP marks it
 * available because the portal budgets tools itself. It does not affect
 * ranking. Note that keywords come from the untruncated description even
 * though the indexed description is cut at 200 chars.
 */
export function buildToolIndex(
  tools: { name: string; description: string }[],
  categoryOf: (name: string) => string,
  deferred: boolean,
): ToolIndexEntry[] {
  return tools.map((tool) => ({
    id: tool.name,
    description: tool.description.substring(0, 200),
    category: categoryOf(tool.name),
    keywords: extractKeywords(tool.name, tool.description),
    deferred,
  }))
}

/**
 * Derive the search keywords for a tool from its name and description.
 *
 * Lived as a private copy in both transports — the http-entry copy carried a
 * comment saying it mirrored the stdio one, which is the sort of pairing that
 * drifts. `src/enterprise-proxy/tool-cache.ts` has a genuinely different one
 * for non-`snow_` tools; that is not this.
 */
function extractKeywords(name: string, description: string): string[] {
  const keywords = new Set<string>()

  // snow_query_incidents -> query, incidents
  for (const part of name.replace(/^snow_/, "").split("_")) {
    if (part.length > 2) keywords.add(part.toLowerCase())
  }

  // Only the first 10 significant description words are indexed, so a tool
  // whose distinguishing noun appears late in a long description is not
  // reachable by keyword — see the eval's reported misses.
  const descWords = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !["this", "that", "with", "from", "will", "have", "been", "tool"].includes(w))
  for (const word of descWords.slice(0, 10)) keywords.add(word)

  return Array.from(keywords)
}

/**
 * Ranking vocabulary and the derived index the scorer reads.
 *
 * The ranker this replaced matched query words with `includes()` against the
 * whole id, description and every keyword, keeping any word longer than two
 * characters. Three-letter English words therefore matched inside real tokens:
 * "the" hit `snow_sp_theme_manage` four ways at once (id, description, and the
 * keywords "theme" and "theming") for +31, which made it the top result for a
 * quarter of the eval's realistically-phrased queries — "close the incident and
 * fill in the resolution notes" among them. "for" did the same to anything
 * carrying "form"/"platform"/"performance", "out" to "outage"/"layout", "not"
 * to "notification". See issue #298 for the measurement.
 *
 * What replaces it, in the order it matters:
 *
 *  1. WHOLE TOKENS. Ids split on `_`, text on every non-alphanumeric run, so
 *     "the" matches the word "the" and nothing else. A query term that is a
 *     strict prefix of an indexed token still scores, at 40%, which is what
 *     reaches "SyntaxErrors" from "syntax".
 *  2. IDF. A term is worth log((N+1)/(df+1)), so a word carried by half the
 *     catalog barely moves a score and a word carried by three tools decides
 *     it. This is what makes the old bonus stack survivable: the weights below
 *     are the original 10/8/5, and the rarity multiplier does the separating.
 *  3. COVERAGE. The final score is multiplied by 1 + (terms matched / terms
 *     asked for), so a tool that answers two thirds of a request outranks one
 *     that answers a third of it three times over. Additive scoring alone
 *     rewards repetition of one term over breadth across several.
 *  4. SYNONYMS, query-side only, at 70%. People do not use the platform's
 *     nouns: they ask about a "ticket", a "column", who is on "shift", whether
 *     the "mail" went out. Expanding the query keeps the index untouched and
 *     the discount keeps a real term ahead of an inferred one.
 *
 * Stop words are removed before any of that. They are ordinary English, not
 * ServiceNow vocabulary — no entry here is a word the catalog uses to name
 * anything, which is why "change", "task" and "request" are absent from a list
 * that otherwise looks like it should hold them.
 *
 * Measured with `tool-search-eval.test.ts` over its 101 queries: recall@1
 * 0.267 -> 0.426, recall@5 0.505 -> 0.663, recall@20 0.663 -> 0.802, MRR
 * 0.384 -> 0.535.
 *
 * Two things were measured and NOT taken:
 *   - Indexing each tool's `use_cases`. It buys recall@20 on the queries the
 *     old ranker already failed and loses recall@1 everywhere else; on the
 *     subset that was never inspected while tuning it is worse on every
 *     metric, which is the signature of a change fitted to the hard cases.
 *   - Lifting the 10-word cap on description keywords. Slightly worse across
 *     the board: the eleventh word of a description is noise more often than
 *     it is the distinguishing noun.
 */
const STOP_WORDS = new Set(
  (
    "the a an and or but if then of to in on at by for with from into as is are was were be been being do does " +
    "did doing have has had will would can could should shall may might must i me my we us our you your it its " +
    "this that these those there here what which who whom when where why how all any some no not only own same " +
    "so than too very just now up out off over under again more most other such about after before between " +
    "through show give need want let make get got set put use using tell find please"
  ).split(" "),
)

/**
 * Words people use for things the catalog names differently. One-way,
 * query-side: `ticket` also searches for `incident`, but a tool whose
 * description says "incident" does not become findable as "ticket" in reverse.
 *
 * Keep this to genuine vocabulary gaps. Mapping a common word onto another
 * common word ("list" -> "query") measures worse, because both sides are
 * already everywhere in the catalog.
 */
const SEARCH_SYNONYMS: Record<string, readonly string[]> = {
  add: ["create"],
  approve: ["approval"],
  article: ["knowledge"],
  asset: ["asset", "ci"],
  authorise: ["approval"],
  authorize: ["approval"],
  backlog: ["agile", "backlog"],
  broken: ["log", "error"],
  build: ["create"],
  code: ["script"],
  column: ["field", "element"],
  attribute: ["field"],
  access: ["acl", "role"],
  dashboard: ["dashboard", "report"],
  deploy: ["deployment", "update_set"],
  duplicate: ["reconcile", "identify"],
  edit: ["update"],
  employee: ["user"],
  error: ["log", "error", "exception"],
  form: ["form", "ui"],
  host: ["ci", "cmdb"],
  issue: ["incident", "problem"],
  job: ["scheduled", "job"],
  kb: ["knowledge"],
  list: ["query", "get"],
  log: ["log", "history"],
  machine: ["ci", "cmdb"],
  mail: ["email", "notification"],
  member: ["user", "group"],
  message: ["email", "notification"],
  metric: ["metric", "indicator"],
  modify: ["update"],
  new: ["create"],
  outage: ["incident", "event"],
  page: ["sp", "portal"],
  people: ["user"],
  permission: ["acl", "role", "security"],
  person: ["user"],
  release: ["release", "deployment"],
  remove: ["delete"],
  right: ["acl", "role"],
  rota: ["oncall"],
  roster: ["oncall", "rota"],
  run: ["execute"],
  search: ["query", "find"],
  server: ["ci", "cmdb"],
  shift: ["oncall", "rota", "schedule"],
  signoff: ["approval"],
  slow: ["performance", "slow"],
  sprint: ["agile", "sprint"],
  staff: ["user"],
  story: ["agile", "story"],
  team: ["group"],
  ticket: ["incident", "task", "request"],
  trigger: ["execute", "flow"],
  variable: ["variable", "catalog"],
  view: ["view", "list"],
  widget: ["sp", "widget"],
  workflow: ["flow", "workflow"],
}

/** Field weights, unchanged from the ranker this replaces. */
const WEIGHT_ID = 10
const WEIGHT_KEYWORD = 8
const WEIGHT_DESCRIPTION = 5
/** A query term that is a strict prefix of an indexed token, e.g. syntax/SyntaxErrors. */
const PREFIX_CREDIT = 0.4
/** An inferred term is worth less than one the caller actually typed. */
const SYNONYM_CREDIT = 0.7
/** Shortest query term that may match by prefix. Below this it is noise. */
const MIN_PREFIX_LENGTH = 4

/** Split on every non-alphanumeric run, so `snow_get_logs` and "Get logs." agree. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * Fold the regular English plural only. Not a stemmer: "running" stays
 * "running", because guessing at verb forms costs more than it returns on a
 * catalog whose ids are nouns and imperatives.
 */
function foldPlural(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y"
  if (word.length > 3 && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  return word
}

/** Distinct folded tokens of a piece of text. */
function terms(text: string): string[] {
  return [...new Set(tokenize(text).map(foldPlural))]
}

interface SearchDoc {
  entry: ToolIndexEntry
  id: string[]
  description: string[]
  keywords: string[]
  category: string[]
}

/**
 * Derived from `toolIndex` and invalidated whenever it changes. Static,
 * tenant-agnostic metadata, exactly like the index it is derived from — see
 * the allowlist entry in `__tests__/no-module-state.test.ts`.
 */
let searchDocs: { docs: SearchDoc[]; idf: (term: string) => number } | undefined

function invalidateSearchDocs(): void {
  searchDocs = undefined
}

function getSearchDocs(): { docs: SearchDoc[]; idf: (term: string) => number } {
  if (searchDocs) return searchDocs

  const docs: SearchDoc[] = toolIndex.map((entry) => ({
    entry,
    id: terms(entry.id.replace(/^snow_/, "")),
    description: terms(entry.description),
    keywords: [...new Set(entry.keywords.map((keyword) => foldPlural(keyword.toLowerCase())))],
    category: terms(entry.category),
  }))

  const documentFrequency = new Map<string, number>()
  for (const doc of docs) {
    for (const term of new Set([...doc.id, ...doc.description, ...doc.keywords, ...doc.category])) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }

  const total = docs.length
  // Smoothed so it is never zero. A term carried by every tool in the index
  // has no discriminative value and the plain log((N+1)/(df+1)) is 0 for it —
  // correct as a ranking weight, fatal as a filter, because `score > 0` is
  // what decides whether a tool is returned at all. On a one-tool index (the
  // list_changed tests build exactly that) every term is carried by every
  // tool, and searching "query table" against snow_query_table returned
  // nothing.
  const idf = (term: string) => Math.log(1 + (total + 1) / ((documentFrequency.get(term) ?? 0) + 1))

  searchDocs = { docs, idf }
  return searchDocs
}

/** 1 for an exact token, PREFIX_CREDIT for a prefix, 0 for neither. */
function fieldMatch(field: string[], term: string): number {
  if (field.includes(term)) return 1
  if (term.length < MIN_PREFIX_LENGTH) return 0
  return field.some((token) => token.length > term.length && token.startsWith(term)) ? PREFIX_CREDIT : 0
}

/** The query terms to score with, each carrying its credit: 1 typed, SYNONYM_CREDIT inferred. */
function expandQuery(query: string): { asked: string[]; scored: { term: string; credit: number }[] } {
  // Stop words are removed BEFORE folding, not after. Folding first turns
  // "does" into "doe" and "this" into "thi", neither of which is on the list
  // any more — and both then score against real tokens.
  const asked = [
    ...new Set(
      tokenize(query)
        .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
        .map(foldPlural),
    ),
  ]
  const scored = asked.map((term) => ({ term, credit: 1 }))

  for (const term of asked) {
    for (const synonym of SEARCH_SYNONYMS[term] ?? []) {
      const folded = foldPlural(synonym)
      if (!scored.some((entry) => entry.term === folded)) scored.push({ term: folded, credit: SYNONYM_CREDIT })
    }
  }

  return { asked, scored }
}

/**
 * Active session store. Defaults to file-backed for stdio; the HTTP
 * transport should call `setSessionStore(new MemoryToolSessionStore())`
 * at startup to opt into in-memory, per-tenant isolation.
 */
let sessionStore: ToolSessionStore = new FileToolSessionStore()

/**
 * Replace the session store at runtime. Called by transports during bootstrap.
 */
export function setSessionStore(store: ToolSessionStore): void {
  sessionStore = store
}

/**
 * Get the storage directory for the current-session pointer file.
 * (Stdio-only — used by `setCurrentSessionId` / `getCurrentSessionId`.)
 */
function getCurrentSessionDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "snow-code")
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "snow-code")
  }
  return path.join(os.homedir(), ".local", "share", "snow-code")
}

/**
 * Get the current session ID file path (stdio only).
 * This file is written by snow-code and read by MCP server.
 */
function getCurrentSessionFilePath(): string {
  const dataDir = getCurrentSessionDir()
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
  return path.join(dataDir, "current-session.json")
}

/**
 * STDIO-ONLY: Get the current session ID from env var or session file.
 * HTTP callers must extract sessionId from the JWT payload — the machine-local
 * session file has no meaning in a multi-tenant server.
 */
export function getCurrentSessionId(): string | undefined {
  // First check environment variable
  if (process.env.SNOW_SESSION_ID) {
    return process.env.SNOW_SESSION_ID
  }

  // Then check session file
  try {
    const filePath = getCurrentSessionFilePath()
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"))
      if (data.sessionId) {
        return data.sessionId
      }
    }
  } catch (e: any) {
    mcpDebug(`[ToolSearch] Failed to read current session: ${e.message}`)
  }

  return undefined
}

/**
 * STDIO-ONLY: Set the current session ID (called by snow-code when session starts).
 */
export function setCurrentSessionId(sessionId: string): void {
  try {
    const filePath = getCurrentSessionFilePath()
    const data = JSON.stringify(
      {
        sessionId,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )
    fs.writeFileSync(filePath, data, "utf-8")
    mcpDebug(`[ToolSearch] Set current session: ${sessionId}`)
  } catch (e: any) {
    mcpDebug(`[ToolSearch] Failed to set current session: ${e.message}`)
  }
}

// Tool index (lightweight search index) — purely static data, shared across tenants.
let toolIndex: ToolIndexEntry[] = []

/**
 * ToolSearch namespace - session-based tool enabling
 */
export namespace ToolSearch {
  /**
   * Register a tool in the search index
   */
  export function registerTool(entry: ToolIndexEntry): void {
    const existing = toolIndex.findIndex((t) => t.id === entry.id)
    if (existing >= 0) {
      toolIndex[existing] = entry
    } else {
      toolIndex.push(entry)
    }
    invalidateSearchDocs()
  }

  /**
   * Register multiple tools at once
   */
  export function registerTools(entries: ToolIndexEntry[]): void {
    for (const entry of entries) {
      registerTool(entry)
    }
  }

  /**
   * Get the tool index
   */
  export function getIndex(): ToolIndexEntry[] {
    return toolIndex
  }

  /**
   * Clear the tool index
   */
  export function clearIndex(): void {
    toolIndex = []
    invalidateSearchDocs()
  }

  /**
   * Search tools by query using multiple strategies
   */
  export function search(query: string, limit: number = 20): ToolIndexEntry[] {
    const queryLower = query.toLowerCase()
    const { docs, idf } = getSearchDocs()
    const { asked, scored: queryTerms } = expandQuery(query)

    const results = docs.map((doc) => {
      let score = 0

      // Whole-query bonuses. These fire when someone pastes a tool id or a
      // phrase verbatim, and they are left as they were: substring matching is
      // only a problem for the individual WORDS of a sentence.
      const idLower = doc.entry.id.toLowerCase()
      if (idLower === queryLower) score += 100
      if (idLower.includes(queryLower)) score += 50
      if (idLower.startsWith(queryLower)) score += 30
      if (doc.entry.description.toLowerCase().includes(queryLower)) score += 20
      if (doc.keywords.includes(queryLower)) score += 40

      // Term-level matching: whole tokens, weighted by how rare the term is.
      let matched = 0
      for (const { term, credit } of queryTerms) {
        const weight = idf(term) * credit
        const points =
          WEIGHT_ID * weight * fieldMatch(doc.id, term) +
          WEIGHT_KEYWORD * weight * fieldMatch(doc.keywords, term) +
          WEIGHT_DESCRIPTION * weight * fieldMatch(doc.description, term)

        // Only terms the caller actually typed count towards coverage — a tool
        // reached entirely through synonyms should not read as a full answer.
        if (points > 0 && credit === 1) matched++
        score += points
      }

      if (queryTerms.some(({ term }) => doc.category.includes(term))) score += 25

      // Breadth over repetition: answering more of the question wins.
      if (asked.length > 0) score *= 1 + matched / asked.length

      return { tool: doc.entry, score }
    })

    return results
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((result) => result.tool)
  }

  /**
   * Enable a deferred tool for a (tenant, session).
   * `tenantId` defaults to the stdio sentinel for backwards-compat; HTTP
   * callers must always pass the tenant's actual ID.
   */
  export async function enableTool(sessionID: string, toolID: string, tenantId: string = STDIO_TENANT): Promise<void> {
    const current = await sessionStore.getEnabled(tenantId, sessionID)
    current.add(toolID)
    await sessionStore.setEnabled(tenantId, sessionID, current)
    mcpDebug(`[ToolSearch] Enabled tool '${toolID}' for ${tenantId}/${sessionID}`)
  }

  /**
   * Enable multiple deferred tools for a (tenant, session).
   */
  export async function enableTools(
    sessionID: string,
    toolIDs: string[],
    tenantId: string = STDIO_TENANT,
  ): Promise<void> {
    const current = await sessionStore.getEnabled(tenantId, sessionID)
    for (const toolID of toolIDs) {
      current.add(toolID)
    }
    await sessionStore.setEnabled(tenantId, sessionID, current)
    mcpDebug(`[ToolSearch] Enabled ${toolIDs.length} tools for ${tenantId}/${sessionID}`)
  }

  /**
   * Check if a deferred tool is enabled for a (tenant, session).
   */
  export async function isToolEnabled(
    sessionID: string,
    toolID: string,
    tenantId: string = STDIO_TENANT,
  ): Promise<boolean> {
    const current = await sessionStore.getEnabled(tenantId, sessionID)
    return current.has(toolID)
  }

  /**
   * Get all enabled tools for a (tenant, session).
   */
  export async function getEnabledTools(sessionID: string, tenantId: string = STDIO_TENANT): Promise<Set<string>> {
    return sessionStore.getEnabled(tenantId, sessionID)
  }

  /**
   * Clear enabled tools for a (tenant, session).
   */
  export async function clearSession(sessionID: string, tenantId: string = STDIO_TENANT): Promise<void> {
    await sessionStore.clear(tenantId, sessionID)
    mcpDebug(`[ToolSearch] Cleared ${tenantId}/${sessionID}`)
  }

  /**
   * Get statistics about the tool index
   */
  export function getStats(): {
    total: number
    deferred: number
    immediate: number
    categories: Record<string, number>
  } {
    const categories: Record<string, number> = {}
    let deferred = 0
    let immediate = 0

    for (const tool of toolIndex) {
      if (tool.deferred) {
        deferred++
      } else {
        immediate++
      }
      categories[tool.category] = (categories[tool.category] || 0) + 1
    }

    return {
      total: toolIndex.length,
      deferred,
      immediate,
      categories,
    }
  }

  /**
   * Get a tool from the index by ID
   */
  export function getToolFromIndex(toolId: string): ToolIndexEntry | undefined {
    return toolIndex.find((t) => t.id === toolId)
  }

  /**
   * Get tool status for display
   * Returns [AVAILABLE], [ENABLED], or [DEFERRED]
   */
  export async function getToolStatus(
    sessionID: string | undefined,
    toolID: string,
    tenantId: string = STDIO_TENANT,
  ): Promise<"[AVAILABLE]" | "[ENABLED]" | "[DEFERRED]"> {
    const tool = getToolFromIndex(toolID)
    if (!tool) {
      // Unknown tool - treat as deferred (must be enabled via tool_search first)
      if (sessionID) {
        const enabled = await isToolEnabled(sessionID, toolID, tenantId)
        if (enabled) {
          return "[ENABLED]"
        }
      }
      return "[DEFERRED]"
    }

    if (!tool.deferred) {
      return "[AVAILABLE]" // Not deferred, always available
    }

    // Tool is deferred - check if enabled for this session
    if (sessionID) {
      const enabled = await isToolEnabled(sessionID, toolID, tenantId)
      if (enabled) {
        return "[ENABLED]"
      }
    }

    return "[DEFERRED]"
  }

  /**
   * Check if a tool can be executed (not deferred OR enabled)
   */
  export async function canExecuteTool(
    sessionID: string | undefined,
    toolID: string,
    tenantId: string = STDIO_TENANT,
  ): Promise<boolean> {
    const tool = getToolFromIndex(toolID)
    if (!tool) {
      // Unknown tool - treat as deferred (must be enabled via tool_search first)
      if (sessionID) {
        return await isToolEnabled(sessionID, toolID, tenantId)
      }
      return false
    }

    if (!tool.deferred) {
      return true // Not deferred, always available
    }

    // Tool is deferred - check if enabled for this session
    if (sessionID) {
      return await isToolEnabled(sessionID, toolID, tenantId)
    }

    return false // Deferred and no session = cannot execute
  }

  /**
   * Get the current session ID (re-exported from module level)
   * Used by MCP server to get sessionId when not passed in request
   */
  export const getCurrentSession = getCurrentSessionId

  /**
   * Set the current session ID (re-exported from module level)
   * Called by snow-code when a session starts/changes
   */
  export const setCurrentSession = setCurrentSessionId
}
