/**
 * snow_blast_radius_update_sets - Find references in update sets
 *
 * Closes the "did anyone include this in an unloaded update set?" gap
 * that snow_blast_radius_dependents leaves behind. Pending and committed
 * update sets contain XML payloads that reference artifacts by name,
 * sys_id, api_name, etc. — those references are NOT script-bearing
 * fields, so the regular blast-radius scan never sees them.
 *
 * This tool searches sys_update_xml for the artifact's identifier
 * (LIKE-match across payload + target_name + name), groups hits by
 * their parent update set + state, and warns when matches land in
 * in_progress sets (which will break or fail to commit if the artifact
 * is deleted before the set is loaded).
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_blast_radius_update_sets",
  description: `Search pending and committed update sets for references to a given artifact. Closes the "did anyone include this in an unloaded update set?" gap that snow_blast_radius_dependents leaves behind — update-set XML payloads are not script-bearing fields, so the regular scan never reads them.

Call this when:
- Preparing to delete or rename an artifact (combine with snow_blast_radius_dependents).
- Investigating why a promotion broke or will break in another instance.
- The user asks "is this in any pending update sets?" / "wat zit er nog in update sets?".

Returns:
- updates[] — each XML hit with set_name, set_state (in_progress / complete / ignore), update_xml_name, type, target_name, action, last_updated.
- summary — by_state counts, by_set counts, total hits.
- impact_warning — non-null when matches exist in any in_progress update set; those will break on commit if the artifact is gone.

Note: LIKE-matches the artifact identifier across payload + name + target_name. False positives are possible (the name appearing in a comment); confirm by inspecting the update XML when the count is low.`,
  category: "blast-radius",
  subcategory: "dependency-analysis",
  use_cases: [
    "impact-analysis",
    "refactoring",
    "safe-delete-check",
    "promotion-readiness",
    "update-set-audit",
  ],
  complexity: "intermediate",
  frequency: "medium",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      artifact_identifier: {
        type: "string",
        description:
          "Name, api_name, or sys_id of the artifact to search for in update-set XML payloads.",
      },
      states: {
        type: "array",
        items: {
          type: "string",
          enum: ["in_progress", "complete", "ignore"],
        },
        description:
          "Which update-set states to include (default: ['in_progress', 'complete']). 'ignore' is rarely useful.",
      },
      limit: {
        type: "number",
        description: "Maximum number of update_xml records to return (default: 200).",
        default: 200,
      },
    },
    required: ["artifact_identifier"],
  },
}

interface UpdateXmlHit {
  sys_id: string
  update_xml_name: string
  type: string | null
  target_name: string | null
  action: string | null
  set_sys_id: string
  set_name: string
  set_state: string
  set_description: string | null
  last_updated: string | null
}

function extractRef(field: unknown): { value: string; display: string } {
  if (!field) return { value: "", display: "" }
  if (typeof field === "string") return { value: field, display: field }
  if (typeof field === "object") {
    const f = field as { value?: string; display_value?: string }
    return { value: f.value || "", display: f.display_value || f.value || "" }
  }
  return { value: "", display: "" }
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    artifact_identifier,
    states = ["in_progress", "complete"],
    limit = 200,
  } = args

  if (!artifact_identifier || typeof artifact_identifier !== "string") {
    return createErrorResult("artifact_identifier is required (string)")
  }
  const safeLimit = Math.max(10, Math.min(Number(limit) || 200, 1000))
  const cleanStates: string[] = Array.isArray(states)
    ? states.filter((s) => s === "in_progress" || s === "complete" || s === "ignore")
    : []
  const stateFilter = cleanStates.length > 0 ? cleanStates : ["in_progress", "complete"]

  const t0 = Date.now()

  try {
    const client = await getAuthenticatedClient(context)

    // Search payload + target_name + name for the identifier. Three OR
    // clauses because update XML records may carry the name in the
    // human-readable `name` field, the `target_name` field for renames,
    // or buried inside the `payload` XML for the canonical reference.
    const identQuery =
      `payloadLIKE${artifact_identifier}` +
      `^ORtarget_nameLIKE${artifact_identifier}` +
      `^ORnameLIKE${artifact_identifier}`
    const stateQuery = `update_set.stateIN${stateFilter.join(",")}`
    const query = `${identQuery}^${stateQuery}^ORDERBYDESCsys_updated_on`

    const response = await client.get("/api/now/table/sys_update_xml", {
      params: {
        sysparm_query: query,
        sysparm_fields:
          "sys_id,name,type,target_name,action,sys_updated_on," +
          "update_set,update_set.name,update_set.state,update_set.description",
        sysparm_limit: safeLimit,
        sysparm_display_value: "all",
      },
    })

    const rows: any[] = response.data.result || []
    const hits: UpdateXmlHit[] = rows.map((r) => {
      const setRef = extractRef(r.update_set)
      const setName = extractRef(r["update_set.name"]).value || setRef.display || "(unknown)"
      const setState = extractRef(r["update_set.state"]).value || "unknown"
      const setDescription = extractRef(r["update_set.description"]).value || null
      return {
        sys_id: extractRef(r.sys_id).value,
        update_xml_name: extractRef(r.name).value,
        type: extractRef(r.type).display || null,
        target_name: extractRef(r.target_name).value || null,
        action: extractRef(r.action).display || null,
        set_sys_id: setRef.value,
        set_name: setName,
        set_state: setState,
        set_description: setDescription,
        last_updated: extractRef(r.sys_updated_on).value || null,
      }
    })

    const byState: Record<string, number> = {}
    const bySet: Record<string, { count: number; state: string; sys_id: string }> = {}
    for (const h of hits) {
      byState[h.set_state] = (byState[h.set_state] || 0) + 1
      const existing = bySet[h.set_name]
      if (existing) existing.count += 1
      else bySet[h.set_name] = { count: 1, state: h.set_state, sys_id: h.set_sys_id }
    }

    const inProgressCount = byState["in_progress"] || 0
    const impactWarning =
      inProgressCount > 0
        ? `${inProgressCount} reference${inProgressCount === 1 ? "" : "s"} found in in_progress update set${inProgressCount === 1 ? "" : "s"}. Deleting "${artifact_identifier}" before those sets are loaded will leave broken XML payloads that fail to commit. Review the in_progress sets first.`
        : null

    const result = {
      artifact_identifier,
      updates: hits,
      summary: {
        total_hits: hits.length,
        by_state: byState,
        by_set: bySet,
        states_searched: stateFilter,
        truncated: hits.length === safeLimit,
      },
      impact_warning: impactWarning,
      scope_caveat:
        "LIKE-matched across payload + name + target_name. False positives are possible (e.g. the name appearing in a comment or unrelated identifier). For low hit counts, manually inspect the XML payload to confirm.",
    }

    const summary = [
      `"${artifact_identifier}" appears in ${hits.length}${hits.length === safeLimit ? "+" : ""} update XML record${hits.length === 1 ? "" : "s"}`,
      ` across ${Object.keys(bySet).length} update set${Object.keys(bySet).length === 1 ? "" : "s"}`,
      inProgressCount > 0 ? ` (${inProgressCount} in_progress ⚠️)` : "",
      `. Searched in ${((Date.now() - t0) / 1000).toFixed(1)}s.`,
    ].join("")

    return createSuccessResult(
      result,
      { apiCalls: 1, durationMs: Date.now() - t0 },
      summary,
    )
  } catch (error: any) {
    return createErrorResult(error.message || String(error))
  }
}

export const version = "1.0.0"
export const author = "Serac Blast Radius"
