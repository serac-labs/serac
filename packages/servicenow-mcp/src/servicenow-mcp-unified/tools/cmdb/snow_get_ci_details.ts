/**
 * snow_get_ci_details - Get detailed CI information including relationships
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_ci_details",
  description: "Retrieve Configuration Item details including relationships and history",
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "query",
  use_cases: ["cmdb", "query", "details"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      ci_id: { type: "string", description: "CI sys_id or name" },
      include_relationships: { type: "boolean", description: "Include CI relationships", default: true },
      include_history: { type: "boolean", description: "Include change history", default: false },
    },
    required: ["ci_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { ci_id, include_relationships = true, include_history = false } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Check if ci_id is a sys_id or name
    let query = ci_id.match(/^[a-f0-9]{32}$/) ? `sys_id=${ci_id}` : `name=${ci_id}`

    // Get CI details
    const ciResponse = await client.get(`/api/now/table/cmdb_ci?sysparm_query=${query}&sysparm_limit=1`)

    if (!ciResponse.data.result || ciResponse.data.result.length === 0) {
      return createErrorResult("CI not found")
    }

    const ci = ciResponse.data.result[0]
    const result: any = { ci }

    // Get relationships if requested
    if (include_relationships) {
      const relQuery = `parent=${ci.sys_id}^ORchild=${ci.sys_id}`
      const relResponse = await client.get(`/api/now/table/cmdb_rel_ci?sysparm_query=${relQuery}&sysparm_limit=50`)
      result.relationships = relResponse.data.result || []
    }

    // Get history if requested
    if (include_history) {
      const historyResponse = await client.get(
        `/api/now/table/sys_audit?sysparm_query=tablename=cmdb_ci^documentkey=${ci.sys_id}&sysparm_limit=20&sysparm_order_by=^ORDERBYDESCsys_created_on`,
      )
      result.history = historyResponse.data.result || []
    }

    return createSuccessResult(result)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
