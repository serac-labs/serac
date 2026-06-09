/**
 * snow_create_sla_definition - Create SLA definition
 *
 * Creates Service Level Agreement definitions. Sets duration targets,
 * business schedules, and breach conditions.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_sla_definition",
  description:
    "Creates Service Level Agreement definitions. Sets duration targets, business schedules, and breach conditions.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "sla",
  use_cases: ["automation", "sla", "service-levels"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "SLA Definition name" },
      table: { type: "string", description: "Table to apply SLA to" },
      condition: { type: "string", description: "SLA condition script" },
      duration: { type: "string", description: 'Duration specification (e.g., "8:00:00" for 8 hours)' },
      durationType: { type: "string", description: "Duration type (business, calendar)", default: "business" },
      schedule: { type: "string", description: "Schedule to use (sys_id or name)" },
      active: { type: "boolean", description: "SLA active status", default: true },
      description: { type: "string", description: "SLA description" },
    },
    required: ["name", "table", "condition", "duration"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    table,
    condition,
    duration,
    durationType = "business",
    schedule,
    active = true,
    description = "",
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Resolve schedule if name provided
    let resolvedSchedule = schedule
    if (schedule && !schedule.match(/^[a-f0-9]{32}$/)) {
      const scheduleQuery = await client.get(
        `/api/now/table/cmn_schedule?sysparm_query=name=${schedule}&sysparm_limit=1`,
      )
      if (scheduleQuery.data.result && scheduleQuery.data.result.length > 0) {
        resolvedSchedule = scheduleQuery.data.result[0].sys_id
      }
    }

    const slaData: any = {
      name,
      collection: table,
      condition,
      duration,
      duration_type: durationType,
      active,
      description,
    }

    if (resolvedSchedule) {
      slaData.schedule = resolvedSchedule
    }

    const response = await client.post("/api/now/table/contract_sla", slaData)
    const sla = response.data.result

    return createSuccessResult({
      created: true,
      sla_definition: {
        sys_id: sla.sys_id,
        name: sla.name,
        table,
        duration,
        duration_type: durationType,
        schedule: resolvedSchedule || null,
        active,
      },
      message: "✅ SLA definition created successfully",
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
