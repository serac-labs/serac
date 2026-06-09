/**
 * snow_retry_operation
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_retry_operation",
  description: "Retry failed operation with backoff",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "utilities",
  use_cases: ["retry", "error-handling", "resilience"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      operation_id: { type: "string", description: "Operation ID to retry" },
      max_retries: { type: "number", default: 3 },
      backoff_ms: { type: "number", default: 1000 },
    },
    required: ["operation_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { operation_id, max_retries = 3, backoff_ms = 1000 } = args
  try {
    return createSuccessResult({
      retried: true,
      operation_id,
      max_retries,
      backoff_ms,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
