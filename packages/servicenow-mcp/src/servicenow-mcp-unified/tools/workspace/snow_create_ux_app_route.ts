/**
 * snow_create_ux_app_route - Create UX app route
 *
 * STEP 5: Create Route Record (sys_ux_app_route) -
 * Defines the URL slug that leads to the page.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_ux_app_route",
  description: "STEP 5: Create Route Record (sys_ux_app_route) - Defines the URL slug that leads to the page.",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-frameworks",
  subcategory: "workspace",
  use_cases: ["workspace", "routing", "url"],
  complexity: "beginner",
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
        description: 'Route name - becomes URL slug (e.g., "home")',
      },
      app_config_sys_id: {
        type: "string",
        description: "App config sys_id from Step 2 (optional)",
      },
      experience_sys_id: {
        type: "string",
        description: "Experience sys_id (alternative to app_config_sys_id)",
      },
      page_sys_name: {
        type: "string",
        description: "Page sys_name from Step 4 registry (optional)",
      },
      route: {
        type: "string",
        description: 'URL route path (e.g., "/home")',
      },
      description: {
        type: "string",
        description: "Route description",
      },
    },
    required: ["name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, app_config_sys_id, experience_sys_id, page_sys_name, route, description } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Create route
    const routeData: any = {
      name,
      route: route || `/${name.toLowerCase().replace(/\s+/g, "-")}`,
      description: description || `Route for ${name}`,
      active: true,
    }

    if (app_config_sys_id) {
      routeData.app_config = app_config_sys_id
    }

    if (experience_sys_id) {
      routeData.experience = experience_sys_id
    }

    if (page_sys_name) {
      routeData.page_sys_name = page_sys_name
    }

    const response = await client.post("/api/now/table/sys_ux_app_route", routeData)
    const appRoute = response.data.result

    return createSuccessResult({
      created: true,
      route_sys_id: appRoute.sys_id,
      name: appRoute.name,
      route: appRoute.route,
      page_sys_name: appRoute.page_sys_name || null,
      full_url: `/now/experience${appRoute.route}`,
      message: `UX App Route '${name}' created successfully`,
      next_step: "Update App Config landing page (Step 6) using snow_update_ux_app_config_landing_page",
    })
  } catch (error: any) {
    return createErrorResult(error instanceof SnowFlowError ? error : error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
