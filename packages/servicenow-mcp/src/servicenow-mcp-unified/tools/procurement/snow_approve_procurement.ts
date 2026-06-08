/**
 * snow_approve_procurement
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_approve_procurement",
  description: "Mark a procurement request (proc_request) as approved, with optional comments. Use after the request has been reviewed — advances it toward purchase-order creation.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "procurement",
  use_cases: ["procurement", "approvals", "purchasing"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      request_sys_id: { type: "string" },
      comments: { type: "string" },
    },
    required: ["request_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { request_sys_id, comments } = args
  try {
    const client = await getAuthenticatedClient(context)
    const approvalData: any = { approval: "approved" }
    if (comments) approvalData.comments = comments
    const response = await client.put(`/api/now/table/proc_request/${request_sys_id}`, approvalData)
    return createSuccessResult({ approved: true, request: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
