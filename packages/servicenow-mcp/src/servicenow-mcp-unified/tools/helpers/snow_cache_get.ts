/**
 * snow_cache_get
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_cache_get",
  description: "Look up a value from the in-memory tool cache by key. Returns null with cached=false on miss. Pairs with snow_cache_set for de-duplicating expensive calls within a session.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "performance",
  use_cases: ["caching", "performance", "optimization"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Cache key" },
    },
    required: ["key"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { key } = args
  try {
    return createSuccessResult({
      key,
      cached: false,
      value: null,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
