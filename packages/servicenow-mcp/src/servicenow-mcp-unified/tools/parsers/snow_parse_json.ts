/**
 * snow_parse_json
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_parse_json",
  description: "Parse a JSON string and validate it: returns the parsed object plus the top-level key count, or an error message if the JSON is malformed. Runs locally — no ServiceNow call.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "data-utilities",
  use_cases: ["parsing", "validation", "json"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Utility function - parses JSON locally
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      json_string: { type: "string", description: "JSON string to parse" },
    },
    required: ["json_string"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { json_string } = args
  try {
    const parsed = JSON.parse(json_string)
    return createSuccessResult({
      parsed: true,
      data: parsed,
      keys: Object.keys(parsed).length,
    })
  } catch (error: any) {
    return createErrorResult(`Invalid JSON: ${error.message}`)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
