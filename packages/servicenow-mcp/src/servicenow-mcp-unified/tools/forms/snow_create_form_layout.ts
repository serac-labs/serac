/**
 * snow_create_form_layout
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_form_layout",
  description: "Create a form layout (sys_ui_form) for a table and view, with layout type standard / related_list / split. Container for form sections — add sections with snow_create_form_section.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "forms",
  use_cases: ["forms", "ui", "layout"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Layout name" },
      table: { type: "string", description: "Table name" },
      view: { type: "string", description: "Form view" },
      type: { type: "string", enum: ["standard", "related_list", "split"], default: "standard" },
    },
    required: ["name", "table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, table, view, type = "standard" } = args
  try {
    const client = await getAuthenticatedClient(context)
    const layoutData: any = { name, table, type }
    if (view) layoutData.view = view
    const response = await client.post("/api/now/table/sys_ui_form", layoutData)
    return createSuccessResult({ created: true, layout: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
