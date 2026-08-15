/**
 * snow_blast_radius_dependents - Find every artifact that uses a given one
 *
 * The go-to "what will break if I touch this?" tool. Uses a 3-phase deep
 * search so it never silently misses a caller:
 *   1. Curated catalog (25+ artifact types from ARTIFACT_SPECS)
 *   2. sys_dictionary discovery (every table with script-type fields)
 *   3. Long-tail batch search (concurrency-limited)
 *
 * Looks in business rules, client scripts, UI actions + policies, script
 * includes, workflows, flow actions, email notifications, inbound email
 * actions, catalog client scripts / UI policies, scheduled jobs, fix
 * scripts, transform scripts, processors, ACLs, metric definitions, ATF
 * steps, and any custom script-bearing table the customer has added
 * (discovered dynamically via sys_dictionary).
 */

import { createHash, randomBytes } from "crypto"
import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import { resolveTenantScope, tenantScopedKey } from "../../shared/tenant-scope.js"
import { ARTIFACT_TABLE_MAP } from "./shared/metadata-tables.js"
import { searchDependents, type SearchPattern } from "./shared/deep-search.js"

/**
 * Surfaces a blast-radius scan does NOT cover. Returned alongside every
 * result so downstream consumers (chat UI, agents) can warn the user
 * against treating a low-dependent count as a green light for delete.
 *
 * Format: "<short label> — <one-sentence explanation>" so a UI can split
 * on " — " for a compact tag/tooltip view.
 */
const OUT_OF_SCOPE_SURFACES: string[] = [
  "Row data — values inside incident.work_notes, journal fields, comments, and other record-level content are not scanned.",
  "Saved filters and reports — sys_filter encoded queries and sys_report definitions reference fields and tables but are not script-typed.",
  "Update sets — pending sys_update_xml payloads are out of scope here; use snow_blast_radius_update_sets for those.",
  "External consumers — MID server scripts, Integration Hub spokes, and REST callers from other systems can use this artifact without showing up.",
  "Plain-string properties — sys_property values and other non-script string fields are not searched; only fields with internal_type in {script, script_plain, script_server, xml, condition_string} are.",
  "Inactive records — unless include_inactive is set, only active=true records are searched.",
  "Inactive plugins — when a plugin is not activated, the artifact class backed by it (e.g. Service Portal widgets without sp_widget) is silently absent from results.",
]

const SCOPE_CAVEAT =
  "Scan covers all script-bearing fields ServiceNow's sys_dictionary marks as script/condition. " +
  "Surfaces listed in out_of_scope_surfaces are NOT searched — verify those manually before any delete or rename decision."

/**
 * Per-process salt for the credential fingerprint below. Random per boot, so a
 * digest carries no meaning outside this process and cannot be matched against
 * a precomputed table if it ever surfaces in a heap dump. Immutable and
 * tenant-agnostic: safe module-level state.
 */
const FINGERPRINT_SALT = randomBytes(16).toString("hex")

/**
 * Fingerprint of the identity whose ACLs decide what Phase 2 can see. Two
 * callers share a fingerprint only when they are literally the same
 * ServiceNow identity on the same instance, in which case a shared cache
 * entry discloses nothing either side could not read itself.
 *
 * `accessToken` is in here and it is the field that matters most. The one
 * embedder that reaches this fallback is serac-platform's
 * `runOssBlastRadius()`, which passes `{instanceUrl, accessToken, clientId,
 * clientSecret, sessionId}` and no tenantId. Its clientId/clientSecret come
 * off the *instance* record, so two tenants pointed at one shared instance
 * present identical OAuth client credentials — the access token is their only
 * distinguishing secret. Leaving it out of the digest merged them into one
 * cache entry and handed tenant B tenant A's private `u_*` table names.
 *
 * A rotated token yields a new fingerprint, i.e. a cold cache rather than a
 * stale one. That is the safe direction, and `pruneDiscoveryCache()` in
 * deep-search.ts caps the entries a rotating token can accumulate.
 */
