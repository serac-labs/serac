/**
 * snow_calculate_sla_duration
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_calculate_sla_duration",
  description: "Calculate SLA duration with schedule",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "sla",
  use_cases: ["sla-calculation", "time-tracking", "duration"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Calculation function - calculates SLA duration locally
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      start_time: { type: "string", description: "Start datetime" },
      end_time: { type: "string", description: "End datetime" },
      schedule_sys_id: { type: "string", description: "Schedule sys_id" },
    },
    required: ["start_time", "end_time"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { start_time, end_time, schedule_sys_id } = args
  try {
    const client = await getAuthenticatedClient(context)
    const calcScript = `
var startGDT = new GlideDateTime('${start_time}');
var endGDT = new GlideDateTime('${end_time}');
var duration = GlideDateTime.subtract(startGDT, endGDT);
gs.info('Duration: ' + duration.getDisplayValue());
    `
    await client.post("/api/now/table/sys_script_execution", { script: calcScript })
    return createSuccessResult({
      calculated: true,
      start_time,
      end_time,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
