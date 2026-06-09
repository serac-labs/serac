/**
 * snow_configure_uib_data_broker - Configure data brokers
 *
 * Updates configuration for existing data brokers including queries,
 * caching, and refresh settings.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_configure_uib_data_broker",
  description: "Update data broker configuration including queries, caching, and refresh settings",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-builder",
  subcategory: "data-integration",
  use_cases: ["ui-builder", "data", "configuration"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      data_broker_id: {
        type: "string",
        description: "Data broker sys_id to configure",
      },
      query: {
        type: "string",
        description: "Query string for data retrieval",
      },
      refresh_interval: {
        type: "number",
        description: "Refresh interval in seconds",
      },
      enable_caching: {
        type: "boolean",
        description: "Enable data caching",
      },
      cache_duration: {
        type: "number",
        description: "Cache duration in seconds",
      },
      parameters: {
        type: "object",
        description: "Data broker parameters",
      },
      filters: {
        type: "array",
        items: { type: "object" },
        description: "Data filters",
      },
    },
    required: ["data_broker_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { data_broker_id, query, refresh_interval, enable_caching, cache_duration, parameters, filters } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Build update payload
    const payload: any = {}
    if (query !== undefined) payload.query = query
    if (refresh_interval !== undefined) payload.refresh_interval = refresh_interval
    if (enable_caching !== undefined) payload.enable_caching = enable_caching
    if (cache_duration !== undefined) payload.cache_duration = cache_duration
    if (parameters !== undefined) payload.parameters = JSON.stringify(parameters)
    if (filters !== undefined) payload.filters = JSON.stringify(filters)

    const response = await client.patch(`/api/now/table/sys_ux_data_broker/${data_broker_id}`, payload)

    return createSuccessResult({
      data_broker: {
        sys_id: response.data.result.sys_id,
        configured: true,
      },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
