/**
 * snow_create_uib_data_broker - Create data brokers
 *
 * Creates UI Builder data brokers for connecting pages to ServiceNow
 * data sources using official sys_ux_data_broker API.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_uib_data_broker",
  description: "Create data broker to connect UI Builder pages to ServiceNow data sources",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-builder",
  subcategory: "data-integration",
  use_cases: ["ui-builder", "data", "integration"],
  complexity: "intermediate",
  frequency: "high",

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
        description: "Data broker name",
      },
      table: {
        type: "string",
        description: "ServiceNow table to query",
      },
      query: {
        type: "string",
        description: "Query string for data retrieval",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Fields to retrieve",
        default: [],
      },
      order_by: {
        type: "string",
        description: "Order by field",
      },
      limit: {
        type: "number",
        description: "Maximum records to retrieve",
        default: 100,
      },
    },
    required: ["page_id", "name", "table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { page_id, name, table, query = "", fields = [], order_by, limit = 100 } = args

  try {
    const client = await getAuthenticatedClient(context)

    const payload: any = {
      page: page_id,
      name,
      table,
      query,
      limit,
    }

    if (fields.length > 0) payload.fields = fields.join(",")
    if (order_by) payload.order_by = order_by

    const response = await client.post("/api/now/table/sys_ux_data_broker", payload)

    return createSuccessResult({
      data_broker: {
        sys_id: response.data.result.sys_id,
        name,
        table,
        page_id,
      },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
