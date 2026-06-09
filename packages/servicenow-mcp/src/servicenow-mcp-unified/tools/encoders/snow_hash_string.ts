/**
 * snow_hash_string
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import crypto from "crypto"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_hash_string",
  description: "Hash string using various algorithms",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "utilities",
  use_cases: ["hashing", "cryptography", "security"],
  complexity: "beginner",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Utility function - hashes string locally
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to hash" },
      algorithm: { type: "string", enum: ["md5", "sha1", "sha256", "sha512"], default: "sha256" },
    },
    required: ["text"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { text, algorithm = "sha256" } = args
  try {
    // Warn about weak algorithms that should not be used for security purposes
    const weakAlgorithms = ["md5", "sha1"]
    const warning = weakAlgorithms.includes(algorithm)
      ? `WARNING: ${algorithm.toUpperCase()} is cryptographically weak and must NOT be used for security purposes (password hashing, integrity verification, digital signatures). Use SHA-256 or SHA-512 instead.`
      : undefined

    const hash = crypto.createHash(algorithm).update(text).digest("hex")
    return createSuccessResult({
      hash,
      algorithm,
      original_length: text.length,
      ...(warning ? { security_warning: warning } : {}),
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
