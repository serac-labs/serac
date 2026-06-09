/**
 * snow_create_event_rule - Create event-driven automation rule
 *
 * Creates event-driven automation rules. Triggers scripts based on
 * system events with conditional logic.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
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
      eventName: {
        type: "string",
        description:
          "Registered event NAME to listen for, e.g. 'incident.commented' or 'x_app.my_event' — the 'event_name' string from sysevent_register. This is NOT the sys_id and NOT a reference: a Script Action matches fired events by name, so a 32-char hex sys_id will store but never fire. Use snow_discover_events to find the name.",
      },
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

function isSysId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value)
}

// Translate a sysevent_register sys_id into its event_name. Passes plain names
// through untouched; throws a clear, actionable error when the sys_id has no
// matching event so the script action is never created against an id that
// can't fire.
async function resolveEventName(client: any, eventName: string): Promise<string> {
  if (!isSysId(eventName)) return eventName

  const response = await client.get(
    `/api/now/table/sysevent_register?sysparm_query=sys_id=${eventName}&sysparm_fields=event_name&sysparm_limit=1`,
  )
  const record = response.data.result?.[0]

  if (!record?.event_name) {
    throw new SnowFlowError(
      ErrorType.VALIDATION_ERROR,
      `eventName "${eventName}" looks like a sys_id but no sysevent_register record matches it. Pass the registered event NAME string (e.g. "incident.commented"), not the sys_id — a Script Action fires on the event name.`,
    )
  }

  return record.event_name
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, eventName, condition = "", script, description = "", active = true, order = 100 } = args

  try {
    const client = await getAuthenticatedClient(context)

    // A Script Action matches a fired event by its registered NAME, not its
    // sys_id. Agents frequently pass the sys_id of the sysevent_register record
    // they just looked up — it saves without error but the rule never fires.
    // Detect that and resolve the sys_id back to the actual event_name.
    const resolvedEventName = await resolveEventName(client, eventName)

    const eventRuleData: any = {
      name,
      event_name: resolvedEventName,
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
        event_name: resolvedEventName,
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
