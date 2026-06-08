/**
 * snow_create_ui_action - Create UI Actions
 *
 * Create buttons, context menu items, and form links with client/server
 * script execution and condition control.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_ui_action",
  description: "Create UI Action (button, context menu, form link) with client/server scripts",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "platform",
  use_cases: ["ui-actions", "buttons", "form-controls"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "UI Action name (button label)",
      },
      table: {
        type: "string",
        description: "Table to attach action to",
      },
      action_name: {
        type: "string",
        description: "Internal action name (alphanumeric, no spaces)",
      },
      script: {
        type: "string",
        description: "Client or server script to execute",
      },
      description: {
        type: "string",
        description: "Action description",
      },
      action_type: {
        type: "string",
        enum: [
          "form_button",
          "form_link",
          "form_context_menu",
          "list_choice",
          "list_banner_button",
          "list_bottom_button",
        ],
        description: "Where the action appears",
        default: "form_button",
      },
      client: {
        type: "boolean",
        description: "Execute as client script",
        default: true,
      },
      onclick: {
        type: "string",
        description: "Client-side onclick handler",
      },
      condition: {
        type: "string",
        description: "Condition script (must return true/false)",
      },
      order: {
        type: "number",
        description: "Display order",
        default: 100,
      },
      active: {
        type: "boolean",
        description: "Activate immediately",
        default: true,
      },
      show_insert: {
        type: "boolean",
        description: "Show on new record forms",
        default: true,
      },
      show_update: {
        type: "boolean",
        description: "Show on existing record forms",
        default: true,
      },
    },
    required: ["name", "table", "action_name", "script"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    table,
    action_name,
    script,
    description = "",
    action_type = "form_button",
    client = true,
    onclick,
    condition = "",
    order = 100,
    active = true,
    show_insert = true,
    show_update = true,
  } = args

  try {
    const client_instance = await getAuthenticatedClient(context)

    // Create UI Action
    const uiActionData: any = {
      name,
      table,
      action_name,
      script,
      comments: description,
      client,
      order,
      active,
      show_insert,
      show_update,
    }

    // Set action type-specific fields
    const typeMap: Record<string, any> = {
      form_button: { form_button: true },
      form_link: { form_link: true },
      form_context_menu: { form_context_menu: true },
      list_choice: { list_choice: true },
      list_banner_button: { list_banner_button: true },
      list_bottom_button: { list_bottom_button: true },
    }

    Object.assign(uiActionData, typeMap[action_type] || typeMap.form_button)

    if (onclick) {
      uiActionData.onclick = onclick
    }

    if (condition) {
      uiActionData.condition = condition
    }

    const response = await client_instance.post("/api/now/table/sys_ui_action", uiActionData)
    const uiAction = response.data.result

    // Provide examples based on client vs server
    const examples = client
      ? {
          basic: `// Client-side (runs in browser)\nfunction ${action_name}() {\n  alert('Button clicked');\n  g_form.setValue('field', 'value');\n}`,
          with_server: `// Client calls server\nfunction ${action_name}() {\n  var ga = new GlideAjax('ScriptIncludeName');\n  ga.addParam('sysparm_name', 'method');\n  ga.getXMLAnswer(function(answer) {\n    g_form.addInfoMessage('Server response: ' + answer);\n  });\n}`,
        }
      : {
          basic: `// Server-side (runs on server)\naction.setRedirectURL(current);\ngs.addInfoMessage('Action completed');`,
        }

    return createSuccessResult({
      created: true,
      ui_action: {
        sys_id: uiAction.sys_id,
        name: uiAction.name,
        action_name: uiAction.action_name,
        table: uiAction.table,
        type: action_type,
        client: uiAction.client === "true",
        order: uiAction.order,
        active: uiAction.active === "true",
      },
      visibility: {
        show_insert: show_insert,
        show_update: show_update,
        has_condition: !!condition,
      },
      examples,
      best_practices: [
        "Use client scripts for immediate UI updates",
        "Use server scripts for data operations and security",
        "Always provide user feedback (messages, redirects)",
        "Test with different user roles and conditions",
        "Keep scripts focused on single responsibility",
      ],
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
