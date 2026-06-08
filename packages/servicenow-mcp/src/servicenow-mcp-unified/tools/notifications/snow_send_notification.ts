/**
 * snow_send_notification - Send notification
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_send_notification",
  description: "Send an ad-hoc email, SMS, or push notification to a list of user sys_ids with subject and message body. For scheduled/event-driven rules use snow_create_notification instead.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "notifications",
  use_cases: ["notifications", "email", "sms"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      users: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
      message: { type: "string" },
      type: { type: "string", enum: ["email", "sms", "push"] },
    },
    required: ["users", "subject", "message"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { users, subject, message, type = "email" } = args
  try {
    const client = await getAuthenticatedClient(context)
    const notifData = { users: users.join(","), subject, message, type }
    const response = await client.post("/api/now/table/sysevent_email_action", notifData)
    return createSuccessResult({ sent: true, notification: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
