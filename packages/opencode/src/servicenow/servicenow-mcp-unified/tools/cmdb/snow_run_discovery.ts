/**
 * snow_run_discovery - Trigger CMDB discovery
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_run_discovery",
  description: "Queue a CMDB discovery scan against a discovery schedule, optionally narrowed to a target IP/range and a specific MID Server. Creates a discovery_schedule_item; the scan runs asynchronously.",
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "discovery",
  use_cases: ["cmdb", "discovery", "scanning"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      discovery_schedule: { type: "string", description: "Discovery schedule sys_id" },
      target_ip: { type: "string", description: "Target IP or range" },
      mid_server: { type: "string", description: "MID Server to use" },
    },
    required: ["discovery_schedule"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { discovery_schedule, target_ip, mid_server } = args
  try {
    const client = await getAuthenticatedClient(context)
    const discData: any = { schedule: discovery_schedule }
    if (target_ip) discData.ip_address = target_ip
    if (mid_server) discData.mid_server = mid_server
    const response = await client.post("/api/now/table/discovery_schedule_item", discData)
    return createSuccessResult({ triggered: true, discovery: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
