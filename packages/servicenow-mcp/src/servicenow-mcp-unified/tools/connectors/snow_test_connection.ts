/**
 * snow_test_connection
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_test_connection",
  description: "Smoke-test the current ServiceNow connection: authenticates and fetches one sys_user row. Returns the resolved instance URL on success; use as a quick liveness/credentials check before running other tools.",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "connectors",
  use_cases: ["connection-test", "authentication", "diagnostics"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {},
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.get("/api/now/table/sys_user", {
      params: { sysparm_limit: 1 },
    })

    // Validate response structure
    const result = response?.data?.result
    if (!result) {
      return createSuccessResult({
        connected: true,
        instance: context.instanceUrl,
        message: "Connection successful but no user data returned",
        user_count: 0,
      })
    }

    return createSuccessResult({
      connected: true,
      instance: context.instanceUrl,
      user_count: Array.isArray(result) ? result.length : 1,
    })
  } catch (error: any) {
    return createErrorResult(error.message || "Connection failed")
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
