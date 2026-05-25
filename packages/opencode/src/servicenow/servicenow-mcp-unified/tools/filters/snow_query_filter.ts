/**
 * snow_query_filter
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_query_filter",
  description: "Build ServiceNow encoded query filter",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "data-utilities",
  use_cases: ["filtering", "encoded-queries", "query-building"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Query operation - only reads data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      conditions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            operator: {
              type: "string",
              enum: ["=", "!=", ">", "<", ">=", "<=", "LIKE", "IN", "STARTSWITH", "ENDSWITH"],
            },
            value: { type: "string" },
          },
        },
        description: "Filter conditions",
      },
      logic: { type: "string", enum: ["AND", "OR"], default: "AND" },
    },
    required: ["conditions"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { conditions, logic = "AND" } = args
  try {
    const separator = logic === "AND" ? "^" : "^OR"
    const query = conditions.map((cond: any) => `${cond.field}${cond.operator}${cond.value}`).join(separator)

    return createSuccessResult({
      query,
      conditions: conditions.length,
      logic,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
