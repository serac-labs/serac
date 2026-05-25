/**
 * snow_create_dashboard
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_dashboard",
  description: "Create a new sys_dashboard with a title, optional description, column count (default 2), and active flag. Widgets are added separately with snow_add_dashboard_widget.",
  // Metadata for tool discovery (not sent to LLM)
  category: "reporting",
  subcategory: "dashboards",
  use_cases: ["dashboards", "reporting", "visualization"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Dashboard title" },
      description: { type: "string", description: "Dashboard description" },
      columns: { type: "number", default: 2, description: "Number of columns" },
      active: { type: "boolean", default: true },
    },
    required: ["title"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { title, description, columns = 2, active = true } = args
  try {
    const client = await getAuthenticatedClient(context)
    const dashboardData: any = { title, columns, active }
    if (description) dashboardData.description = description
    const response = await client.post("/api/now/table/sys_dashboard", dashboardData)
    return createSuccessResult({ created: true, dashboard: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
