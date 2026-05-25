/**
 * snow_encode_base64
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_encode_base64",
  description: "Encode a UTF-8 string as Base64. Local operation — no ServiceNow call. Handy for embedding binary-ish data in JSON payloads (e.g. attachment uploads).",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "utilities",
  use_cases: ["encoding", "base64", "conversion"],
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
    const encoded = Buffer.from(text).toString("base64")
    return createSuccessResult({ encoded, original_length: text.length })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
