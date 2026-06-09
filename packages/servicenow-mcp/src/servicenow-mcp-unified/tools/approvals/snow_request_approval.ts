/**
 * snow_request_approval
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_request_approval",
  description: "Create a sysapproval_approver record asking a specific user to approve a record on a source table. Sets state to 'requested' and attaches optional comments. Used to kick off approval workflows outside of Flow Designer.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "approvals",
  use_cases: ["approvals", "workflow", "requests"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      source_table: { type: "string", description: "Source table name" },
      source_sys_id: { type: "string", description: "Source record sys_id" },
      approver: { type: "string", description: "Approver user sys_id" },
      comments: { type: "string", description: "Approval comments" },
    },
    required: ["source_table", "source_sys_id", "approver"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { source_table, source_sys_id, approver, comments } = args
  try {
    const client = await getAuthenticatedClient(context)
    const approvalData: any = {
      source_table,
      sysapproval: source_sys_id,
      approver,
      state: "requested",
    }
    if (comments) approvalData.comments = comments
    const response = await client.post("/api/now/table/sysapproval_approver", approvalData)
    return createSuccessResult({ created: true, approval: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
