/**
 * snow_blast_radius_table_configs - Find all configurations on a table
 *
 * For a given table, returns every artifact scoped to it across the
 * instance. Uses the central ARTIFACT_SPECS catalog so coverage matches
 * `snow_blast_radius_field_references` — every artifact type we know
 * about is queried (plugin-gated ones fail silently via allSettled).
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import {
  ARTIFACT_SPECS,
  type ArtifactSearchSpec,
  ARTIFACT_TYPE_NAMES,
  TABLE_CONFIG_TYPES,
} from "./shared/metadata-tables.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_blast_radius_table_configs",
  description: `Find every configuration running on a specific table. Use to inventory artifacts scoped to a table, understand the configuration landscape before making changes, or filter by config type, scope, or active status.

Example: "What configs run on the incident table?"

Coverage: by default searches a curated set of 13 main config types — business rules, client scripts, UI actions, UI policies (+ actions), data policies (+ rules), ACLs, email notifications, metric definitions, inbound email actions, transform entries, plus global-but-table-mentioning script includes. Pass an explicit \`config_types\` array to query any of the 26 supported types from ARTIFACT_SPECS.

Parent tables are walked via sys_db_object.super_class (opt-out).`,
  category: "blast-radius",
  subcategory: "table-analysis",
  use_cases: ["impact-analysis", "table-audit", "governance"],
  complexity: "intermediate",
  frequency: "high",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table_name: {
        type: "string",
        description: "Table name (e.g., 'incident', 'change_request')",
      },
      config_types: {
        type: "array",
        items: {
          type: "string",
          enum: ARTIFACT_TYPE_NAMES,
        },
        description: "Filter to specific artifact types. Default: a curated set of 13 main config types (TABLE_CONFIG_TYPES); pass an explicit list to access any of the 26 supported types.",
      },
      include_inactive: {
        type: "boolean",
        description: "Include inactive configurations (default: false)",
        default: false,
      },
      include_scripts: {
        type: "boolean",
        description: "Include script bodies in results (larger payload, default: false)",
        default: false,
      },
      include_parent_tables: {
        type: "boolean",
        description: "Walk sys_db_object.super_class to include parent-table artifacts. Default: true.",
        default: true,
      },
      scope: {
        type: "string",
        description: "Filter by application scope sys_id",
      },
      limit_per_type: {
        type: "number",
        description: "Maximum configs per type (default: 50)",
        default: 50,
      },
    },
    required: ["table_name"],
  },
}

async function resolveTableChain(client: any, table: string, maxDepth = 3): Promise<string[]> {
  const chain: string[] = [table]
  let current = table
  for (let i = 0; i < maxDepth; i++) {
    try {
      const res = await client.get("/api/now/table/sys_db_object", {
        params: {
          sysparm_query: `name=${current}`,
          sysparm_fields: "super_class.name",
          sysparm_limit: 1,
        },
      })
      const row = res.data.result?.[0]
      const parent = row?.["super_class.name"] || row?.super_class?.name
      if (!parent || parent === "" || chain.includes(parent)) break
      chain.push(parent)
      current = parent
    } catch {
      break
    }
  }
  return chain
}

/**
 * Build scope-only clause for table_configs (no field filter).
 * Returns "" for global artifacts — those need a script-LIKE table hint instead.
 */
function buildTableClause(spec: ArtifactSearchSpec, tables: string[]): string {
  const s = spec.scope
  if (s.kind === "tableField") {
    const parts = tables.map((t) => `${s.field}=${t}`)
    return parts.join("^OR")
  }
  if (s.kind === "dotwalk") {
    const parts = tables.map((t) => s.query(t))
    return parts.join("^OR")
  }
  if (s.kind === "aclName") {
    const parts: string[] = []
    for (const t of tables) {
      parts.push(`nameLIKE${t}.`)
      parts.push(`name=${t}`)
    }
    return parts.join("^OR")
  }
  return ""
}

function buildGlobalHint(spec: ArtifactSearchSpec, tables: string[]): string {
  if (spec.scope.kind !== "global") return ""
  const cols = spec.scriptFields
  if (cols.length === 0) return ""
  const parts: string[] = []
  for (const col of cols) {
    for (const t of tables) {
      parts.push(`${col}LIKE${t}`)
    }
  }
  return parts.join("^OR")
}

