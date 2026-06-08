/**
 * snow_notification_preferences - Manage notification preferences
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_notification_preferences",
  description: "Manage user notification preferences and routing rules",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "notifications",
  use_cases: ["preferences", "user-settings", "configuration"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      user_id: {
        type: "string",
        description: "User sys_id",
      },
      action: {
        type: "string",
        description: "Action to perform",
        enum: ["get", "set", "update"],
      },
      preferences: {
        type: "object",
        description: "User notification preferences",
        properties: {
          email_enabled: { type: "boolean" },
          sms_enabled: { type: "boolean" },
          push_enabled: { type: "boolean" },
          quiet_hours_start: { type: "string", description: "HH:MM format" },
          quiet_hours_end: { type: "string", description: "HH:MM format" },
        },
      },
    },
    required: ["user_id", "action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { user_id, action, preferences = {} } = args

  try {
    const client = await getAuthenticatedClient(context)

    if (action === "get") {
      // Get user notification preferences
      const response = await client.get("/api/now/table/sys_user_preference", {
        params: {
          sysparm_query: `user=${user_id}^nameLIKEnotification`,
          sysparm_fields: "name,value",
        },
      })

      const prefs = response.data.result
      const userPrefs: any = {}

      prefs.forEach((p: any) => {
        userPrefs[p.name] = p.value
      })

      return createSuccessResult({
        user_id,
        preferences: userPrefs,
      })
    }

    if (action === "set" || action === "update") {
      // Set/update user preferences
      const updates = []

      for (const [key, value] of Object.entries(preferences)) {
        const prefName = `notification.${key}`

        // Check if preference exists
        const existingResponse = await client.get("/api/now/table/sys_user_preference", {
          params: {
            sysparm_query: `user=${user_id}^name=${prefName}`,
            sysparm_limit: 1,
          },
        })

        if (existingResponse.data.result.length > 0) {
          // Update existing
          const prefSysId = existingResponse.data.result[0].sys_id
          await client.patch(`/api/now/table/sys_user_preference/${prefSysId}`, {
            value: String(value),
          })
        } else {
          // Create new
          await client.post("/api/now/table/sys_user_preference", {
            user: user_id,
            name: prefName,
            value: String(value),
          })
        }

        updates.push({ name: prefName, value })
      }

      return createSuccessResult({
        updated: true,
        user_id,
        changes: updates,
      })
    }

    return createErrorResult(`Unknown action: ${action}`)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
