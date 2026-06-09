/**
 * snow_get_sla_status
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_sla_status",
  description: "List all task_sla rows attached to a task record (incident, request, etc.) by record sys_id. Returns display values: SLA name, business %, breached flag, time-left — one row per applicable SLA.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "sla",
  use_cases: ["sla-monitoring", "status-check", "service-level"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table name" },
      record_sys_id: { type: "string", description: "Record sys_id" },
    },
    required: ["table", "record_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, record_sys_id } = args
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.get("/api/now/table/task_sla", {
      params: {
        sysparm_query: `task=${record_sys_id}`,
        sysparm_display_value: "true",
      },
    })
    return createSuccessResult({
      slas: response.data.result,
      count: response.data.result.length,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
