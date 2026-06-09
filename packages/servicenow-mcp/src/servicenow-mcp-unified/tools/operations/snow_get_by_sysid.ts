/**
 * snow_get_by_sysid - Get artifact by sys_id
 *
 * Retrieve any ServiceNow record by its sys_id with optional
 * field selection and display values.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_by_sysid",
  description: "Get any ServiceNow record by sys_id with optional field selection",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "crud",
  use_cases: ["read", "records"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Table name (e.g., sp_widget, sys_ux_page, incident)",
      },
      sys_id: {
        type: "string",
        description: "sys_id of the record to retrieve",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Specific fields to return (default: all)",
        default: [],
      },
      display_value: {
        type: "boolean",
        description: "Return display values for reference fields",
        default: false,
      },
    },
    required: ["table", "sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, sys_id, fields = [], display_value = false } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Build query parameters
    const params: any = {}

    if (fields.length > 0) {
      params.sysparm_fields = fields.join(",")
    }

    if (display_value) {
      params.sysparm_display_value = "true"
    }

    // Get record
    const response = await client.get(`/api/now/table/${table}/${sys_id}`, { params })

    if (!response.data || !response.data.result) {
      return createErrorResult(`Record not found: ${table}/${sys_id}`)
    }

    const record = response.data.result

    return createSuccessResult({
      found: true,
      record,
      table,
      sys_id,
    })
  } catch (error: any) {
    if (error.response?.status === 404) {
      return createSuccessResult({
        found: false,
        table,
        sys_id,
        error: "Record not found",
      })
    }
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
