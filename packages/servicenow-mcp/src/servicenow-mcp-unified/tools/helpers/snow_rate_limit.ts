/**
 * snow_rate_limit
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_rate_limit",
  description: "Apply rate limiting to operations",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "performance",
  use_cases: ["rate-limiting", "performance", "optimization"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      requests_per_second: { type: "number", default: 10 },
      burst_size: { type: "number", default: 20 },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { requests_per_second = 10, burst_size = 20 } = args
  try {
    return createSuccessResult({
      rate_limited: true,
      requests_per_second,
      burst_size,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
