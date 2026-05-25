/**
 * snow_create_alert_rule
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_alert_rule",
  description: "Create alert rules for automated monitoring and notifications",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "event-management",
  use_cases: ["alerts", "rules", "monitoring"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Alert rule name" },
      table: { type: "string", description: "Target table to monitor" },
      condition: { type: "string", description: "Alert trigger condition" },
      severity: { type: "number", enum: [1, 2, 3, 4, 5], description: "Alert severity (1=Critical, 5=Info)" },
      notification_group: { type: "string", description: "Group to notify" },
      notification_user: { type: "string", description: "User to notify" },
      email_template: { type: "string", description: "Email template sys_id" },
      active: { type: "boolean", description: "Rule active status", default: true },
    },
    required: ["name", "table", "condition"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    table,
    condition,
    severity,
    notification_group,
    notification_user,
    email_template,
    active = true,
  } = args
  try {
    const client = await getAuthenticatedClient(context)

    const ruleData: any = {
      name,
      table,
      condition,
      active,
    }

    if (severity) ruleData.severity = severity
    if (notification_group) ruleData.notification_group = notification_group
    if (notification_user) ruleData.notification_user = notification_user
    if (email_template) ruleData.email_template = email_template

    const response = await client.post("/api/now/table/em_alert_rule", ruleData)

    return createSuccessResult({
      created: true,
      alert_rule: response.data.result,
      sys_id: response.data.result.sys_id,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
