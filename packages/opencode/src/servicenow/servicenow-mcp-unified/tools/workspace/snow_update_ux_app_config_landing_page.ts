import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_update_ux_app_config_landing_page",
  description: "Update App Configuration with Landing Page Route - Sets the default landing page for the workspace.",
  category: "ui-frameworks",
  subcategory: "workspace",
  use_cases: ["workspace", "configuration", "landing-page"],
  complexity: "beginner",
  frequency: "low",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      app_config_sys_id: {
        type: "string",
        description: "App config sys_id from Step 2",
      },
      route_name: {
        type: "string",
        description: "Route name to set as landing page",
      },
    },
    required: ["app_config_sys_id", "route_name"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const client = await getAuthenticatedClient(context)

    const configId = args.app_config_sys_id as string
    const routeName = args.route_name as string

    const check = await client.get(`/api/now/table/sys_ux_app_config/${configId}`).catch(() => null)
    if (!check?.data?.result) {
      return createErrorResult(
        new SnowFlowError(ErrorType.NOT_FOUND, `App Config '${configId}' not found. Verify the sys_id is correct.`, {
          details: { app_config_sys_id: configId },
        }),
      )
    }

    const response = await client.patch(`/api/now/table/sys_ux_app_config/${configId}`, {
      landing_page: routeName,
    })
    const config = response.data.result

    return createSuccessResult({
      updated: true,
      app_config_sys_id: config.sys_id,
      landing_page: config.landing_page,
      message: `App Configuration landing page set to '${routeName}'`,
      workspace_complete: true,
    })
  } catch (error: unknown) {
    if (error instanceof SnowFlowError) return createErrorResult(error)
    return createErrorResult(error instanceof Error ? error.message : String(error))
  }
}

export const version = "2.0.0"
export const author = "Serac Builder Toolkit Migration"
