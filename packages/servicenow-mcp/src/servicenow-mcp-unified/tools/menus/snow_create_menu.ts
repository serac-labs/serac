/**
 * snow_create_menu
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_menu",
  description: "Create a top-level application menu (sys_app_module) with title, owning application, and display order. Container for navigation items added via snow_create_menu_item.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "ui",
  use_cases: ["menu-creation", "navigation", "ui-development"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Menu title" },
      application: { type: "string", description: "Application sys_id" },
      order: { type: "number", description: "Menu order" },
      active: { type: "boolean", default: true },
    },
    required: ["title"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { title, application, order, active = true } = args
  try {
    const client = await getAuthenticatedClient(context)
    const menuData: any = { title, active }
    if (application) menuData.application = application
    if (order !== undefined) menuData.order = order
    const response = await client.post("/api/now/table/sys_app_module", menuData)
    return createSuccessResult({ created: true, menu: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