const credentialFingerprint = (context: ServiceNowContext): string =>
  createHash("sha256")
    .update(
      [
        FINGERPRINT_SALT,
        context.instanceUrl ?? "",
        context.clientId ?? "",
        context.clientSecret ?? "",
        context.accessToken ?? "",
        context.refreshToken ?? "",
        context.username ?? "",
        context.password ?? "",
      ].join("\x00"),
    )
    .digest("hex")

/**
 * Key for the Phase-2 `sys_dictionary` discovery cache in deep-search.ts.
 *
 * That cache is a process-global Map, so this key *is* the isolation boundary.
 * What it holds is every script-bearing (table, field) pair visible to the
 * credentials that made the request — up to 5000 rows, custom `u_*` tables
 * included. Sharing an entry across tenants breaks in both directions:
 *
 *   - confidentiality: tenant B inherits tenant A's schema and then issues
 *     Phase-3 queries against A's private table names;
 *   - correctness, and this is the worse one: a tenant whose integration user
 *     sees little primes a short (or empty) pair list, and for the next five
 *     minutes every other tenant on that instance silently scans zero
 *     long-tail tables. Phase 1 still runs, so the answer looks complete —
 *     an under-reported blast radius on the one tool whose output decides
 *     "is it safe to delete this?".
 *
 * The correct axis is (tenant, instance), never session. Within a tenant every
 * user authenticates as the same ServiceNow integration user per instance, so
 * their dictionary view is identical and sharing is the whole point; a session
 * id neither isolates tenants (it is not a tenant) nor reuses anything (a key
 * per chat guarantees a cold cache). The previous key —
 * `sessionId || instanceUrl || "default"` — got both halves wrong: it fell
 * back to a bare instance URL that every tenant on a shared instance collides
 * on, and to the literal `"default"` that every caller collides on.
 */
export const discoveryCacheKey = (context: ServiceNowContext): string => {
  const tenant = resolveTenantScope(context)
  // stdio resolves to the "stdio" sentinel: that transport is single-tenant by
  // construction (one process, one user, one credential set), so in-process
  // sharing across requests is legitimate there. HTTP always carries a real
  // tenant id — handlers/call-tool.ts refuses the request otherwise.
  //
  // tenantScopedKey escapes both halves, so a tenant id containing the NUL
  // separator cannot address another tenant's slot: tenant `1042` on instance
  // `X\x00Y` and tenant `1042\x00X` on instance `Y` are distinct keys.
  if (tenant) return tenantScopedKey(tenant, context.instanceUrl)
  // No provable tenant (an embedder calling this executor directly). Falling
  // back to a shared literal is exactly the leak described above, so fail
  // closed onto the identity that actually governs visibility. Bounded: one
  // entry per distinct credential set, not one per call. Colliding with the
  // tenant branch would take a tenant literally named "cred" whose instanceUrl
  // equals the digest — and FINGERPRINT_SALT is random per boot, so that
  // digest is not predictable from outside the process.
  return tenantScopedKey("cred", credentialFingerprint(context))
}

