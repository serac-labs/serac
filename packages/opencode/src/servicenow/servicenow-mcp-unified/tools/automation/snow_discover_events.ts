/**
 * snow_discover_events - Discover system events
 *
 * Discovers system events registered in the instance.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_discover_events",
  description: "Discovers system events registered in the instance.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "discovery",
  use_cases: ["automation", "events", "discovery"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Discovery operation - reads metadata
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "Filter by table name" },
      nameContains: { type: "string", description: "Search by event name pattern" },
      limit: { type: "number", description: "Maximum number of events to return", default: 50 },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, nameContains, limit = 50 } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Build query
    const queryParts: string[] = []

    if (table) {
      queryParts.push(`table=${table}`)
    }

    if (nameContains) {
      queryParts.push(`event_nameLIKE${nameContains}`)
    }

    const query = queryParts.join("^")

    const response = await client.get(
      `/api/now/table/sysevent_register?sysparm_query=${query}&sysparm_limit=${limit}&sysparm_display_value=true`,
    )

    const events = response.data.result

    const formattedEvents = events.map((event: any) => ({
      sys_id: event.sys_id,
      event_name: event.event_name,
      table: event.table || null,
      description: event.description,
      queue: event.queue,
      claimed_by: event.claimed_by || null,
      state: event.state,
      created_on: event.sys_created_on,
    }))

    return createSuccessResult({
      found: true,
      count: formattedEvents.length,
      events: formattedEvents,
    })
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, error.message, { originalError: error }),
    )
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
