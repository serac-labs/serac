/**
 * snow_field_filter
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_field_filter",
  description: "Build an encoded-query fragment matching one field against a list of values, OR-joined. Match type is exact (=), contains (LIKE), startsWith, or endsWith. Returns the query string for use in sysparm_query.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "data-utilities",
  use_cases: ["filtering", "field-queries", "query-building"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      field: { type: "string", description: "Field name" },
      values: { type: "array", items: { type: "string" }, description: "Values to filter" },
      match_type: { type: "string", enum: ["exact", "contains", "startsWith", "endsWith"], default: "exact" },
    },
    required: ["field", "values"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { field, values, match_type = "exact" } = args
  try {
    const operatorMap: any = {
      exact: "=",
      contains: "LIKE",
      startsWith: "STARTSWITH",
      endsWith: "ENDSWITH",
    }

    const operator = operatorMap[match_type]
    const query = values.map((val: string) => `${field}${operator}${val}`).join("^OR")

    return createSuccessResult({
      query,
      field,
      match_type,
      value_count: values.length,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
