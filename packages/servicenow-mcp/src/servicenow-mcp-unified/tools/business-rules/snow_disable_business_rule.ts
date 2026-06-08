/**
 * snow_disable_business_rule
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_disable_business_rule",
  description: "Flip a business rule's active flag to false by sys_id (patches sys_script). Disabling stops it from firing without deleting the rule — pair with the same patch toggling active=true to re-enable.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "platform",
  use_cases: ["business-rules", "management", "configuration"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      rule_sys_id: { type: "string", description: "Business rule sys_id" },
    },
    required: ["rule_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { rule_sys_id } = args
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.patch(`/api/now/table/sys_script/${rule_sys_id}`, { active: false })
    return createSuccessResult({ disabled: true, business_rule: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
