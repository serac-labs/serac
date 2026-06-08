/**
 * snow_send_push_notification - Send push notification to mobile devices
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_send_push_notification",
  description: "Sends a push notification to mobile devices. Can target specific users, groups, or all users.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "notifications",
  use_cases: ["push-notifications", "mobile-alerts", "notifications"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Notification title",
      },
      message: {
        type: "string",
        description: "Notification message",
      },
      target_type: {
        type: "string",
        description: "Target type: user, group, all",
      },
      target_id: {
        type: "string",
        description: "Target user or group sys_id (if target_type is user or group)",
      },
      priority: {
        type: "string",
        description: "Priority: high, normal, low",
        default: "normal",
      },
      action_type: {
        type: "string",
        description: "Action type: open_record, open_url, none",
      },
      action_data: {
        type: "object",
        description: "Action data (record sys_id, URL, etc.)",
      },
      sound: {
        type: "boolean",
        description: "Play notification sound",
        default: true,
      },
      badge: {
        type: "boolean",
        description: "Update badge count",
        default: true,
      },
    },
    required: ["title", "message", "target_type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    title,
    message,
    target_type,
    target_id,
    priority = "normal",
    action_type,
    action_data,
    sound = true,
    badge = true,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    const notificationData: any = {
      title,
      message,
      target_type,
      priority,
      sound,
      badge,
    }

    if (target_id) notificationData.target_id = target_id
    if (action_type) notificationData.action_type = action_type
    if (action_data) notificationData.action_data = JSON.stringify(action_data)

    const response = await client.post("/api/now/table/sys_push_notification", notificationData)

    let recipientCount: number | string = 1
    if (target_type === "all") {
      recipientCount = "all"
    } else if (target_type === "group") {
      // Get group member count
      try {
        const groupResponse = await client.get(
          `/api/now/table/sys_user_grmember?sysparm_query=group=${target_id}&sysparm_limit=1000`,
        )
        recipientCount = groupResponse.data.result?.length || 0
      } catch (err) {
        recipientCount = "unknown"
      }
    }

    return createSuccessResult({
      sent: true,
      notification_id: response.data.result.sys_id,
      title,
      target_type,
      recipient_count: recipientCount,
      priority,
      message: `✅ Push notification sent: "${title}" to ${recipientCount} recipient(s)`,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
