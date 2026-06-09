/**
 * snow_create_ux_page_macroponent - Create page macroponent
 *
 * STEP 3: Create Page Macroponent Record (sys_ux_macroponent) -
 * Defines the actual page content that will be displayed.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_ux_page_macroponent",
  description:
    "STEP 3: Create Page Macroponent Record (sys_ux_macroponent) - Defines the actual page content that will be displayed.",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-frameworks",
  subcategory: "workspace",
  use_cases: ["workspace", "page", "macroponent"],
  complexity: "intermediate",
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
        description: 'Page macroponent name (e.g., "My Home Page")',
      },
      root_component: {
        type: "string",
        default: "sn-canvas-panel",
        description: "Root component to render (default: sn-canvas-panel for simple pages)",
      },
      composition: {
        type: "object",
        description: "JSON layout configuration (default: simple single column)",
      },
      description: {
        type: "string",
        description: "Page macroponent description",
      },
    },
    required: ["name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, root_component = "sn-canvas-panel", composition, description } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Default simple composition if not provided
    const defaultComposition = {
      layout: "single-column",
      components: [],
    }

    // Create macroponent
    const macroponentData = {
      name,
      root_component,
      composition: JSON.stringify(composition || defaultComposition),
      description: description || `Page macroponent: ${name}`,
      active: true,
    }

    const response = await client.post("/api/now/table/sys_ux_macroponent", macroponentData)
    const macroponent = response.data.result

    return createSuccessResult({
      created: true,
      macroponent_sys_id: macroponent.sys_id,
      name: macroponent.name,
      root_component: macroponent.root_component,
      message: `Page Macroponent '${name}' created successfully`,
      next_step: "Create Page Registry (Step 4) using snow_create_ux_page_registry",
    })
  } catch (error: any) {
    return createErrorResult(error instanceof SnowFlowError ? error : error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
