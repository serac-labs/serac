/**
 * snow_reconcile_ci - CMDB reconciliation
 *
 * DEPRECATED: this does not run reconciliation. The executor below PUTs the
 * caller's source_data onto base cmdb_ci for one sys_id and echoes the
 * reconciliation_rule argument straight back as `rule` — no identifier rule, no
 * reconciliation rule, no Source [sys_object_source] row, and class-specific
 * columns are dropped because the write targets cmdb_ci rather than the CI's
 * own class table. Use snow_cmdb_identify_reconcile, which posts to
 * /api/now/identifyreconcile and lets the Identification and Reconciliation
 * Engine decide the operation.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_reconcile_ci",
  description:
    "[DEPRECATED - use snow_cmdb_identify_reconcile] Does not reconcile. PUTs the given fields onto base cmdb_ci for one sys_id and echoes reconciliation_rule back untouched — no identifier or reconciliation rule runs, no Source [sys_object_source] row is written, and class-specific fields are dropped. Use snow_cmdb_identify_reconcile instead, which posts the payload to the Identification and Reconciliation Engine. Kept only for callers that already depend on this plain cmdb_ci update.",
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "reconciliation",
  use_cases: ["cmdb", "reconciliation", "data-quality"],
  complexity: "advanced",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Reconciliation function - updates CI records
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      ci_sys_id: { type: "string", description: "CI to reconcile" },
      source_data: { type: "object", description: "Source data to reconcile" },
      reconciliation_rule: { type: "string", description: "Reconciliation rule", default: "merge" },
    },
    required: ["ci_sys_id", "source_data"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { ci_sys_id, source_data, reconciliation_rule = "merge" } = args
  try {
    const client = await getAuthenticatedClient(context)
    // Simplified reconciliation - merge source data
    const response = await client.put(`/api/now/table/cmdb_ci/${ci_sys_id}`, source_data)
    return createSuccessResult({ reconciled: true, ci: response.data.result, rule: reconciliation_rule })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
