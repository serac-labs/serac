/**
 * snow_decode_base64
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_decode_base64",
  description: "Decode a Base64-encoded string back to UTF-8 text. Local operation — no ServiceNow call. Pair with snow_encode_base64 for round-tripping.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "utilities",
  use_cases: ["encoding", "decoding", "base64"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      encoded: { type: "string", description: "Base64 encoded string" },
    },
    required: ["encoded"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { encoded } = args
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8")
    return createSuccessResult({ decoded, encoded_length: encoded.length })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
