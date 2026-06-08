/**
 * snow_create_dashboard - Create dashboards
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_pa_dashboard",
  description: "Create a Performance Analytics dashboard with widgets (pa_dashboards table). For Service Portal / classic dashboards use snow_create_dashboard.",
  // Metadata for tool discovery (not sent to LLM)
  category: "reporting",
  subcategory: "dashboards",
  use_cases: ["dashboards", "visualization", "analytics"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Dashboard name" },
      description: { type: "string", description: "Dashboard description" },
      layout: {
        type: "string",
        description: "Dashboard layout (grid, tabs, accordion)",
        enum: ["grid", "tabs", "accordion"],
      },
      widgets: { type: "array", items: { type: "string" }, description: "Dashboard widgets configuration" },
      permissions: { type: "array", description: "User/role permissions", items: { type: "string" } },
      refresh_interval: { type: "number", description: "Auto-refresh interval in minutes" },
      public: { type: "boolean", description: "Public dashboard" },
    },
    required: ["name", "widgets"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    description,
    layout = "grid",
    widgets = [],
    permissions = [],
    refresh_interval = 15,
    public: isPublic = false,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Create dashboard using pa_dashboards table
    const dashboardData: any = {
      name,
      title: name,
      description: description || "",
      layout,
      refresh_interval,
      active: true,
      roles: permissions.join(","),
      public: isPublic,
    }

    const response = await client.post("/api/now/table/pa_dashboards", dashboardData)

    if (!response.data.result) {
      return createErrorResult("Failed to create dashboard")
    }

    const dashboardId = response.data.result.sys_id

    // Add widgets to dashboard if provided
    if (widgets.length > 0) {
      for (const widget of widgets) {
        await client.post("/api/now/table/pa_widgets", {
          dashboard: dashboardId,
          title: widget.name || widget.title,
          type: widget.type || "chart",
          order: widget.order || 0,
          ...widget,
        })
      }
    }

    return createSuccessResult({
      created: true,
      dashboard: response.data.result,
      widgets_added: widgets.length,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