export const toolDefinition: MCPToolDefinition = {
  name: "snow_blast_radius_dependents",
  description: `Find every artifact across the instance that uses, calls, or depends on a given artifact. Answers "what breaks if I change or delete this?"

Call this before: deleting a script include, business rule, client script, UI action, UI policy, or widget; refactoring the name / api_name / signature of a script include; removing a table; promoting a breaking change to another instance; or telling the user "it's safe to remove X".

The output is the full impact list — every caller, every referrer, in every scope. Scans 100+ tables including workflows, notifications, email actions, catalog scripts, scheduled jobs, and custom scripted tables.

Trigger phrases (agent should invoke this):
- "what uses X" / "what calls X" / "what references X"
- "wat gebruikt X" / "wat roept X aan" / "wat heeft X nodig"
- "can I delete X" / "is it safe to remove X" / "kan ik X verwijderen"
- "impact analysis" / "blast radius" / "dependency audit"
- User asks to refactor, rename, or remove a named artifact

Returns:
- dependents[] — each with type, name, scope, source_table, source_field, cross_scope flag. source_table/source_field let you distinguish a workflow-condition hit from a business-rule hit (critical for triage).
- summary — by_type + by_table counts + cross_scope count + truncation flag.
- search_stats — per-phase timing + tables scanned + cache hit, so you know the scan was thorough.

How it searches (why you can trust a "none found"):
- Phase 1: 25+ curated artifact types (human-attributed labels)
- Phase 2: sys_dictionary discovery — every table with script-type fields
- Phase 3: concurrency-limited batch query over the long tail

Deep-only by design. Takes 2-10s depending on instance size.`,
  category: "blast-radius",
  subcategory: "dependency-analysis",
  use_cases: [
    "impact-analysis",
    "dependency-audit",
    "refactoring",
    "safe-delete-check",
    "find-callers",
    "find-references",
    "breaking-change-review",
    "blast-radius",
  ],
  complexity: "advanced",
  frequency: "medium",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      artifact_type: {
        type: "string",
        enum: ["script_include", "business_rule", "client_script", "ui_action", "widget", "table"],
        description: "Type of artifact to find dependents of",
      },
      artifact_identifier: {
        type: "string",
        description: "sys_id, api_name (for script includes), or table name",
      },
      search_scope: {
        type: "string",
        enum: ["same_app", "all"],
        description: "Search within same app scope or across all scopes (default: all)",
        default: "all",
      },
      limit: {
        type: "number",
        description: "Maximum number of dependents to return (default: 100)",
        default: 100,
      },
      phase3_concurrency: {
        type: "number",
        description:
          "Parallel REST requests during Phase-3 long-tail search. Default 10. Raise on beefy instances.",
        default: 10,
      },
    },
    required: ["artifact_type", "artifact_identifier"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    artifact_type,
    artifact_identifier,
    search_scope = "all",
    limit = 100,
    phase3_concurrency = 10,
  } = args

  if (!artifact_type || !artifact_identifier) {
    return createErrorResult("artifact_type and artifact_identifier are required")
  }

  try {
    const client = await getAuthenticatedClient(context)

    // Step 1: Resolve the artifact to get canonical name + scope + patterns.
    let artifactName: string = artifact_identifier
    let artifactScope: string | null = null
    let artifactSysId: string | undefined
    let patterns: SearchPattern[] = []

    if (artifact_type === "table") {
      patterns = [
        { like: `GlideRecord('${artifact_identifier}')` },
        { like: `GlideRecord("${artifact_identifier}")` },
        { like: `GlideAggregate('${artifact_identifier}')` },
        { like: `GlideAggregate("${artifact_identifier}")` },
      ]
      artifactName = artifact_identifier
    } else if (artifact_type === "script_include") {
      try {
        const isGuid = /^[a-f0-9]{32}$/.test(artifact_identifier)
        const siQuery = isGuid
          ? `sys_id=${artifact_identifier}`
          : `name=${artifact_identifier}^ORapi_name=${artifact_identifier}`

        const siResponse = await client.get("/api/now/table/sys_script_include", {
          params: {
            sysparm_query: siQuery,
            sysparm_fields: "sys_id,name,api_name,sys_scope",
            sysparm_limit: 1,
          },
        })

        const si = siResponse.data.result?.[0]
        if (si) {
          artifactName = si.name
          artifactScope = si.sys_scope?.value || si.sys_scope || null
          artifactSysId = si.sys_id
          patterns.push({ like: `new ${si.name}(` })
          // Bare name match needs a word-boundary confirm to avoid hits
          // inside unrelated identifiers ("ScooterUtilities" containing "Util").
          patterns.push({
            like: si.name,
            confirm: new RegExp(`\\b${escapeRegex(si.name)}\\b`),
          })
          if (si.api_name && si.api_name !== si.name) {
            patterns.push({
              like: si.api_name,
              confirm: new RegExp(`\\b${escapeRegex(si.api_name)}\\b`),
            })
          }
        } else {
          patterns.push({ like: `new ${artifact_identifier}(` })
          patterns.push({
            like: artifact_identifier,
            confirm: new RegExp(`\\b${escapeRegex(artifact_identifier)}\\b`),
          })
        }
      } catch {
        patterns.push({ like: `new ${artifact_identifier}(` })
        patterns.push({ like: artifact_identifier })
      }
    } else {
      // business_rule | client_script | ui_action | widget — resolve by sys_id
      const mapping = ARTIFACT_TABLE_MAP[artifact_type]
      if (mapping) {
        try {
          const artResponse = await client.get(`/api/now/table/${mapping.table}/${artifact_identifier}`)
          const art = artResponse.data.result
          if (art) {
            artifactName = art.name || art.short_description || artifact_identifier
            artifactScope = art.sys_scope?.value || art.sys_scope || null
            artifactSysId = art.sys_id
            patterns.push({
              like: artifactName,
              confirm: new RegExp(`\\b${escapeRegex(artifactName)}\\b`),
            })
          }
        } catch {
          patterns.push({ like: artifact_identifier })
        }
      } else {
        patterns.push({ like: artifact_identifier })
      }
    }

    if (patterns.length === 0) {
      return createErrorResult("Could not determine search patterns for the artifact")
    }

    // Step 2: Deep search via 3-phase engine. The key scopes the shared
    // Phase-2 discovery cache — see discoveryCacheKey() for why it is
    // (tenant, instance) and not the session.
    const { dependents, stats } = await searchDependents(client, discoveryCacheKey(context), {
      patterns,
      limit,
      scopeFilterSysId: search_scope === "same_app" && artifactScope ? artifactScope : undefined,
      selfSysId: artifactSysId,
      phase3Concurrency: Math.max(1, Math.min(phase3_concurrency, 25)),
    })

    // Step 3: Aggregate summary.
    const byType: Record<string, number> = {}
    const byTable: Record<string, number> = {}
    let crossScopeCount = 0
    for (const dep of dependents) {
      byType[dep.type] = (byType[dep.type] || 0) + 1
      byTable[dep.source_table] = (byTable[dep.source_table] || 0) + 1
      if (dep.cross_scope) crossScopeCount += 1
    }

    const impactWarning =
      dependents.length === 0
        ? `Zero dependents found within the scriptable surface area. This is NOT the same as "safe to delete" — manually verify the out_of_scope_surfaces (records, saved filters/reports, update sets, external consumers, sys_property values) before removing this artifact.`
        : dependents.length > 20
          ? `This artifact has ${dependents.length}${stats.truncated ? "+" : ""} dependents. Modifying it requires careful testing${crossScopeCount > 0 ? ` across ${crossScopeCount} cross-scope references and ` : ", "}all dependent artifacts.`
          : crossScopeCount > 0
            ? `This artifact has ${crossScopeCount} cross-scope dependent${crossScopeCount === 1 ? "" : "s"}. Changes may affect other application scopes.`
            : null

    const totalTablesScanned =
      stats.phase_1.tables + stats.phase_3.tables

    const resultData = {
      artifact: {
        name: artifactName,
        type: artifact_type,
        identifier: artifact_identifier,
        scope: artifactScope,
      },
      dependents,
      summary: {
        total_dependents: dependents.length,
        by_type: byType,
        by_table: byTable,
        cross_scope_count: crossScopeCount,
        tables_scanned: totalTablesScanned,
        truncated: stats.truncated,
      },
      search_stats: stats,
      impact_warning: impactWarning,
      scope_caveat: SCOPE_CAVEAT,
      out_of_scope_surfaces: OUT_OF_SCOPE_SURFACES,
    }

    const humanSummary = [
      `"${artifactName}" (${artifact_type}) has ${dependents.length}${stats.truncated ? "+" : ""} dependent${dependents.length === 1 ? "" : "s"}`,
      crossScopeCount > 0 ? ` (${crossScopeCount} cross-scope)` : "",
      `. Searched ${totalTablesScanned} table${totalTablesScanned === 1 ? "" : "s"} in ${(stats.total_duration_ms / 1000).toFixed(1)}s`,
      impactWarning ? ". ⚠️" : "",
    ].join("")

    return createSuccessResult(
      resultData,
      {
        apiCalls:
          stats.phase_1.tables + stats.phase_3.tables + (stats.phase_2.cached ? 0 : 1) + 1,
        durationMs: stats.total_duration_ms,
      },
      humanSummary,
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export const version = "2.0.0"
export const author = "Serac Blast Radius"
