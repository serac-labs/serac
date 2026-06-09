/**
 * snow_decode_url
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_decode_url",
  description: "URL-decode a percent-encoded string (decodeURIComponent). Local operation — no ServiceNow call. Pair with snow_encode_url to round-trip query params.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "utilities",
  use_cases: ["encoding", "decoding", "url"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      encoded: { type: "string", description: "URL encoded string" },
    },
    required: ["encoded"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { encoded } = args
  try {
    const decoded = decodeURIComponent(encoded)
    return createSuccessResult({ decoded, encoded })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
