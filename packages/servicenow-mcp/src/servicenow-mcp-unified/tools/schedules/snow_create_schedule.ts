/**
 * snow_create_schedule
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_schedule",
  description: "Define a schedule (cmn_schedule) — weekly/monthly/custom recurrence and a time zone. Used downstream by SLAs, on-call shifts, and business-hours calculations. Add spans via snow_add_schedule_entry.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "scheduling",
  use_cases: ["schedules", "work-hours", "sla"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Schedule name" },
      time_zone: { type: "string", description: "Time zone" },
      type: { type: "string", enum: ["weekly", "monthly", "custom"], default: "weekly" },
    },
    required: ["name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, time_zone, type = "weekly" } = args
  try {
    const client = await getAuthenticatedClient(context)
    const scheduleData: any = { name, type }
    if (time_zone) scheduleData.time_zone = time_zone
    const response = await client.post("/api/now/table/cmn_schedule", scheduleData)
    return createSuccessResult({ created: true, schedule: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
