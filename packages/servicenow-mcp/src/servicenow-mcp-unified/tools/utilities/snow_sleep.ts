/**
 * snow_sleep
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_sleep",
  description: "Sleep for specified milliseconds",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "utilities",
  use_cases: ["delay", "timing", "utilities"],
  complexity: "beginner",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Utility function - delays execution but no data modification
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      milliseconds: { type: "number", description: "Sleep duration in ms", default: 1000 },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { milliseconds = 1000 } = args
  try {
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
    return createSuccessResult({ slept: true, duration_ms: milliseconds })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
