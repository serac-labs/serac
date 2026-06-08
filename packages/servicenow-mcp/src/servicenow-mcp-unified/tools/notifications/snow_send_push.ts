/**
 * snow_send_push - Send push notification
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_send_push",
  description: "Push a notification (title + body) to one or more registered mobile device IDs via /api/now/v1/push/notification. Use snow_send_notification for the multi-channel email/sms/push wrapper.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "notifications",
  use_cases: ["push-notifications", "mobile", "alerts"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      device_ids: { type: "array", items: { type: "string" } },
      title: { type: "string" },
      body: { type: "string" },
    },
    required: ["device_ids", "title", "body"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { device_ids, title, body } = args
  try {
    const client = await getAuthenticatedClient(context)
    const pushData = { device_ids: device_ids.join(","), title, body }
    const response = await client.post("/api/now/v1/push/notification", pushData)
    return createSuccessResult({ sent: true, push: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
