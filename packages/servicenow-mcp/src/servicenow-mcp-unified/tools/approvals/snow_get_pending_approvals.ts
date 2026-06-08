/**
 * snow_get_pending_approvals
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_pending_approvals",
  description: "Get pending approvals for user",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "approvals",
  use_cases: ["approvals", "query", "pending"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      approver_sys_id: { type: "string", description: "Approver user sys_id" },
      limit: { type: "number", default: 100 },
    },
    required: ["approver_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { approver_sys_id, limit = 100 } = args
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.get("/api/now/table/sysapproval_approver", {
      params: {
        sysparm_query: `approver=${approver_sys_id}^state=requested`,
        sysparm_limit: limit,
        sysparm_display_value: "true",
      },
    })
    return createSuccessResult({
      approvals: response.data.result,
      count: response.data.result.length,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
