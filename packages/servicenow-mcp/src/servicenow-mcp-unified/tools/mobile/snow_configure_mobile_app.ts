/**
 * snow_configure_mobile_app - Configure mobile app
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_configure_mobile_app",
  description: "Configure ServiceNow mobile app",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-frameworks",
  subcategory: "mobile",
  use_cases: ["mobile-app", "configuration", "mobile-development"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      app_name: { type: "string" },
      platform: { type: "string", enum: ["ios", "android"] },
      features: { type: "array", items: { type: "string" } },
    },
    required: ["app_name", "platform"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { app_name, platform, features = [] } = args
  try {
    const client = await getAuthenticatedClient(context)
    const appData = { name: app_name, platform, features: features.join(",") }
    const response = await client.post("/api/now/table/sys_mobile_app", appData)
    return createSuccessResult({ configured: true, mobile_app: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
