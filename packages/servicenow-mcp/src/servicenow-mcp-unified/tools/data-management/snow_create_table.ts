/**
 * snow_create_table
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_table",
  description: "Create a new table (sys_db_object) with a name and label. Optionally extends a parent table (super_class) for inheritance, and toggles is_extendable. Add columns with snow_create_field.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "platform",
  use_cases: ["tables", "schema", "customization"],
  complexity: "advanced",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Table name" },
      label: { type: "string", description: "Table label" },
      extends_table: { type: "string", description: "Parent table to extend" },
      is_extendable: { type: "boolean", default: true },
    },
    required: ["name", "label"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, label, extends_table, is_extendable = true } = args
  try {
    const client = await getAuthenticatedClient(context)
    const tableData: any = { name, label, is_extendable }
    if (extends_table) tableData.super_class = extends_table
    const response = await client.post("/api/now/table/sys_db_object", tableData)
    return createSuccessResult({ created: true, table: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
