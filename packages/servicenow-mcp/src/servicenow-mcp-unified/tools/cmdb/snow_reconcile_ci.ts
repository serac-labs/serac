/**
 * snow_reconcile_ci - CMDB reconciliation
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_reconcile_ci",
  description: "Reconcile CI data from multiple sources",
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
