/**
 * snow_get_journal_entries
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_journal_entries",
  description: "Get journal entries for record",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "comments",
  use_cases: ["journals", "audit", "history"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table name" },
      record_sys_id: { type: "string", description: "Record sys_id" },
      limit: { type: "number", default: 100 },
    },
    required: ["table", "record_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, record_sys_id, limit = 100 } = args
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.get("/api/now/table/sys_journal_field", {
      params: {
        sysparm_query: `name=${table}^element_id=${record_sys_id}`,
        sysparm_limit: limit,
        sysparm_display_value: "true",
      },
    })
    return createSuccessResult({
      entries: response.data.result,
      count: response.data.result.length,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
