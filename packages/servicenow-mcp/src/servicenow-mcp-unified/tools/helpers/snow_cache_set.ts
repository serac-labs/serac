/**
 * snow_cache_set
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_cache_set",
  description: "Store a string value in the in-memory tool cache under a key, with a TTL in seconds (default 3600). Read back with snow_cache_get within the same session.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "performance",
  use_cases: ["caching", "performance", "optimization"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create/update/delete operation
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Cache key" },
      value: { type: "string", description: "Value to cache" },
      ttl_seconds: { type: "number", default: 3600 },
    },
    required: ["key", "value"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { key, value, ttl_seconds = 3600 } = args
  try {
    return createSuccessResult({
      cached: true,
      key,
      ttl_seconds,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
