/**
 * snow_debug_widget_fetch - Debug widget fetching
 *
 * Debug widget data fetching and server communication issues
 * in UI Builder pages.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_debug_widget_fetch",
  description: "Debug widget data fetching and server communication issues",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-builder",
  subcategory: "debugging",
  use_cases: ["ui-builder", "debugging", "widgets"],
  complexity: "advanced",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Debug function - fetches widget data for debugging
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      page_id: {
        type: "string",
        description: "Target page sys_id",
      },
      widget_name: {
        type: "string",
        description: "Widget name to debug",
      },
      trace_requests: {
        type: "boolean",
        description: "Trace HTTP requests",
        default: true,
      },
      log_level: {
        type: "string",
        description: "Log level (info, debug, warn, error)",
        default: "debug",
      },
    },
    required: ["page_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { page_id, widget_name, trace_requests = true, log_level = "debug" } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Get page elements
    const elementsResponse = await client.get("/api/now/table/sys_ux_page_element", {
      params: { sysparm_query: `page=${page_id}` },
    })
    const elements = elementsResponse.data.result

    // Get data brokers for the page
    const brokersResponse = await client.get("/api/now/table/sys_ux_data_broker", {
      params: { sysparm_query: `page=${page_id}` },
    })
    const brokers = brokersResponse.data.result

    // Build debug info
    const debugInfo: any = {
      page_id,
      total_elements: elements.length,
      total_brokers: brokers.length,
      elements: elements.map((el: any) => ({
        sys_id: el.sys_id,
        component: el.component,
        data_broker: el.data_broker || "none",
      })),
      brokers: brokers.map((broker: any) => ({
        sys_id: broker.sys_id,
        name: broker.name,
        table: broker.table,
        query: broker.query,
      })),
    }

    // Filter by widget if specified
    if (widget_name) {
      debugInfo.elements = debugInfo.elements.filter((el: any) => el.component.includes(widget_name))
    }

    return createSuccessResult(debugInfo)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
