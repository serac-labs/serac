/**
 * snow_create_notification
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_notification",
  description: "Configure an event-driven email notification (sysevent_email_action): fires when records on a table match a condition, with recipients, subject, inline message, or a sysevent_email_template (resolved by sys_id or template name).",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "notifications",
  use_cases: ["notifications", "automation", "email"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Notification name" },
      table: { type: "string", description: "Table to monitor" },
      condition: { type: "string", description: "When to trigger" },
      recipients: { type: "string", description: "Who receives notification" },
      subject: { type: "string", description: "Email subject" },
      message: { type: "string", description: "Email message" },
      template: {
        type: "string",
        description:
          "Email template sys_id or name (from sysevent_email_template) - uses template instead of inline message",
      },
      active: { type: "boolean", default: true },
    },
    required: ["name", "table", "condition"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, table, condition, recipients, subject, message, template, active = true } = args
  try {
    const client = await getAuthenticatedClient(context)

    // Helper to resolve template name to sys_id
    async function resolveTemplateId(templateId: string): Promise<string> {
      if (templateId.length === 32 && !/\s/.test(templateId)) return templateId
      var lookup = await client.get("/api/now/table/sysevent_email_template", {
        params: {
          sysparm_query: "name=" + templateId,
          sysparm_fields: "sys_id",
          sysparm_limit: 1,
        },
      })
      if (!lookup.data.result?.[0]) {
        throw new SnowFlowError(ErrorType.NOT_FOUND, "Email template not found: " + templateId)
      }
      return lookup.data.result[0].sys_id
    }

    // Note: sysevent_email_action table uses 'collection' field, not 'table'
    const notificationData: any = {
      name,
      collection: table,
      condition,
      active,
    }
    if (recipients) notificationData.recipients = recipients
    if (subject) notificationData.subject = subject
    if (message) notificationData.message = message
    if (template) {
      var resolvedTemplateId = await resolveTemplateId(template)
      notificationData.template = resolvedTemplateId
    }
    const response = await client.post("/api/now/table/sysevent_email_action", notificationData)
    return createSuccessResult({ created: true, notification: response.data.result })
  } catch (error: any) {
    if (error instanceof SnowFlowError) {
      return createErrorResult(error)
    }
    return createErrorResult(error.message)
  }
}

export const version = "1.1.0"
export const author = "Serac v8.41.17"
