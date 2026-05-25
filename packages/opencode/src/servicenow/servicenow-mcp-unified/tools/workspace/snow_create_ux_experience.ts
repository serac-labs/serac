import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { btk, getAppShellUI } from "../../shared/builder-toolkit.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_ux_experience",
  description:
    "Create UX Experience via Builder Toolkit API - The top-level container for a workspace. Returns experienceID used by all subsequent workspace steps.",
  category: "ui-frameworks",
  subcategory: "workspace",
  use_cases: ["workspace", "ux-experience", "foundation"],
  complexity: "beginner",
  frequency: "high",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'Experience name (e.g., "My Workspace")',
      },
      path: {
        type: "string",
        description: 'URL path slug (e.g., "my-workspace"). Auto-generated from name if not provided.',
      },
      homepage: {
        type: "string",
        description: 'Homepage route name (default: "home")',
      },
      roles: {
        type: "array",
        items: { type: "string" },
        description: "Role sys_ids required to access this experience",
      },
      app_shell_ui: {
        type: "string",
        description: "App shell macroponent sys_id (auto-detected if not provided)",
      },
    },
    required: ["name"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const client = await getAuthenticatedClient(context)

    const name = args.name as string
    const path = (args.path as string) || name.toLowerCase().replace(/\s+/g, "-")
    const homepage = (args.homepage as string) || "home"
    const roles = (args.roles as string[]) || []
    const appShellUI = (args.app_shell_ui as string) || (await getAppShellUI(client))

    const response = await client.post(btk("/experience"), {
      name,
      appShellUI,
      path,
      homepage,
      roles,
    })

    const result = response.data?.result || response.data
    const experienceId = result.experienceID || result.experience_id || result.sys_id

    if (!experienceId) {
      return createErrorResult(
        new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, "Experience created but no experienceID returned", {
          details: { response: result },
        }),
      )
    }

    return createSuccessResult({
      created: true,
      experience_sys_id: experienceId,
      name,
      path,
      homepage,
      app_shell_ui: appShellUI,
      message: `UX Experience '${name}' created successfully via Builder Toolkit API`,
      next_step: "Create App Configuration (Step 2) using snow_create_ux_app_config",
    })
  } catch (error: unknown) {
    if (error instanceof SnowFlowError) return createErrorResult(error)
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes("sn_uibtk_api") || msg.includes("404")) {
      return createErrorResult(
        new SnowFlowError(
          ErrorType.PLUGIN_MISSING,
          "Builder Toolkit API not available - UI Builder plugin may not be installed",
          {
            details: {
              plugin: "com.snc.ui_builder_toolkit",
              suggestion: "Install UI Builder from ServiceNow Store or verify the sn_uibtk_api scope is active",
            },
          },
        ),
      )
    }
    return createErrorResult(msg)
  }
}

export const version = "2.0.0"
export const author = "Serac Builder Toolkit Migration"
