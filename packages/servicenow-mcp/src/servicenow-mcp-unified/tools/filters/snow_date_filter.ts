/**
 * snow_date_filter
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_date_filter",
  description: "Build an encoded-query fragment that filters a date field by either a relative window (today/yesterday/this-or-last-week/month) or an absolute start/end range. Returns the query string for use in sysparm_query.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "data-utilities",
  use_cases: ["filtering", "date-queries", "query-building"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      field: { type: "string", description: "Date field name" },
      relative: {
        type: "string",
        enum: ["today", "yesterday", "thisWeek", "lastWeek", "thisMonth", "lastMonth"],
        description: "Relative date",
      },
      start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
      end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
    },
    required: ["field"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { field, relative, start_date, end_date } = args
  try {
    let query = ""

    if (relative) {
      const relativeQueries: any = {
        today: `${field}ON Today`,
        yesterday: `${field}ON Yesterday`,
        thisWeek: `${field}ON This week`,
        lastWeek: `${field}ON Last week`,
        thisMonth: `${field}ON This month`,
        lastMonth: `${field}ON Last month`,
      }
      query = relativeQueries[relative] || ""
    } else if (start_date && end_date) {
      query = `${field}BETWEEN${start_date}@${end_date}`
    } else if (start_date) {
      query = `${field}>=${start_date}`
    } else if (end_date) {
      query = `${field}<=${end_date}`
    }

    return createSuccessResult({
      query,
      field,
      type: relative ? "relative" : "absolute",
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
