/**
 * snow_approve_reject
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_approve_reject",
  description: "Approve or reject approval request",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "approvals",
  use_cases: ["approvals", "workflow", "decision"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      approval_sys_id: { type: "string", description: "Approval sys_id" },
      action: { type: "string", enum: ["approved", "rejected"], description: "Action" },
      comments: { type: "string", description: "Comments" },
    },
    required: ["approval_sys_id", "action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { approval_sys_id, action, comments } = args
  try {
    const client = await getAuthenticatedClient(context)
    const updateData: any = { state: action }
    if (comments) updateData.comments = comments
    const response = await client.patch(`/api/now/table/sysapproval_approver/${approval_sys_id}`, updateData)
    return createSuccessResult({ updated: true, action, approval: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
