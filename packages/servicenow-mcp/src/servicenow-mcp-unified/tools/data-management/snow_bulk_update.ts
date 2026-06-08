/**
 * snow_bulk_update
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_bulk_update",
  description: "Apply the same field updates to every record on a table matching an encoded query, up to a row limit (default 100). Issues one PATCH per matched record. Use carefully — this fires business rules and workflows for each row.",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "bulk-operations",
  use_cases: ["bulk-update", "data-management", "batch"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create/update/delete operation
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table name" },
      query: { type: "string", description: "Query to select records" },
      updates: { type: "object", description: "Fields to update" },
      limit: { type: "number", default: 100, description: "Max records to update" },
    },
    required: ["table", "query", "updates"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, query, updates, limit = 100 } = args
  try {
    const client = await getAuthenticatedClient(context)
    const getRecords = await client.get(`/api/now/table/${table}`, {
      params: { sysparm_query: query, sysparm_limit: limit },
    })

    const updatePromises = getRecords.data.result.map((record: any) =>
      client.patch(`/api/now/table/${table}/${record.sys_id}`, updates),
    )

    const results = await Promise.all(updatePromises)
    return createSuccessResult({
      updated: true,
      count: results.length,
      records: results.map((r) => r.data.result),
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
