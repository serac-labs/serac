/**
 * snow_create_import_set
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_import_set",
  description: "Create import set for data import",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "import-export",
  use_cases: ["import", "data-migration", "integration"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "Import set table name" },
      data: { type: "array", items: { type: "object" }, description: "Data to import" },
    },
    required: ["table", "data"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, data } = args
  try {
    const client = await getAuthenticatedClient(context)
    const importPromises = data.map((record: any) => client.post(`/api/now/import/${table}`, record))
    const results = await Promise.all(importPromises)
    return createSuccessResult({
      imported: true,
      count: results.length,
      import_set: results[0]?.data?.result?.import_set,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