async function searchArtifactConfigs(
  client: any,
  spec: ArtifactSearchSpec,
  tables: string[],
  activeFilter: string,
  scopeFilter: string,
  includeScripts: boolean,
  limit: number,
) {
  try {
    const tableClause = buildTableClause(spec, tables)
    const globalHint = buildGlobalHint(spec, tables)

    // Skip types we cannot meaningfully scope (global spec with no script fields, e.g., ATF)
    if (!tableClause && !globalHint) {
      return { type: spec.type, records: [], total_count: 0, truncated: false, skipped: true }
    }

    const clauses: string[] = []
    if (tableClause) clauses.push(tableClause)
    if (globalHint && !tableClause) clauses.push(globalHint)
    if (activeFilter) clauses.push(activeFilter.replace(/^\^/, ""))
    if (scopeFilter) clauses.push(scopeFilter)

    const fields = includeScripts
      ? [spec.selectFields, ...spec.scriptFields].join(",")
      : spec.selectFields

    const response = await client.get(`/api/now/table/${spec.table}`, {
      params: {
        sysparm_query: clauses.join("^"),
        sysparm_fields: fields,
        sysparm_limit: limit,
        sysparm_count: "true",
        sysparm_display_value: "all",
      },
    })

    const records = response.data.result || []
    const totalCount = parseInt(
      response.headers["x-total-count"] || response.headers["X-Total-Count"] || String(records.length),
      10,
    )

    return {
      type: spec.type,
      records,
      total_count: totalCount,
      truncated: totalCount > records.length,
    }
  } catch (error: any) {
    return {
      type: spec.type,
      records: [],
      total_count: 0,
      truncated: false,
      error: error.message || String(error),
    }
  }
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    table_name,
    config_types,
    include_inactive = false,
    include_scripts = false,
    include_parent_tables = true,
    scope,
    limit_per_type = 50,
  } = args

  if (!table_name) {
    return createErrorResult("table_name is required")
  }

  try {
    const client = await getAuthenticatedClient(context)

    const tables = include_parent_tables ? await resolveTableChain(client, table_name) : [table_name]
    const activeFilter = include_inactive ? "" : "active=true"
    const scopeFilter = scope ? `sys_scope=${scope}` : ""

    // Default to TABLE_CONFIG_TYPES (the curated "main" set) unless the caller requested specific types.
    const defaultTypes = new Set<string>(TABLE_CONFIG_TYPES)
    const specs =
      config_types && config_types.length > 0
        ? ARTIFACT_SPECS.filter((s) => config_types.includes(s.type))
        : ARTIFACT_SPECS.filter((s) => defaultTypes.has(s.type))

    const results = await Promise.allSettled(
      specs.map((spec) =>
        searchArtifactConfigs(client, spec, tables, activeFilter, scopeFilter, include_scripts, limit_per_type),
      ),
    )

    const configurations: Record<string, any[]> = {}
    const byType: Record<string, number> = {}
    const truncatedTypes: string[] = []
    const erroredTypes: Record<string, string> = {}
    let totalConfigs = 0
    let activeCount = 0
    let inactiveCount = 0

    for (const result of results) {
      if (result.status !== "fulfilled") continue
      const r = result.value
      if ("skipped" in r) continue
      configurations[r.type] = r.records
      byType[r.type] = r.total_count
      totalConfigs += r.total_count
      if (r.truncated) truncatedTypes.push(r.type)
      if (r.error) erroredTypes[r.type] = r.error

      for (const record of r.records) {
        const active = record.active
        const activeVal = typeof active === "object" ? active?.value : active
        if (activeVal === "true" || activeVal === true) activeCount++
        else inactiveCount++
      }
    }

    // Field definitions for context
    let fields: any[] = []
    try {
      const dictResponse = await client.get("/api/now/table/sys_dictionary", {
        params: {
          sysparm_query: `name=${table_name}^elementISNOTEMPTY^ORDERBYelement`,
          sysparm_fields: "element,column_label,internal_type,mandatory",
          sysparm_limit: 250,
        },
      })
      fields = (dictResponse.data.result || []).map((f: any) => ({
        name: f.element,
        label: f.column_label,
        type: typeof f.internal_type === "object" ? f.internal_type.value : f.internal_type,
        mandatory: f.mandatory === "true" || f.mandatory === true,
      }))
    } catch {
      // non-critical
    }

    const resultData: Record<string, any> = {
      table: { name: table_name, parent_tables: tables.slice(1) },
      configurations,
      summary: {
        total_configurations: totalConfigs,
        by_type: byType,
        active_count: activeCount,
        inactive_count: inactiveCount,
      },
      searched_tables: tables,
      searched_artifact_types: specs.map((s) => s.type),
      truncated_types: truncatedTypes,
      fields,
    }

    if (Object.keys(erroredTypes).length > 0) {
      resultData.errors_by_type = erroredTypes
      resultData.note =
        "Some artifact types returned errors — typically because the relevant ServiceNow plugin is not activated."
    }

    const summaryParts = Object.entries(byType)
      .filter(([, count]) => count > 0)
      .map(([type, count]) => `${type}: ${count}`)

    const summary = `Table "${table_name}" has ${totalConfigs} configurations across ${specs.length} artifact types. ${summaryParts.join(", ")}`

    return createSuccessResult(resultData, { apiCalls: specs.length + 2 }, summary)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "2.0.0"
export const author = "Serac Blast Radius"
