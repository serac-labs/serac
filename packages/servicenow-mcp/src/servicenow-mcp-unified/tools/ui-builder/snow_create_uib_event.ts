/**
 * snow_create_uib_event - Create custom events
 *
 * Creates custom events for UI Builder components to enable
 * component communication and interactions.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_uib_event",
  description: "Create custom events for UI Builder component communication",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-builder",
  subcategory: "events",
  use_cases: ["ui-builder", "events", "components"],
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
        description: "Event name",
      },
      description: {
        type: "string",
        description: "Event description",
      },
      payload_schema: {
        type: "object",
        description: "Event payload schema",
      },
      bubbles: {
        type: "boolean",
        description: "Event bubbles up the DOM",
        default: true,
      },
    },
    required: ["page_id", "name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { page_id, name, description = "", payload_schema = {}, bubbles = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    const payload: any = {
      page: page_id,
      name,
      description,
      bubbles,
    }

    if (Object.keys(payload_schema).length > 0) {
      payload.payload_schema = JSON.stringify(payload_schema)
    }

    const response = await client.post("/api/now/table/sys_ux_event", payload)

    return createSuccessResult({
      event: {
        sys_id: response.data.result.sys_id,
        name,
        page_id,
      },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
