import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError } from "../../shared/error-handler.js"
import { btk, getAppShellUI } from "../../shared/builder-toolkit.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_complete_workspace",
  description:
    "Create Complete UX Workspace - Executes all steps automatically: Experience (Builder Toolkit) → App Config → Page → List Configuration → Route. Creates a fully functional workspace.",
  category: "ui-frameworks",
  subcategory: "workspace",
  use_cases: ["workspace", "ux-experience", "complete-setup"],
  complexity: "intermediate",
  frequency: "high",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      workspace_name: {
        type: "string",
        description: "Workspace name (used for all components)",
      },
      description: {
        type: "string",
        description: "Workspace description",
      },
      home_page_name: {
        type: "string",
        default: "home",
        description: 'Home page name (default: "home")',
      },
      route_name: {
        type: "string",
        description: "URL route name (auto-generated from workspace name if not provided)",
      },
      tables: {
        type: "array",
        items: { type: "string" },
        description: 'Tables for list configuration (e.g., ["incident", "task"])',
      },
      roles: {
        type: "array",
        items: { type: "string" },
        description: "Role sys_ids required to access this workspace",
      },
    },
    required: ["workspace_name"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const client = await getAuthenticatedClient(context)

    const name = args.workspace_name as string
    const description = (args.description as string) || `Complete UX workspace: ${name}`
    const tables = (args.tables as string[]) || []
    const roles = (args.roles as string[]) || []
    const path = (args.route_name as string) || name.toLowerCase().replace(/\s+/g, "-")
    const homepage = (args.home_page_name as string) || "home"

    const completed: string[] = []
    const ids: Record<string, unknown> = {}

    const appShellUI = await getAppShellUI(client)
    const expResponse = await client.post(btk("/experience"), {
      name,
      appShellUI,
      path,
      homepage,
      roles,
    })
    const expResult = expResponse.data?.result || expResponse.data
    const experienceId = expResult.experienceID || expResult.experience_id || expResult.sys_id
    if (!experienceId) return createErrorResult("Experience created but no experienceID returned")
    completed.push("UX Experience Created (Builder Toolkit)")
    ids.experience_sys_id = experienceId

    const appConfigResponse = await client.post("/api/now/table/sys_ux_app_config", {
      name: `${name} Config`,
      experience_assoc: experienceId,
      description: `App configuration for ${name}`,
      active: true,
    })
    const appConfigId = appConfigResponse.data.result.sys_id
    completed.push("App Configuration Created")
    ids.app_config_sys_id = appConfigId

    const pageResponse = await client.post(btk(`/page?experienceId=${experienceId}`), {
      screen: {
        name: homepage,
        screenType: "",
        macroponent: null,
        disableAutoReflow: false,
      },
      route: {
        name: homepage,
        routeType: "template-sow",
        fields: ["table", "sysId"],
        optionalParameters: ["query", "extraParams", "views", "selectedTab"],
      },
      applicabilities: [],
      templateId: "",
      macroponent: {},
    })
    const pageResult = pageResponse.data?.result || pageResponse.data
    completed.push("Home Page Created (Builder Toolkit)")
    ids.page = pageResult

    if (tables.length > 0) {
      const listMenuResponse = await client.post("/api/now/table/sys_ux_list_menu_config", {
        name: `${name} List Menu`,
        experience: experienceId,
        description: `List menu for ${name}`,
        active: true,
      })
      const listMenuId = listMenuResponse.data.result.sys_id
      ids.list_menu_config_sys_id = listMenuId

      const categories: Array<{ table: string; sys_id: string }> = []
      for (const table of tables) {
        const catResponse = await client.post("/api/now/table/sys_ux_list_category", {
          name: capitalize(table),
          list_menu_config: listMenuId,
          table,
          order: tables.indexOf(table) * 100,
          active: true,
        })
        categories.push({ table, sys_id: catResponse.data.result.sys_id })

        await client.post("/api/now/table/sys_ux_list", {
          name: `All ${capitalize(table)}`,
          category: catResponse.data.result.sys_id,
          table,
          filter: "",
          order: 100,
          active: true,
        })
      }
      completed.push("List Configuration Created")
      ids.list_categories = categories
    }

    return createSuccessResult({
      workspace_name: name,
      workspace_type: "Now Experience Framework Workspace",
      all_steps_completed: true,
      steps_completed: completed,
      sys_ids: ids,
      workspace_url: `/now/${path}`,
      message: `UX Workspace '${name}' created successfully via Builder Toolkit API`,
    })
  } catch (error: unknown) {
    if (error instanceof SnowFlowError) return createErrorResult(error)
    return createErrorResult(error instanceof Error ? error.message : String(error))
  }
}

function capitalize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
}

export const version = "2.0.0"
export const author = "Serac Builder Toolkit Migration"
