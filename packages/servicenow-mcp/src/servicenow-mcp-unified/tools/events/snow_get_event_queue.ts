/**
 * snow_get_event_queue
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_event_queue",
  description: "Get event queue status and pending events",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "event-management",
  use_cases: ["events", "monitoring", "troubleshooting"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", enum: ["ready", "processing", "error"], description: "Event state" },
      limit: { type: "number", default: 50 },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { state, limit = 50 } = args
  try {
    const client = await getAuthenticatedClient(context)
    const query = state ? `state=${state}` : ""
    const response = await client.get("/api/now/table/sysevent", {
      params: { sysparm_query: query, sysparm_limit: limit },
    })
    return createSuccessResult({ events: response.data.result, count: response.data.result.length })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
