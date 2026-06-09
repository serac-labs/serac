/**
 * snow_error_handler
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_error_handler",
  description: "Register a server-side error handler (sys_error_handler) bound to a specific error type. The handler_script runs when that error fires; must be ES5-compatible (no arrow functions, const/let, etc.).",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "error-handling",
  use_cases: ["error-handling", "debugging", "logging"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Handler name" },
      error_type: { type: "string", description: "Error type to handle" },
      handler_script: { type: "string", description: "Handler script (ES5 only!)" },
    },
    required: ["name", "error_type", "handler_script"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, error_type, handler_script } = args
  try {
    const client = await getAuthenticatedClient(context)
    const handlerData = {
      name,
      type: error_type,
      script: handler_script,
      active: true,
    }
    const response = await client.post("/api/now/table/sys_error_handler", handlerData)
    return createSuccessResult({ created: true, handler: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
