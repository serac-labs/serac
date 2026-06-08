/**
 * snow_update_ci - Update Configuration Item
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_update_ci",
  description: "Update Configuration Item attributes",
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "crud",
  use_cases: ["cmdb", "update", "configuration-item"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Update operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      sys_id: { type: "string", description: "CI sys_id" },
      ci_class: { type: "string", description: "CI class table" },
      attributes: { type: "object", description: "Attributes to update" },
    },
    required: ["sys_id", "ci_class", "attributes"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, ci_class, attributes } = args
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.put(`/api/now/table/${ci_class}/${sys_id}`, attributes)
    return createSuccessResult({ updated: true, ci: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
