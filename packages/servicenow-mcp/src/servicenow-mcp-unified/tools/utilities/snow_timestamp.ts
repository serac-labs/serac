/**
 * snow_timestamp
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_timestamp",
  description: "Get current timestamp in various formats",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "utilities",
  use_cases: ["timestamps", "time", "utilities"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Utility function - generates timestamp locally
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      format: { type: "string", enum: ["iso", "unix", "unix_ms", "date", "time"], default: "iso" },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { format = "iso" } = args
  try {
    const now = new Date()
    let timestamp: any

    switch (format) {
      case "iso":
        timestamp = now.toISOString()
        break
      case "unix":
        timestamp = Math.floor(now.getTime() / 1000)
        break
      case "unix_ms":
        timestamp = now.getTime()
        break
      case "date":
        timestamp = now.toISOString().split("T")[0]
        break
      case "time":
        timestamp = now.toISOString().split("T")[1]
        break
    }

    return createSuccessResult({ timestamp, format })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
