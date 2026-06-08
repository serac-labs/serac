/**
 * snow_duplicate_detection
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_duplicate_detection",
  description: "Check whether a candidate record would duplicate existing rows on a table by matching on the given fields. Returns up to 10 existing matches; useful for de-dup checks before insert.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "data-quality",
  use_cases: ["duplicate-detection", "data-quality", "data-management"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Detection function - finds duplicates without modifying
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table name" },
      match_fields: { type: "array", items: { type: "string" }, description: "Fields to match" },
      record_data: { type: "object", description: "Record data to check" },
    },
    required: ["table", "match_fields", "record_data"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, match_fields, record_data } = args
  try {
    const client = await getAuthenticatedClient(context)
    const query = match_fields.map((field) => `${field}=${record_data[field]}`).join("^")

    const response = await client.get(`/api/now/table/${table}`, {
      params: {
        sysparm_query: query,
        sysparm_limit: 10,
      },
    })

    return createSuccessResult({
      has_duplicates: response.data.result.length > 0,
      duplicates: response.data.result,
      count: response.data.result.length,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
