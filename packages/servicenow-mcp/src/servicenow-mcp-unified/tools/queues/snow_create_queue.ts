/**
 * snow_create_queue
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_queue",
  description: "Define an assignment queue (sys_queue) — a saved filter on a table, optionally tied to an assignment group. Work items matching the condition show up in the group's work list via snow_get_queue_items.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "queues",
  use_cases: ["assignment-queues", "work-distribution", "routing"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Queue name" },
      table: { type: "string", description: "Table name" },
      condition: { type: "string", description: "Queue filter condition" },
      group: { type: "string", description: "Assignment group sys_id" },
    },
    required: ["name", "table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, table, condition, group } = args
  try {
    const client = await getAuthenticatedClient(context)
    const queueData: any = { name, table }
    if (condition) queueData.condition = condition
    if (group) queueData.group = group
    const response = await client.post("/api/now/table/sys_queue", queueData)
    return createSuccessResult({ created: true, queue: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
