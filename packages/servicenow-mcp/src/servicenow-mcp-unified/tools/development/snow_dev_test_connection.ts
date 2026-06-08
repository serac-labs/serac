/**
 * snow_dev_test_connection - Developer-only test tool for ServiceNow connections
 *
 * Quick verification of OAuth credentials and table/column accessibility
 * against a live instance. Used during tool development to validate
 * assumptions (table existence, field names, query shape) before shipping
 * production tools — particularly for confirming or correcting the
 * `// TODO: verify against live instance` markers in newly-added tools.
 *
 * Production exposure: name prefix `snow_dev_*` and category `development`
 * mark this as developer-only. The portal's CATEGORY_FEATURES mapping in
 * serac-platform should exclude `development` from BASE features so this
 * tool does not appear in production instance-chat surfaces.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_dev_test_connection",
  description: `Developer-only tool for testing ServiceNow connections, OAuth credentials, and table/column accessibility against a live instance. Use during tool development to validate assumptions (table existence, field names, query shape) before shipping production tools.

Actions:
- oauth — test arbitrary OAuth credentials (instance + grant_type + client_id + secret, optional username/password for password grant). Returns redacted token info on success.
- connection — verify the current authenticated context is healthy via a sys_user lookup.
- table — verify a table exists and is accessible (sys_db_object lookup). Returns table label, parent class, and scope.
- columns — list a table's column definitions from sys_dictionary. Critical for validating field-name TODOs in newly-built tools. Optional fields filter to limit response size.
- query — dry-run an encoded query against a table with limit=1 to confirm result shape.

Use when: building new tools that target unfamiliar tables, validating TODO-marked column names from recent PRs, sanity-checking OAuth setup on a new instance, or troubleshooting "tool returns 404" errors. Companion to snow_test_connection (production smoke test) and snow_validate_live_connection — this is the developer-time variant with finer-grained verification actions.`,
  category: "development",
  subcategory: "testing",
  use_cases: [
    "development",
    "testing",
    "oauth-debugging",
    "schema-verification",
    "tool-validation",
    "column-name-verification",
  ],
  complexity: "intermediate",
  frequency: "low",

  // READ-only across all actions. The oauth action does NOT use the
  // context's authenticated client — it tests caller-supplied credentials
  // via a raw token endpoint call.
  permission: "read",
  allowedRoles: ["developer", "admin"],

  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Test action to perform",
        enum: ["oauth", "connection", "table", "columns", "query"],
      },
      // OAuth action params (do NOT use context auth — test arbitrary credentials)
      instance_url: {
        type: "string",
        description: "[oauth] Instance hostname or URL (e.g. dev380262.service-now.com or https://dev380262.service-now.com)",
      },
      grant_type: {
        type: "string",
        enum: ["client_credentials", "password"],
        default: "client_credentials",
        description: "[oauth] OAuth grant type. password requires username + password.",
      },
      client_id: {
        type: "string",
        description: "[oauth] OAuth client_id from System OAuth > Application Registry",
      },
      client_secret: {
        type: "string",
        description: "[oauth] OAuth client_secret",
      },
      username: {
        type: "string",
        description: "[oauth/password grant] Username of the service account",
      },
      password: {
        type: "string",
        description: "[oauth/password grant] Password of the service account",
      },
      // Table/columns/query params (use context auth)
      table: {
        type: "string",
        description: "[table/columns/query] Target table name (e.g. pa_indicators, sn_si_incident, wm_order)",
      },
      sysparm_query: {
        type: "string",
        description: "[query] Encoded query string (e.g. active=true^state=1)",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "[query/columns] Optional field name list to limit response size or scope the columns query",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, any>, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args
  try {
    switch (action) {
      case "oauth":
        return await testOAuth(args)
      case "connection":
        return await testConnection(context)
      case "table":
        return await verifyTable(args, context)
      case "columns":
        return await listColumns(args, context)
      case "query":
        return await dryRunQuery(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: oauth, connection, table, columns, query`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, err.message, { originalError: err }),
    )
  }
}

// ==================== OAUTH ====================
// Tests arbitrary OAuth credentials by hitting the instance's token endpoint
// directly. Bypasses getAuthenticatedClient because we are validating the
// caller-supplied credentials, not using the context's existing ones.
async function testOAuth(args: Record<string, any>): Promise<ToolResult> {
  const {
    instance_url,
    grant_type = "client_credentials",
    client_id,
    client_secret,
    username,
    password,
  } = args

  if (!instance_url || !client_id || !client_secret) {
    return createErrorResult("oauth action requires instance_url, client_id, client_secret")
  }
  if (grant_type === "password" && (!username || !password)) {
    return createErrorResult("password grant requires username and password")
  }

  const baseUrl = instance_url.startsWith("http") ? instance_url : `https://${instance_url}`
  const tokenUrl = `${baseUrl.replace(/\/$/, "")}/oauth_token.do`

  const body = new URLSearchParams()
  body.set("grant_type", grant_type)
  body.set("client_id", client_id)
  body.set("client_secret", client_secret)
  if (grant_type === "password") {
    body.set("username", username)
    body.set("password", password)
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })

  const data: any = await response.json().catch(() => ({}))

  if (!response.ok || !data.access_token) {
    return createErrorResult(
      `OAuth ${grant_type} failed (HTTP ${response.status}): ${data.error || "unknown_error"} — ${data.error_description || "no description in response"}`,
    )
  }

  return createSuccessResult({
    success: true,
    instance: baseUrl,
    grant_type,
    token_type: data.token_type || "Bearer",
    expires_in: data.expires_in,
    scope: data.scope,
    token_length: String(data.access_token).length,
    // Never return the actual token — redact for safety.
    access_token: "<redacted>",
    refresh_token: data.refresh_token ? "<redacted>" : undefined,
  })
}

// ==================== CONNECTION ====================
async function testConnection(context: ServiceNowContext): Promise<ToolResult> {
  const client = await getAuthenticatedClient(context)
  const response = await client.get("/api/now/table/sys_user", {
    params: { sysparm_limit: 1, sysparm_fields: "sys_id,user_name,name" },
  })
  const result = response?.data?.result
  const sample = Array.isArray(result) && result[0]
    ? { sys_id: result[0].sys_id, user_name: result[0].user_name, name: result[0].name }
    : null
  return createSuccessResult({
    connected: true,
    instance: context.instanceUrl,
    sample_user: sample,
  })
}

// ==================== TABLE ====================
async function verifyTable(args: Record<string, any>, context: ServiceNowContext): Promise<ToolResult> {
  const { table } = args
  if (!table) return createErrorResult("table action requires `table` parameter")

  const client = await getAuthenticatedClient(context)
  const response = await client.get("/api/now/table/sys_db_object", {
    params: {
      sysparm_query: `name=${table}`,
      sysparm_fields: "name,label,super_class,sys_scope,sys_class_name",
      sysparm_exclude_reference_link: "true",
      sysparm_limit: 1,
    },
  })
  const row = response?.data?.result?.[0]
  if (!row) {
    return createErrorResult(
      `Table not found: ${table}. May not exist on this instance, or the required plugin is not active.`,
    )
  }
  return createSuccessResult({
    exists: true,
    table: row.name,
    label: row.label,
    parent: extractValue(row.super_class),
    scope: extractValue(row.sys_scope),
    sys_class_name: row.sys_class_name,
  })
}

// ==================== COLUMNS ====================
async function listColumns(args: Record<string, any>, context: ServiceNowContext): Promise<ToolResult> {
  const { table, fields } = args
  if (!table) return createErrorResult("columns action requires `table` parameter")

  const client = await getAuthenticatedClient(context)
  const fieldFilter = Array.isArray(fields) && fields.length > 0 ? `^elementIN${fields.join(",")}` : ""
  const response = await client.get("/api/now/table/sys_dictionary", {
    params: {
      sysparm_query: `name=${table}^element!=NULL${fieldFilter}`,
      sysparm_fields: "element,internal_type,column_label,reference,max_length,mandatory,read_only",
      sysparm_exclude_reference_link: "true",
      sysparm_limit: 200,
    },
  })

  const rows = response?.data?.result || []
  const columns = rows.map((r: any) => ({
    element: r.element,
    type: extractValue(r.internal_type),
    label: r.column_label,
    reference: r.reference || null,
    max_length: r.max_length || null,
    mandatory: r.mandatory === "true",
    read_only: r.read_only === "true",
  }))

  return createSuccessResult({
    table,
    column_count: columns.length,
    columns,
  })
}

// ==================== QUERY ====================
async function dryRunQuery(args: Record<string, any>, context: ServiceNowContext): Promise<ToolResult> {
  const { table, sysparm_query, fields } = args
  if (!table) return createErrorResult("query action requires `table` parameter")

  const client = await getAuthenticatedClient(context)
  const params: Record<string, any> = {
    sysparm_limit: 1,
    sysparm_exclude_reference_link: "true",
  }
  if (sysparm_query) params.sysparm_query = sysparm_query
  if (Array.isArray(fields) && fields.length > 0) params.sysparm_fields = fields.join(",")

  const response = await client.get(`/api/now/table/${table}`, { params })
  const result = response?.data?.result || []
  return createSuccessResult({
    table,
    query: sysparm_query || "(none)",
    row_count: result.length,
    sample_row: result[0] || null,
  })
}

// Some sys_dictionary / sys_db_object fields come back as either a plain
// string or a {value, display_value} object depending on instance version.
// This normalises both shapes.
function extractValue(v: unknown): string | null {
  if (v == null || v === "") return null
  if (typeof v === "string") return v
  if (typeof v === "object" && v !== null && "value" in v) {
    const val = (v as { value: unknown }).value
    return typeof val === "string" ? val : null
  }
  return null
}

export const version = "1.0.0"
export const author = "groeimetai"
