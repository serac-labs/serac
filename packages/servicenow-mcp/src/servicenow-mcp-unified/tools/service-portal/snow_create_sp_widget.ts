/**
 * snow_create_sp_widget - Create Service Portal widget
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_sp_widget",
  description: "Create a Service Portal widget (sp_widget) bundling AngularJS template, client_script, server_script, and CSS under a stable id. Widgets are placed on pages via the portal page editor.",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-frameworks",
  subcategory: "service-portal",
  use_cases: ["portal-widgets", "service-portal", "widget-creation"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      template: { type: "string" },
      client_script: { type: "string" },
      server_script: { type: "string" },
      css: { type: "string" },
    },
    required: ["id", "name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { id, name, template, client_script, server_script, css } = args
  try {
    const client = await getAuthenticatedClient(context)
    const widgetData: any = { id, name }
    if (template) widgetData.template = template
    if (client_script) widgetData.client_script = client_script
    if (server_script) widgetData.script = server_script
    if (css) widgetData.css = css
    const response = await client.post("/api/now/table/sp_widget", widgetData)
    return createSuccessResult({ created: true, widget: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
