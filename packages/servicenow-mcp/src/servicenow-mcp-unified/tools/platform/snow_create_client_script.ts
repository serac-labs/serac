/**
 * snow_create_client_script - Create Client Scripts
 *
 * Create client-side scripts for forms with type (onLoad, onChange, onSubmit),
 * field targeting, and UI manipulation.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_client_script",
  description: "Create client-side script for form with type and field targeting",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "platform",
  use_cases: ["client-scripts", "form-scripts", "ui-automation"],
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
        description: "Client Script name",
      },
      table: {
        type: "string",
        description: "Table to attach script to",
      },
      type: {
        type: "string",
        enum: ["onLoad", "onChange", "onSubmit", "onCellEdit"],
        description: "Script type",
        default: "onLoad",
      },
      script: {
        type: "string",
        description: "Client script code (runs in browser, ES5 compatible)",
      },
      field_name: {
        type: "string",
        description: "Field name (required for onChange/onCellEdit)",
      },
      ui_type: {
        type: "string",
        enum: ["desktop", "mobile", "both"],
        description: "UI type to run on",
        default: "both",
      },
      description: {
        type: "string",
        description: "Script description",
      },
      condition: {
        type: "string",
        description: "Condition script (must return true/false)",
      },
      active: {
        type: "boolean",
        description: "Activate immediately",
        default: true,
      },
      global: {
        type: "boolean",
        description: "Apply to all forms (not just current table)",
        default: false,
      },
    },
    required: ["name", "table", "type", "script"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    table,
    type = "onLoad",
    script,
    field_name,
    ui_type = "both",
    description = "",
    condition = "",
    active = true,
    global: isGlobal = false,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Validate field_name for onChange/onCellEdit
    if ((type === "onChange" || type === "onCellEdit") && !field_name) {
      throw new Error(`field_name is required for ${type} client scripts`)
    }

    // Create Client Script
    const clientScriptData: any = {
      name,
      table,
      type,
      script,
      description,
      ui_type: ui_type === "both" ? "" : ui_type,
      active,
      global: isGlobal,
    }

    if (field_name) {
      clientScriptData.field_name = field_name
    }

    if (condition) {
      clientScriptData.condition = condition
    }

    const response = await client.post("/api/now/table/sys_script_client", clientScriptData)
    const clientScript = response.data.result

    // Provide API context based on type
    const apiContext: Record<string, any> = {
      onLoad: {
        description: "Runs when form loads",
        available_apis: ["g_form", "g_user", "g_scratchpad"],
        example: 'g_form.setValue("field_name", "value");',
      },
      onChange: {
        description: `Runs when ${field_name} changes`,
        available_apis: ["g_form", "g_user", "control", "oldValue", "newValue", "isLoading", "isTemplate"],
        example: 'if (newValue != oldValue) { g_form.setValue("other_field", newValue); }',
      },
      onSubmit: {
        description: "Runs before form submission",
        available_apis: ["g_form", "g_user", "g_scratchpad"],
        example: 'if (!g_form.getValue("required_field")) { alert("Field is required"); return false; }',
      },
      onCellEdit: {
        description: `Runs when ${field_name} cell is edited in list`,
        available_apis: ["g_list", "sysIDs", "table", "oldValues", "newValue"],
        example: 'if (newValue == "invalid") { alert("Invalid value"); return false; }',
      },
    }

    return createSuccessResult({
      created: true,
      client_script: {
        sys_id: clientScript.sys_id,
        name: clientScript.name,
        table: clientScript.table,
        type: clientScript.type,
        field_name: clientScript.field_name || "N/A",
        ui_type: ui_type,
        active: clientScript.active === "true",
        global: clientScript.global === "true",
      },
      api_context: apiContext[type],
      best_practices: [
        "Keep client scripts lightweight for performance",
        "Use g_form API instead of direct DOM manipulation",
        "Return false from onSubmit to prevent submission",
        "Avoid synchronous server calls (use GlideAjax)",
        'Test on both desktop and mobile if ui_type is "both"',
      ],
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
