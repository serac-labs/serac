import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { btk } from "../../shared/builder-toolkit.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_ux_app_config",
  description:
    "STEP 2: Create UX App Configuration Record (sys_ux_app_config) - Contains workspace settings and links to the experience from Step 1.",
  category: "ui-frameworks",
  subcategory: "workspace",
  use_cases: ["workspace", "configuration", "ux-experience"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'App config name (e.g., "My Workspace Config")',
      },
      experience_sys_id: {
        type: "string",
        description: "Experience sys_id from Step 1",
      },
      description: {
        type: "string",
        description: "App configuration description",
      },
      list_config_id: {
        type: "string",
        description: "List menu configuration sys_id (optional)",
      },
    },
    required: ["name", "experience_sys_id"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const client = await getAuthenticatedClient(context)

    const name = args.name as string
    const experienceId = args.experience_sys_id as string
    const description = (args.description as string) || `App configuration for ${name}`
    const listConfigId = args.list_config_id as string | undefined

    const experienceCheck = await client
      .get(btk("/experience"), {
        params: { experienceId },
      })
      .catch(() => null)

    if (!experienceCheck?.data) {
      return createErrorResult(
        new SnowFlowError(ErrorType.VALIDATION_ERROR, `Experience '${experienceId}' not found or not accessible`, {
          details: { experience_sys_id: experienceId },
        }),
      )
    }

    const payload: Record<string, unknown> = {
      name,
      experience_assoc: experienceId,
      description,
      active: true,
    }

    if (listConfigId) {
      payload.list_config_id = listConfigId
    }

    const response = await client.post("/api/now/table/sys_ux_app_config", payload)
    const config = response.data.result

    return createSuccessResult({
      created: true,
      app_config_sys_id: config.sys_id,
      name: config.name,
      experience_sys_id: experienceId,
      list_config_id: config.list_config_id || null,
      message: `UX App Configuration '${name}' created successfully`,
      next_step: "Create Page Macroponent (Step 3) using snow_create_ux_page_macroponent",
    })
  } catch (error: unknown) {
    if (error instanceof SnowFlowError) return createErrorResult(error)
    return createErrorResult(error instanceof Error ? error.message : String(error))
  }
}

export const version = "2.0.0"
export const author = "Serac Builder Toolkit Migration"
