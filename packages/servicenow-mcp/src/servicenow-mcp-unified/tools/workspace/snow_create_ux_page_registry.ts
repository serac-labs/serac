/**
 * snow_create_ux_page_registry - Create page registry
 *
 * STEP 4: Create Page Registry Record (sys_ux_page_registry) -
 * Registers the page for use within the workspace configuration.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_ux_page_registry",
  description:
    "STEP 4: Create Page Registry Record (sys_ux_page_registry) - Registers the page for use within the workspace configuration.",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-frameworks",
  subcategory: "workspace",
  use_cases: ["workspace", "registry", "configuration"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      sys_name: {
        type: "string",
        description: 'Unique technical name for the page (e.g., "my_home_page")',
      },
      app_config_sys_id: {
        type: "string",
        description: "App config sys_id from Step 2",
      },
      macroponent_sys_id: {
        type: "string",
        description: "Macroponent sys_id from Step 3",
      },
      description: {
        type: "string",
        description: "Page registry description",
      },
    },
    required: ["sys_name", "app_config_sys_id", "macroponent_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_name, app_config_sys_id, macroponent_sys_id, description } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Validate app config exists
    const appConfigCheck = await client.get(`/api/now/table/sys_ux_app_config/${app_config_sys_id}`)
    if (!appConfigCheck.data.result) {
      throw new SnowFlowError(ErrorType.VALIDATION_ERROR, `App Config '${app_config_sys_id}' not found`, {
        details: { app_config_sys_id },
      })
    }

    // Validate macroponent exists
    const macroponentCheck = await client.get(`/api/now/table/sys_ux_macroponent/${macroponent_sys_id}`)
    if (!macroponentCheck.data.result) {
      throw new SnowFlowError(ErrorType.VALIDATION_ERROR, `Macroponent '${macroponent_sys_id}' not found`, {
        details: { macroponent_sys_id },
      })
    }

    // Create page registry
    const registryData = {
      sys_name,
      app_config: app_config_sys_id,
      macroponent: macroponent_sys_id,
      description: description || `Page registry for ${sys_name}`,
      active: true,
    }

    const response = await client.post("/api/now/table/sys_ux_page_registry", registryData)
    const registry = response.data.result

    return createSuccessResult({
      created: true,
      registry_sys_id: registry.sys_id,
      sys_name: registry.sys_name,
      app_config_sys_id,
      macroponent_sys_id,
      message: `Page Registry '${sys_name}' created successfully`,
      next_step: "Create Route (Step 5) using snow_create_ux_app_route",
    })
  } catch (error: any) {
    return createErrorResult(error instanceof SnowFlowError ? error : error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
