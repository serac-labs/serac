/**
 * snow_create_uib_client_script - Create client scripts
 *
 * Creates client-side JavaScript for UI Builder pages to handle
 * user interactions and page logic.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_uib_client_script",
  description: "Create client-side JavaScript for UI Builder pages",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-builder",
  subcategory: "scripting",
  use_cases: ["ui-builder", "scripts", "client-side"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      page_id: {
        type: "string",
        description: "Target page sys_id",
      },
      name: {
        type: "string",
        description: "Client script name",
      },
      script: {
        type: "string",
        description: "JavaScript code to execute",
      },
      event: {
        type: "string",
        description: 'Event trigger (e.g., "onLoad", "onChange")',
        default: "onLoad",
      },
      order: {
        type: "number",
        description: "Execution order",
        default: 100,
      },
      active: {
        type: "boolean",
        description: "Active state",
        default: true,
      },
    },
    required: ["page_id", "name", "script"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { page_id, name, script, event = "onLoad", order = 100, active = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    const response = await client.post("/api/now/table/sys_ux_client_script", {
      page: page_id,
      name,
      script,
      event,
      order,
      active,
    })

    return createSuccessResult({
      client_script: {
        sys_id: response.data.result.sys_id,
        name,
        event,
        page_id,
      },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
