/**
 * snow_create_escalation_rule - Create escalation rule
 *
 * Creates escalation rules for time-based actions. Defines escalation
 * timing, conditions, and automated responses.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_escalation_rule",
  description:
    "Creates escalation rules for time-based actions. Defines escalation timing, conditions, and automated responses.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "rules",
  use_cases: ["automation", "escalation", "rules"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Escalation Rule name" },
      table: { type: "string", description: "Table to monitor" },
      condition: { type: "string", description: "Escalation condition" },
      escalationTime: { type: "number", description: "Escalation time in minutes" },
      escalationScript: { type: "string", description: "Escalation action script (ES5 only!)" },
      active: { type: "boolean", description: "Rule active status", default: true },
      order: { type: "number", description: "Execution order", default: 100 },
      description: { type: "string", description: "Rule description" },
    },
    required: ["name", "table", "condition", "escalationTime", "escalationScript"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    table,
    condition,
    escalationTime,
    escalationScript,
    active = true,
    order = 100,
    description = "",
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    const escalationData: any = {
      name,
      table,
      condition,
      escalate_mins: escalationTime,
      script: escalationScript,
      active,
      order,
      description,
    }

    const response = await client.post("/api/now/table/sys_script_escalation", escalationData)
    const rule = response.data.result

    return createSuccessResult({
      created: true,
      escalation_rule: {
        sys_id: rule.sys_id,
        name: rule.name,
        table,
        escalation_time_mins: escalationTime,
        active,
        order,
      },
      message: "✅ Escalation rule created successfully",
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
