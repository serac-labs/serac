/**
 * snow_create_sla
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_sla",
  description: "Create Service Level Agreement",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "sla",
  use_cases: ["sla-management", "service-level", "agreements"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "SLA name" },
      table: { type: "string", description: "Table name" },
      duration: { type: "string", description: 'Duration (e.g., "4 Hours")' },
      condition: { type: "string", description: "When SLA applies" },
      schedule: { type: "string", description: "Schedule sys_id" },
      active: { type: "boolean", default: true },
    },
    required: ["name", "table", "duration"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, table, duration, condition, schedule, active = true } = args
  try {
    const client = await getAuthenticatedClient(context)
    const slaData: any = { name, collection: table, duration, active }
    if (condition) slaData.condition = condition
    if (schedule) slaData.schedule = schedule
    const response = await client.post("/api/now/table/contract_sla", slaData)
    return createSuccessResult({ created: true, sla: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
