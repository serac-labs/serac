/**
 * snow_sanitize_input
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_sanitize_input",
  description: "Escape a user-supplied string against html, sql, or script-injection contexts. Note: prefer parameterized queries for SQL — sanitization is a fallback, not the primary defense.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "utilities",
  use_cases: ["input-sanitization", "security", "validation"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Utility function - sanitizes data locally
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "Input to sanitize" },
      type: { type: "string", enum: ["html", "sql", "script"], default: "html" },
    },
    required: ["input"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { input, type = "html" } = args
  try {
    let sanitized = input

    switch (type) {
      case "html":
        sanitized = input
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#x27;")
        break
      case "sql":
        // SECURITY: Proper SQL escaping - escape quotes and backslashes
        // Note: Parameterized queries are always preferred over sanitization
        sanitized = input
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "\\'")
          .replace(/"/g, '\\"')
          .replace(/\x00/g, "\\0")
          .replace(/\n/g, "\\n")
          .replace(/\r/g, "\\r")
          .replace(/\x1a/g, "\\Z")
        break
      case "script":
        // SECURITY: Use character-level encoding to prevent all script injection
        // This is more secure than trying to detect and remove script patterns
        // which can be bypassed through encoding tricks and obfuscation
        sanitized = sanitized
          // First normalize any HTML entities that could hide script content
          .replace(/&#x?[0-9a-f]+;?/gi, "")
          // Encode angle brackets to prevent ANY HTML tag injection
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          // Remove javascript: protocol (case insensitive, with whitespace variations)
          .replace(/j[\s]*a[\s]*v[\s]*a[\s]*s[\s]*c[\s]*r[\s]*i[\s]*p[\s]*t[\s]*:/gi, "")
          // Remove vbscript: protocol
          .replace(/v[\s]*b[\s]*s[\s]*c[\s]*r[\s]*i[\s]*p[\s]*t[\s]*:/gi, "")
          // Remove data: protocol with potential script content
          .replace(/data[\s]*:/gi, "data_blocked:")
          // Encode quotes to prevent attribute injection
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#x27;")
        break
    }

    return createSuccessResult({
      sanitized,
      type,
      original_length: input.length,
      sanitized_length: sanitized.length,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
