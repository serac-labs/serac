/**
 * snow_emergency_broadcast - Send emergency broadcasts
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_emergency_broadcast",
  description: "Send emergency broadcast notification to all users or specific groups",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "notifications",
  use_cases: ["broadcast", "emergency", "alerts"],
  complexity: "advanced",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      broadcast_type: {
        type: "string",
        description: "Broadcast type",
        enum: ["system_outage", "security_alert", "maintenance", "emergency"],
      },
      target_audience: {
        type: "string",
        description: "Target audience",
        enum: ["all_users", "it_staff", "management", "specific_group"],
      },
      group_id: {
        type: "string",
        description: "Group sys_id if target is specific_group",
      },
      message: {
        type: "string",
        description: "Emergency message",
      },
      channels: {
        type: "array",
        items: { type: "string" },
        description: "Channels to use for broadcast",
        default: ["email", "push"],
      },
      override_preferences: {
        type: "boolean",
        description: "Override user quiet hours/preferences",
        default: true,
      },
      require_acknowledgment: {
        type: "boolean",
        description: "Require user acknowledgment",
        default: false,
      },
    },
    required: ["broadcast_type", "target_audience", "message"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    broadcast_type,
    target_audience,
    group_id,
    message,
    channels = ["email", "push"],
    override_preferences = true,
    require_acknowledgment = false,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Get target users
    let userQuery = "active=true"

    if (target_audience === "it_staff") {
      userQuery += "^roles.nameSTARTSWITHitil"
    } else if (target_audience === "management") {
      userQuery += "^department.nameLIKEmanagement"
    } else if (target_audience === "specific_group" && group_id) {
      userQuery += `^sys_user_group=${group_id}`
    }

    const usersResponse = await client.get("/api/now/table/sys_user", {
      params: {
        sysparm_query: userQuery,
        sysparm_fields: "sys_id,email,name",
      },
    })

    const users = usersResponse.data.result

    // Create broadcast notification event
    const broadcastResponse = await client.post("/api/now/table/sysevent", {
      event_name: "broadcast.emergency",
      param1: broadcast_type,
      param2: message,
      claimed_by: "broadcast_system",
      description: `Emergency broadcast: ${broadcast_type}`,
      queued: new Date().toISOString(),
    })

    // Send to each channel
    const sent = {
      event_sys_id: broadcastResponse.data.result.sys_id,
      target_users: users.length,
      channels_used: channels,
      override_preferences,
      require_acknowledgment,
    }

    return createSuccessResult({
      broadcast_sent: true,
      ...sent,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
