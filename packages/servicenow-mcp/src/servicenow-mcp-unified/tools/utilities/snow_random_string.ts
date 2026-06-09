/**
 * snow_random_string
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import crypto from "crypto"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_random_string",
  description: "Generate a cryptographically-secure random string of a given length (default 16) from an alphanumeric, alpha-only, numeric, or hex charset. Uses crypto.randomBytes with rejection sampling — safe for tokens.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "utilities",
  use_cases: ["random-generation", "strings", "utilities"],
  complexity: "beginner",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Utility function - generates random string locally
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      length: { type: "number", default: 16 },
      charset: { type: "string", enum: ["alphanumeric", "alpha", "numeric", "hex"], default: "alphanumeric" },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { length = 16, charset = "alphanumeric" } = args
  try {
    const charsets: any = {
      alphanumeric: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      alpha: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
      numeric: "0123456789",
      hex: "0123456789abcdef",
    }

    const chars = charsets[charset]
    let result = ""

    // Use crypto.randomBytes for cryptographic security instead of Math.random()
    const limit = 256 - (256 % chars.length) // rejection threshold to avoid modulo bias
    while (result.length < length) {
      const bytes = crypto.randomBytes(length - result.length + 16)
      for (let i = 0; i < bytes.length && result.length < length; i++) {
        if (bytes[i] < limit) result += chars.charAt(bytes[i] % chars.length)
      }
    }

    return createSuccessResult({ random_string: result, length, charset })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
