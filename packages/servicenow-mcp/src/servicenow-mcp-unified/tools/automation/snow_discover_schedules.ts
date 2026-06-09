/**
 * snow_discover_schedules - Discover schedules
 *
 * Discovers schedules (business hours, maintenance windows) in the instance.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_discover_schedules",
  description: "Discovers schedules (business hours, maintenance windows) in the instance.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "discovery",
  use_cases: ["automation", "schedules", "discovery"],
  complexity: "beginner",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Discovery operation - reads metadata
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      nameContains: { type: "string", description: "Search by schedule name pattern" },
      type: { type: "string", description: "Filter by schedule type" },
      limit: { type: "number", description: "Maximum number of schedules to return", default: 50 },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { nameContains, type, limit = 50 } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Build query
    const queryParts: string[] = []

    if (type) {
      queryParts.push(`type=${type}`)
    }

    if (nameContains) {
      queryParts.push(`nameLIKE${nameContains}`)
    }

    const query = queryParts.join("^")

    const response = await client.get(
      `/api/now/table/cmn_schedule?sysparm_query=${query}&sysparm_limit=${limit}&sysparm_display_value=true`,
    )

    const schedules = response.data.result

    const formattedSchedules = schedules.map((schedule: any) => ({
      sys_id: schedule.sys_id,
      name: schedule.name,
      description: schedule.description,
      type: schedule.type,
      time_zone: schedule.time_zone,
      parent_schedule: schedule.parent?.display_value || null,
      created_on: schedule.sys_created_on,
      updated_on: schedule.sys_updated_on,
    }))

    return createSuccessResult({
      found: true,
      count: formattedSchedules.length,
      schedules: formattedSchedules,
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
