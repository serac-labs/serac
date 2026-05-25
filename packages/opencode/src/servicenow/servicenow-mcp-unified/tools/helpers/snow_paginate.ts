/**
 * snow_paginate
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_paginate",
  description: "Calculate pagination parameters",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "data-utilities",
  use_cases: ["pagination", "data-retrieval", "performance"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      total_records: { type: "number", description: "Total record count" },
      page_size: { type: "number", default: 100 },
      current_page: { type: "number", default: 1 },
    },
    required: ["total_records"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { total_records, page_size = 100, current_page = 1 } = args
  try {
    const total_pages = Math.ceil(total_records / page_size)
    const offset = (current_page - 1) * page_size
    const has_next = current_page < total_pages
    const has_prev = current_page > 1

    return createSuccessResult({
      total_records,
      page_size,
      current_page,
      total_pages,
      offset,
      has_next,
      has_prev,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
