/**
 * snow_analyze_form - Analyze everything that affects a table's form
 *
 * For the given table, returns active UI policies, client scripts,
 * data policies, ACLs (table + field level) and UI actions. Helps
 * answer "why does this form behave this way?" in one call.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_analyze_form",
  description:
    "Analyze everything that affects a ServiceNow form for a given table: active UI policies, client scripts, data policies, record + field ACLs, and UI actions. Useful when debugging 'why does this form behave this way?' — consolidates 5+ queries into one structured report.",
  category: "forms",
  subcategory: "analysis",
  use_cases: ["debugging", "forms", "acls", "ui-policies", "client-scripts"],
  complexity: "beginner",
  frequency: "medium",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Table name (e.g. 'incident', 'change_request', 'sc_req_item')",
      },
      include_inactive: {
        type: "boolean",
        description: "Include inactive policies/scripts/ACLs. Default: false.",
        default: false,
      },
    },
    required: ["table"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const table = args.table as string
  const includeInactive = args.include_inactive === true

  if (!table) return createErrorResult("Missing 'table' argument")

  const client = await getAuthenticatedClient(context)

  const active = includeInactive ? "" : "^active=true"

  const queries = {
    ui_policies: {
      table: "sys_ui_policy",
      query: `table=${table}${active}`,
      fields: "sys_id,short_description,conditions,active,order,global,on_load,reverse_if_false,sys_updated_on,sys_updated_by",
    },
    client_scripts: {
      table: "sys_script_client",
      query: `table=${table}${active}`,
      fields: "sys_id,name,type,field_name,active,global,ui_type,applies_extended,order,sys_updated_on,sys_updated_by",
    },
    data_policies: {
      table: "sys_data_policy2",
      query: `table=${table}${active}`,
      fields: "sys_id,short_description,conditions,active,apply_import_set,apply_soap,sys_updated_on,sys_updated_by",
    },
    acls_record: {
      table: "sys_security_acl",
      query: `name=${table}${active}`,
      fields: "sys_id,name,operation,type,condition,script,active,admin_overrides,sys_updated_on",
    },
    acls_field: {
      table: "sys_security_acl",
      query: `nameSTARTSWITH${table}.${active}`,
      fields: "sys_id,name,operation,type,condition,script,active,admin_overrides,sys_updated_on",
    },
    ui_actions: {
      table: "sys_ui_action",
      query: `table=${table}${active}`,
      fields: "sys_id,name,action_name,form_button,form_link,list_button,active,order,show_insert,show_update,condition,sys_updated_on",
    },
  }

  const entries = Object.entries(queries)

  const results = await Promise.all(
    entries.map(([key, spec]) =>
      client
        .get(`/api/now/table/${spec.table}`, {
          params: {
            sysparm_query: spec.query,
            sysparm_fields: spec.fields,
            sysparm_display_value: "all",
            sysparm_limit: 500,
          },
        })
        .then((r: { data: { result?: Array<Record<string, unknown>> } }) => ({ key, rows: r.data?.result ?? [] }))
        .catch((err: { message?: string }) => ({ key, rows: [], error: err.message || "query failed" })),
    ),
  )

  const bucket: Record<string, unknown> = { table }
  const counts: Record<string, number> = {}
  const errors: Record<string, string> = {}

  for (const entry of results) {
    bucket[entry.key] = entry.rows
    counts[entry.key] = entry.rows.length
    if ("error" in entry && entry.error) errors[entry.key] = entry.error
  }

  const hasAnyError = Object.keys(errors).length > 0

  const summary = [
    `Form analysis for table: ${table}${includeInactive ? " (incl. inactive)" : ""}`,
    `  UI policies:     ${counts.ui_policies ?? 0}`,
    `  Client scripts:  ${counts.client_scripts ?? 0}`,
    `  Data policies:   ${counts.data_policies ?? 0}`,
    `  ACLs (record):   ${counts.acls_record ?? 0}`,
    `  ACLs (field):    ${counts.acls_field ?? 0}`,
    `  UI actions:      ${counts.ui_actions ?? 0}`,
    hasAnyError ? `  ⚠ ${Object.keys(errors).length} queries failed — see metadata.errors` : "",
  ]
    .filter(Boolean)
    .join("\n")

  return createSuccessResult(bucket, { counts, errors: hasAnyError ? errors : undefined }, summary)
}

export const version = "1.0.0"
export const author = "Serac SDK"
