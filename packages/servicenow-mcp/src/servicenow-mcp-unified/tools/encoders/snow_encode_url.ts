/**
 * snow_encode_url
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_encode_url",
  description: "URL-encode a string for safe use in query parameters (encodeURIComponent). Local operation — no ServiceNow call.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "utilities",
  use_cases: ["encoding", "url", "conversion"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to encode" },
    },
    required: ["text"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { text } = args
  try {
    const encoded = encodeURIComponent(text)
    return createSuccessResult({ encoded, original: text })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
