/**
 * snow_create_configurable_agent_workspace - Create agent workspace
 *
 * Create Configurable Agent Workspace using UX App architecture
 * (sys_ux_app_route, sys_ux_screen_type). Creates workspace with
 * screen collections for multiple tables.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_configurable_agent_workspace",
  description:
    "Create Configurable Agent Workspace using UX App architecture (sys_ux_app_route, sys_ux_screen_type). Creates workspace with screen collections for multiple tables.",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-frameworks",
  subcategory: "workspace",
  use_cases: ["workspace", "agent", "screen-collections"],
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
        description: "Agent workspace name",
      },
      description: {
        type: "string",
        description: "Workspace description",
      },
      tables: {
        type: "array",
        items: { type: "string" },
        description: 'Tables for screen collections (e.g., ["incident", "task"])',
      },
      application: {
        type: "string",
        default: "global",
        description: "Application scope",
      },
    },
    required: ["name", "tables"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, description, tables, application = "global" } = args

  try {
    const client = await getAuthenticatedClient(context)

    const results = {
      workspace_name: name,
      screen_types: [] as any[],
      app_route_sys_id: "",
    }

    // Create App Route for workspace
    const routeName = name.toLowerCase().replace(/\s+/g, "-")
    const appRouteData = {
      name: routeName,
      route: `/${routeName}`,
      route_type: "workspace",
      description: description || `Agent workspace: ${name}`,
      application: application,
      active: true,
    }

    const appRouteResponse = await client.post("/api/now/table/sys_ux_app_route", appRouteData)
    results.app_route_sys_id = appRouteResponse.data.result.sys_id

    // Create Screen Collections for each table
    for (const table of tables) {
      const screenTypeData = {
        name: `${name} - ${capitalizeTableName(table)}`,
        table: table,
        app_route: results.app_route_sys_id,
        description: `Screen collection for ${table}`,
        active: true,
      }

      const screenTypeResponse = await client.post("/api/now/table/sys_ux_screen_type", screenTypeData)
      results.screen_types.push({
        table: table,
        sys_id: screenTypeResponse.data.result.sys_id,
        name: screenTypeData.name,
      })
    }

    return createSuccessResult({
      created: true,
      workspace_name: name,
      workspace_type: "Configurable Agent Workspace",
      app_route_sys_id: results.app_route_sys_id,
      screen_types: results.screen_types,
      workspace_url: `/now/workspace${appRouteData.route}`,
      tables_configured: tables.length,
      message: `Agent Workspace '${name}' created successfully with ${tables.length} screen collections`,
      next_steps: [
        "Configure screen layouts for each table",
        "Add related lists and contextual panels",
        "Customize workspace navigation",
        "Assign workspace to roles/groups",
      ],
    })
  } catch (error: any) {
    return createErrorResult(error instanceof SnowFlowError ? error : error.message)
  }
}

function capitalizeTableName(tableName: string): string {
  return tableName.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
