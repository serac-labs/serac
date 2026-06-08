/**
 * snow_code_search - Search across script-bearing ServiceNow tables
 *
 * Runs parallel LIKE queries over ~25 tables where ServiceNow stores scripts
 * (business rules, script includes, client scripts, UI scripts, widgets,
 * scripted REST ops, UI actions, ACLs, scheduled jobs, transform maps,
 * notifications, record producers, UX scripts, etc.) and returns
 * grouped matches.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

interface CodeTable {
  table: string
  label: string
  fields: string[]
  metaFields: string[]
}

const CODE_TABLES: CodeTable[] = [
  { table: "sys_script", label: "Business rules", fields: ["script", "condition"], metaFields: ["name", "collection", "when", "active"] },
  { table: "sys_script_include", label: "Script includes", fields: ["script"], metaFields: ["name", "api_name", "active"] },
  { table: "sys_script_fix", label: "Fix scripts", fields: ["script"], metaFields: ["name", "active"] },
  { table: "sys_script_client", label: "Client scripts", fields: ["script"], metaFields: ["name", "table", "type", "field_name", "active"] },
  { table: "sys_ui_script", label: "UI scripts", fields: ["script"], metaFields: ["name", "active", "global"] },
  { table: "sysauto_script", label: "Scheduled jobs", fields: ["script"], metaFields: ["name", "active", "run_type"] },
  { table: "sys_transform_script", label: "Transform scripts", fields: ["script"], metaFields: ["name", "map.name", "when", "order"] },
  { table: "sys_transform_map", label: "Transform maps", fields: ["run_script"], metaFields: ["name", "source_table", "target_table", "active"] },
  { table: "sys_ws_operation", label: "Scripted REST operations", fields: ["operation_script"], metaFields: ["name", "web_service_definition.name", "http_method", "active"] },
  { table: "sys_processor", label: "Processors", fields: ["script"], metaFields: ["name", "type", "path", "active"] },
  { table: "sys_ui_action", label: "UI actions", fields: ["script", "condition"], metaFields: ["name", "table", "action_name", "active"] },
  { table: "sys_security_acl", label: "ACLs", fields: ["script", "condition"], metaFields: ["name", "operation", "type", "active"] },
  { table: "sysevent_script_action", label: "Event script actions", fields: ["script"], metaFields: ["name", "event_name", "active"] },
  { table: "sp_widget", label: "Service Portal widgets", fields: ["script", "client_script", "link", "controller_as"], metaFields: ["name", "id", "active"] },
  { table: "sc_cat_item_producer", label: "Record producers", fields: ["script"], metaFields: ["name", "table_name", "active"] },
  { table: "sys_ux_client_script", label: "UX (UI Builder) client scripts", fields: ["script"], metaFields: ["name", "macroponent.name", "active"] },
  { table: "sysevent_email_action", label: "Notifications", fields: ["condition", "advanced_condition"], metaFields: ["name", "collection", "active"] },
  { table: "sysevent_in_email_action", label: "Inbound email actions", fields: ["script"], metaFields: ["name", "type", "active", "order"] },
  { table: "sys_flow_script_plugin_value", label: "Flow designer scripts", fields: ["value"], metaFields: ["sys_metadata.name"] },
]

export const toolDefinition: MCPToolDefinition = {
  name: "snow_code_search",
  description:
    "Search for a term across every ServiceNow table that stores scripts (business rules, script includes, client scripts, UI scripts, widgets, scripted REST operations, UI actions, ACLs, scheduled jobs, transform maps, notifications, record producers, UX/UI-Builder scripts, etc.). Returns grouped matches per table with a short context snippet. Use when you need to find where a function, table name, or pattern is referenced across the instance.",
  category: "development",
  subcategory: "search",
  use_cases: ["code-search", "refactoring", "impact-analysis", "dependency-tracing"],
  complexity: "beginner",
  frequency: "high",
  permission: "read",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Substring to search for (case-insensitive, ServiceNow LIKE operator).",
      },
      tables: {
        type: "array",
        items: { type: "string" },
        description: "Optional whitelist of table names to search. Default: all supported script-bearing tables.",
      },
      active_only: {
        type: "boolean",
        description: "Only search active records where the 'active' field is present. Default: true.",
        default: true,
      },
      per_table_limit: {
        type: "number",
        description: "Max matches returned per table. Default: 25, max: 100.",
        default: 25,
      },
      context_window: {
        type: "number",
        description: "Characters of context around each match in the snippet. Default: 120.",
        default: 120,
      },
    },
    required: ["query"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const query = args.query as string
  const whitelist = args.tables as string[] | undefined
  const activeOnly = args.active_only !== false
  const perTableLimit = Math.min((args.per_table_limit as number) || 25, 100)
  const ctxWindow = (args.context_window as number) || 120

  if (!query || query.trim() === "") return createErrorResult("'query' must be a non-empty string")

  const targets = whitelist
    ? CODE_TABLES.filter((t) => whitelist.includes(t.table))
    : CODE_TABLES

  if (targets.length === 0) {
    return createErrorResult(
      `None of the requested tables are supported. Supported: ${CODE_TABLES.map((t) => t.table).join(", ")}`,
    )
  }

  const client = await getAuthenticatedClient(context)
  const escaped = encodeURIComponent(query)
  const needle = query.toLowerCase()

  const results = await Promise.all(
    targets.map((spec) => {
      const orClause = spec.fields.map((f, i) => (i === 0 ? `${f}LIKE${escaped}` : `^OR${f}LIKE${escaped}`)).join("")
      const activeClause = activeOnly && spec.metaFields.includes("active") ? "^active=true" : ""
      const fieldsList = [...spec.fields, ...spec.metaFields, "sys_id", "sys_updated_on", "sys_updated_by"].join(",")

      return client
        .get(`/api/now/table/${spec.table}`, {
          params: {
            sysparm_query: `${orClause}${activeClause}`,
            sysparm_fields: fieldsList,
            sysparm_display_value: "true",
            sysparm_limit: perTableLimit,
          },
        })
        .then((r: { data: { result?: Array<Record<string, string>> } }) => {
          const rows = r.data?.result ?? []
          const matches = rows.map((row) => snippet(row, spec, needle, ctxWindow))
          return { table: spec.table, label: spec.label, count: matches.length, matches }
        })
        .catch((err: { response?: { status?: number }; message?: string }) => ({
          table: spec.table,
          label: spec.label,
          count: 0,
          matches: [],
          error: err.response?.status === 404 ? "table not present on instance" : err.message || "query failed",
        }))
    }),
  )

  const groups = results.filter((g) => g.count > 0 || ("error" in g && g.error !== "table not present on instance"))
  const totalMatches = groups.reduce((acc, g) => acc + g.count, 0)
  const tablesSearched = results.length
  const tablesWithMatches = results.filter((g) => g.count > 0).length

  const summary = [
    `Code search: "${query}"`,
    `  Tables searched: ${tablesSearched}`,
    `  Tables with matches: ${tablesWithMatches}`,
    `  Total matches: ${totalMatches}`,
  ].join("\n")

  return createSuccessResult(
    { query, groups, total_matches: totalMatches, tables_searched: tablesSearched },
    { tables_with_matches: tablesWithMatches },
    summary,
  )
}

function snippet(row: Record<string, string>, spec: CodeTable, needle: string, ctxWindow: number) {
  const hits: Array<{ field: string; snippet: string; offset: number }> = []
  for (const field of spec.fields) {
    const value = row[field]
    if (!value || typeof value !== "string") continue
    const lower = value.toLowerCase()
    const index = lower.indexOf(needle)
    if (index < 0) continue
    const start = Math.max(0, index - Math.floor(ctxWindow / 2))
    const end = Math.min(value.length, index + needle.length + Math.floor(ctxWindow / 2))
    const prefix = start > 0 ? "…" : ""
    const suffix = end < value.length ? "…" : ""
    hits.push({
      field,
      snippet: prefix + value.slice(start, end) + suffix,
      offset: index,
    })
  }

  const meta: Record<string, string> = {}
  for (const field of spec.metaFields) {
    if (row[field] !== undefined) meta[field] = row[field]
  }

  return {
    sys_id: row.sys_id,
    updated_on: row.sys_updated_on,
    updated_by: row.sys_updated_by,
    meta,
    hits,
  }
}

export const version = "1.0.0"
export const author = "Serac SDK"
