/**
 * snow_blast_radius_sys_properties - Find an artifact's name in plain-string sys_property values
 *
 * Plain-string property values are out-of-scope for the regular
 * blast-radius scan, which only reads columns ServiceNow marks as
 * script-typed. Yet a lot of deployments hardcode artifact names —
 * script-include class names, table names, user/role names, scope
 * prefixes — into property values that production code reads via
 * gs.getProperty('...'). Rename or delete the artifact without
 * updating the property and the next gs.getProperty() call hands back
 * a stale string that callers will silently mis-route.
 *
 * Strategy: LIKE-search sys_property.value for the identifier, then
 * word-boundary post-filter so "state" doesn't flag every property
 * that mentions "active". Properties are typically a small table
 * (<5k rows on a vanilla instance, <50k in heavy custom deployments)
 * so a full-text scan is cheap.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_blast_radius_sys_properties",
  description: `Search sys_property records for plain-string references to an artifact name. Closes a recurring blind spot of snow_blast_radius_dependents: property values are NOT script-typed columns, so they're invisible to the script-bearing scan even though gs.getProperty() reads them at runtime.

Call this together with snow_blast_radius_dependents when:
- Deleting or renaming a script include / business rule / widget / scheduled job / table
- Renaming a field name that may be referenced in property-driven dynamic queries
- Checking whether a role or user name is hardcoded in a config flag

Returns:
- properties[] — each match with name, value preview, description, last_updated, scope, category
- summary — total hits + counts by detected category (platform, scoped_app, plugin, custom)
- impact_warning — non-null when matches exist, with a reminder to update them alongside the rename/delete

Caveat: LIKE-matched then word-boundary regex confirmed. False positives are possible if the name occurs as a literal substring in unrelated property text. For low hit counts: inspect the value previews.`,
  category: "blast-radius",
  subcategory: "dependency-analysis",
  use_cases: [
    "impact-analysis",
    "refactoring",
    "safe-delete-check",
    "property-audit",
    "config-flag-discovery",
  ],
  complexity: "beginner",
  frequency: "medium",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      artifact_identifier: {
        type: "string",
        description:
          "Name to search for in sys_property values (e.g. 'IncidentUtils', 'x_acme_workflow', 'assignment_group').",
      },
      limit: {
        type: "number",
        description: "Maximum properties to return (default: 100).",
        default: 100,
      },
    },
    required: ["artifact_identifier"],
  },
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Cheap category-from-name detection. Most ServiceNow property names
 * follow a convention prefix and the prefix tells you whether a hit
 * is a platform tuneable (rare to want to touch), a scoped app config
 * (likely customer-owned), a plugin setting (vendor-owned), or a free-
 * form custom property (most common cause of hardcoded references).
 */
function detectCategory(name: string): "platform" | "scoped_app" | "plugin" | "custom" {
  if (!name) return "custom"
  if (name.startsWith("glide.")) return "platform"
  if (/^x_[a-z0-9_]+\./.test(name)) return "scoped_app"
  if (name.startsWith("com.") || name.startsWith("sn_")) return "plugin"
  return "custom"
}

function asString(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  if (typeof v === "object") {
    const o = v as { value?: unknown; display_value?: unknown }
    if (typeof o.value === "string") return o.value
    if (typeof o.display_value === "string") return o.display_value
  }
  return String(v)
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { artifact_identifier, limit = 100 } = args
  if (!artifact_identifier || typeof artifact_identifier !== "string") {
    return createErrorResult("artifact_identifier is required (non-empty string)")
  }
  const safeLimit = Math.max(10, Math.min(Number(limit) || 100, 500))

  const t0 = Date.now()
  const fieldRe = new RegExp(`\\b${escapeRegex(artifact_identifier)}\\b`, "i")

  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.get("/api/now/table/sys_properties", {
      params: {
        sysparm_query: `valueLIKE${artifact_identifier}^ORDERBYname`,
        sysparm_fields:
          "sys_id,name,value,description,sys_updated_on,sys_scope,is_private,read_roles,write_roles",
        sysparm_limit: safeLimit,
        sysparm_display_value: "all",
      },
    })

    const rows: any[] = response.data?.result || []
    const properties = rows
      .filter((r) => fieldRe.test(asString(r.value)))
      .map((r) => {
        const name = asString(r.name)
        const value = asString(r.value)
        return {
          sys_id: asString(r.sys_id),
          name,
          value_preview: value.length > 200 ? value.slice(0, 200) + "…" : value,
          description: asString(r.description) || null,
          scope: asString(r.sys_scope) || null,
          last_updated: asString(r.sys_updated_on) || null,
          is_private: asString(r.is_private) === "true",
          category: detectCategory(name),
        }
      })

    const byCategory: Record<string, number> = {}
    for (const p of properties) {
      byCategory[p.category] = (byCategory[p.category] || 0) + 1
    }

    const impactWarning =
      properties.length > 0
        ? `${properties.length} system propert${properties.length === 1 ? "y" : "ies"} reference "${artifact_identifier}". Every gs.getProperty() reading these will return the stale value after a rename or delete — update them in the same change.`
        : null

    const result = {
      artifact_identifier,
      properties,
      summary: {
        total_hits: properties.length,
        by_category: byCategory,
        truncated: rows.length === safeLimit,
      },
      impact_warning: impactWarning,
      scope_caveat:
        "LIKE-matched against sys_property.value with word-boundary regex confirm. False positives possible when the name appears as a literal substring in unrelated property text.",
    }

    const summary = [
      `"${artifact_identifier}" appears in ${properties.length} system propert${properties.length === 1 ? "y" : "ies"}`,
      result.summary.truncated ? "+ (truncated)" : "",
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
