/**
 * snow_create_event_rule - Create event-driven automation rule
 *
 * Creates event-driven automation rules. Triggers scripts based on
 * system events with conditional logic.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_event_rule",
  description: "Creates event-driven automation rules. Triggers scripts based on system events with conditional logic.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "rules",
  use_cases: ["automation", "events", "rules"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Event Rule name" },
      eventName: { type: "string", description: "Event name to listen for" },
      condition: { type: "string", description: "Event condition script (ES5 only!)" },
      script: {
        type: "string",
        description: "🚨 ES5 ONLY! Action script to execute (no const/let/arrows/templates - Rhino engine)",
      },
      description: { type: "string", description: "Rule description" },
      active: { type: "boolean", description: "Rule active status", default: true },
      order: { type: "number", description: "Execution order", default: 100 },
    },
    required: ["name", "eventName", "script"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, eventName, condition = "", script, description = "", active = true, order = 100 } = args

  try {
    const client = await getAuthenticatedClient(context)

    const eventRuleData: any = {
      name,
      event_name: eventName,
      script,
      description,
      active,
      order,
    }

    if (condition) {
      eventRuleData.condition = condition
    }

    const response = await client.post("/api/now/table/sysevent_script_action", eventRuleData)
    const rule = response.data.result

    return createSuccessResult({
      created: true,
      event_rule: {
        sys_id: rule.sys_id,
        name: rule.name,
        event_name: eventName,
        active,
        order,
      },
      message: "✅ Event rule created successfully",
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
