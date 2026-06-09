/**
 * snow_get_user_roles
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_user_roles",
  description: "Get all roles assigned to user",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "user-admin",
  use_cases: ["roles", "users", "query"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      user_id: { type: "string", description: "User sys_id" },
    },
    required: ["user_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { user_id } = args
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.get("/api/now/table/sys_user_has_role", {
      params: {
        sysparm_query: `user=${user_id}`,
        sysparm_display_value: "true",
        sysparm_limit: 500,
      },
    })
    return createSuccessResult({ roles: response.data.result, count: response.data.result.length })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
