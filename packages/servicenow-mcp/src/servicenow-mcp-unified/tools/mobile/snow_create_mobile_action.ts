/**
 * snow_create_mobile_action - Create mobile action
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_mobile_action",
  description:
    "Creates a mobile action that users can trigger from the mobile app. Actions can navigate, execute scripts, or open forms.",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-frameworks",
  subcategory: "mobile",
  use_cases: ["mobile-actions", "mobile-ui", "user-interactions"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Action name",
      },
      label: {
        type: "string",
        description: "Action label displayed to users",
      },
      table: {
        type: "string",
        description: "Table this action applies to",
      },
      action_type: {
        type: "string",
        description: "Action type: navigate, script, form, workflow",
      },
      icon: {
        type: "string",
        description: "Icon name for the action",
      },
      script: {
        type: "string",
        description: "Script to execute (for script type)",
      },
      target_url: {
        type: "string",
        description: "Target URL (for navigate type)",
      },
      condition: {
        type: "string",
        description: "Condition script for action visibility",
      },
      order: {
        type: "number",
        description: "Display order",
        default: 100,
      },
    },
    required: ["name", "label", "table", "action_type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, label, table, action_type, icon, script, target_url, condition, order = 100 } = args

  try {
    const client = await getAuthenticatedClient(context)

    const actionData: any = {
      name,
      label,
      table,
      action_type,
      order,
    }

    if (icon) actionData.icon = icon
    if (script) actionData.script = script
    if (target_url) actionData.target_url = target_url
    if (condition) actionData.condition = condition

    const response = await client.post("/api/now/table/sys_ui_mobile_action", actionData)

    return createSuccessResult({
      created: true,
      action: response.data.result,
      name,
      table,
      action_type,
      message: `✅ Mobile action created: ${label}`,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
