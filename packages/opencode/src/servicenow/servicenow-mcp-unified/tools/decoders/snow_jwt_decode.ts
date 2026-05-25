/**
 * snow_jwt_decode
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_jwt_decode",
  description: "Decode a JWT into its header and payload (base64-URL → JSON). Does NOT verify the signature — useful for inspecting claims, not for trusting them. Local operation, no ServiceNow call.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "security",
  use_cases: ["jwt", "token-decode", "authentication"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      token: { type: "string", description: "JWT token" },
    },
    required: ["token"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { token } = args
  try {
    const parts = token.split(".")
    if (parts.length !== 3) {
      return createErrorResult("Invalid JWT token")
    }

    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString())

    return createSuccessResult({
      decoded: true,
      payload,
      header: JSON.parse(Buffer.from(parts[0], "base64").toString()),
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
