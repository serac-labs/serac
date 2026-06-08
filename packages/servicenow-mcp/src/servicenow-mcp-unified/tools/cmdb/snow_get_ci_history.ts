/**
 * snow_get_ci_history - CI change history
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_ci_history",
  description: "Get Configuration Item change history",
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "audit",
  use_cases: ["cmdb", "audit", "history"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      ci_sys_id: { type: "string" },
      days_back: { type: "number", default: 30 },
    },
    required: ["ci_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { ci_sys_id, days_back = 30 } = args
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.get("/api/now/table/sys_audit", {
      params: {
        sysparm_query: `documentkey=${ci_sys_id}^sys_created_on>=javascript:gs.daysAgo(${days_back})`,
        sysparm_limit: 1000,
      },
    })
    return createSuccessResult({ history: response.data.result, days_back })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
