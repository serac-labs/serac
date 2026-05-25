/**
 * snow_create_processor
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_processor",
  description: "Create script processor (ES5 only!)",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "platform",
  use_cases: ["processors", "scripted-rest", "api"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Processor name" },
      path: { type: "string", description: "URL path" },
      script: { type: "string", description: "Processing script (ES5 only!)" },
      type: { type: "string", enum: ["script", "scripted_rest"], default: "script" },
      active: { type: "boolean", default: true },
    },
    required: ["name", "path", "script"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, path, script, type = "script", active = true } = args
  try {
    const client = await getAuthenticatedClient(context)
    const processorData: any = {
      name,
      path,
      script,
      type,
      active,
    }
    const response = await client.post("/api/now/table/sys_processor", processorData)
    return createSuccessResult({ created: true, processor: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
