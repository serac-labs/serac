import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError } from "../../shared/error-handler.js"
import { btk } from "../../shared/builder-toolkit.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_discover_all_workspaces",
  description:
    "Discover all workspaces (UX Experiences via Builder Toolkit, Agent Workspaces, UI Builder pages) with comprehensive details.",
  category: "ui-frameworks",
  subcategory: "workspace",
  use_cases: ["workspace", "discovery", "analytics"],
  complexity: "beginner",
  frequency: "high",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      include_ux_experiences: {
        type: "boolean",
        default: true,
        description: "Include Now Experience Framework workspaces",
      },
      include_agent_workspaces: {
        type: "boolean",
        default: true,
        description: "Include Configurable Agent Workspaces",
      },
      include_ui_builder: {
        type: "boolean",
        default: true,
        description: "Include UI Builder pages",
      },
      active_only: {
        type: "boolean",
        default: true,
        description: "Only show active workspaces",
      },
    },
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const includeExperiences = args.include_ux_experiences !== false
  const includeAgentWorkspaces = args.include_agent_workspaces !== false
  const includeUIBuilder = args.include_ui_builder !== false
  const activeOnly = args.active_only !== false

  try {
    const client = await getAuthenticatedClient(context)

    const experiences: unknown[] = []
    const workspaces: unknown[] = []
    const pages: unknown[] = []

    if (includeExperiences) {
      try {
        const response = await client.get(btk("/pc_experiences"))
        const data = response.data?.result || response.data
        const items = Array.isArray(data) ? data : data?.experiences || []
        for (const exp of items) {
          experiences.push({
            type: "UX Experience",
            name: exp.name || exp.title,
            sys_id: exp.experienceID || exp.sys_id || exp.id,
            description: exp.description || "No description",
            path: exp.path || exp.url_path,
            active: exp.active !== false,
          })
        }
      } catch {
        experiences.push({ type: "UX Experience", error: "Builder Toolkit API not available" })
      }
    }

    if (includeAgentWorkspaces) {
      const query = activeOnly ? "active=true^route_type=workspace" : "route_type=workspace"
      const response = await client.get("/api/now/table/sys_ux_app_route", {
        params: {
          sysparm_query: query,
          sysparm_limit: 50,
          sysparm_fields: "sys_id,name,description,route,active",
        },
      })
      for (const route of response.data.result || []) {
        workspaces.push({
          type: "Agent Workspace",
          name: route.name,
          sys_id: route.sys_id,
          description: route.description || "No description",
          route: route.route,
          active: route.active,
        })
      }
    }

    if (includeUIBuilder) {
      const query = activeOnly ? "active=true" : ""
      const response = await client.get("/api/now/table/sys_ux_page", {
        params: {
          sysparm_query: query,
          sysparm_limit: 50,
          sysparm_fields: "sys_id,name,description,active",
        },
      })
      for (const page of response.data.result || []) {
        pages.push({
          type: "UI Builder Page",
          name: page.name,
          sys_id: page.sys_id,
          description: page.description || "No description",
          active: page.active,
        })
      }
    }

    const total = experiences.length + workspaces.length + pages.length

    return createSuccessResult({
      discovery: {
        ux_experiences: experiences,
        agent_workspaces: workspaces,
        ui_builder_pages: pages,
      },
      summary: {
        ux_experiences: experiences.length,
        agent_workspaces: workspaces.length,
        ui_builder_pages: pages.length,
        total_workspaces: total,
      },
      message: `Found ${total} workspaces across all types`,
    })
  } catch (error: unknown) {
    if (error instanceof SnowFlowError) return createErrorResult(error)
    return createErrorResult(error instanceof Error ? error.message : String(error))
  }
}

export const version = "2.0.0"
export const author = "Serac Builder Toolkit Migration"
