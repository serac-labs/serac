import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError } from "../../shared/error-handler.js"
import { btk, getAppShellUI } from "../../shared/builder-toolkit.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_workspace",
  description: "Create complete Agent Workspace with experience, config, routes, and lists via Builder Toolkit API",
  category: "workspace",
  subcategory: "creation",
  use_cases: ["workspace", "agent-workspace", "creation"],
  complexity: "advanced",
  frequency: "low",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'Workspace name (e.g., "IT Support Workspace")',
      },
      description: {
        type: "string",
        description: "Workspace description",
      },
      tables: {
        type: "array",
        items: { type: "string" },
        description: 'Tables to include in workspace (e.g., ["incident", "task"])',
        default: [],
      },
      roles: {
        type: "array",
        items: { type: "string" },
        description: "Required roles to access workspace",
        default: [],
      },
    },
    required: ["name"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const client = await getAuthenticatedClient(context)

    const name = args.name as string
    const description = (args.description as string) || ""
    const tables = (args.tables as string[]) || []
    const roles = (args.roles as string[]) || []
    const path = name.toLowerCase().replace(/\s+/g, "-")

    const components: Record<string, unknown> = {}

    const appShellUI = await getAppShellUI(client)
    const expResponse = await client.post(btk("/experience"), {
      name,
      appShellUI,
      path,
      homepage: "home",
      roles,
    })
    const expResult = expResponse.data?.result || expResponse.data
    const experienceId = expResult.experienceID || expResult.experience_id || expResult.sys_id
    if (!experienceId) return createErrorResult("Experience created but no experienceID returned")
    components.experience_id = experienceId

    const appConfigResponse = await client.post("/api/now/table/sys_ux_app_config", {
      name: `${name} Config`,
      experience_assoc: experienceId,
      description,
    })
    components.app_config_id = appConfigResponse.data.result.sys_id

    const routeResponse = await client.post("/api/now/table/sys_ux_app_route", {
      experience: experienceId,
      route: `/workspace/${path}`,
      roles: roles.join(","),
    })
    components.route_id = routeResponse.data.result.sys_id
    const routePath = routeResponse.data.result.route || `/workspace/${path}`

    const lists: string[] = []
    for (const table of tables) {
      const listResponse = await client.post("/api/now/table/sys_ux_list", {
        name: `${table} List`,
        table,
        experience: experienceId,
      })
      lists.push(listResponse.data.result.sys_id)
    }
    components.list_ids = lists

    return createSuccessResult({
      workspace: {
        sys_id: experienceId,
        name,
        url: `${context.instanceUrl}${routePath}`,
        tables_configured: tables.length,
      },
      components,
    })
  } catch (error: unknown) {
    if (error instanceof SnowFlowError) return createErrorResult(error)
    return createErrorResult(error instanceof Error ? error.message : String(error))
  }
}

export const version = "2.0.0"
export const author = "Serac Builder Toolkit Migration"
