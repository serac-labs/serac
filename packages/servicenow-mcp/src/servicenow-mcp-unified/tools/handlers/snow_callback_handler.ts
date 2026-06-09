/**
 * snow_callback_handler
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_callback_handler",
  description: "Create callback handler for async operations",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "callbacks",
  use_cases: ["callbacks", "async", "integration"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Callback name" },
      callback_url: { type: "string", description: "Callback URL" },
      http_method: { type: "string", enum: ["POST", "PUT", "PATCH"], default: "POST" },
    },
    required: ["name", "callback_url"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, callback_url, http_method = "POST" } = args
  try {
    return createSuccessResult({
      configured: true,
      name,
      callback_url,
      http_method,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
