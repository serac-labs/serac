/**
 * snow_create_related_list
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_related_list",
  description: "Surface a related table under a parent table's form view (sys_ui_related_list) — e.g. show related Tasks below an Incident. Use relationship_field for non-standard joins.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "ui",
  use_cases: ["lists", "relationships", "forms"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Related list name" },
      parent_table: { type: "string", description: "Parent table" },
      related_table: { type: "string", description: "Related table" },
      relationship_field: { type: "string", description: "Field linking tables" },
    },
    required: ["name", "parent_table", "related_table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, parent_table, related_table, relationship_field } = args
  try {
    const client = await getAuthenticatedClient(context)
    const relatedListData: any = {
      name,
      parent: parent_table,
      related: related_table,
    }
    if (relationship_field) relatedListData.relationship = relationship_field
    const response = await client.post("/api/now/table/sys_ui_related_list", relatedListData)
    return createSuccessResult({ created: true, related_list: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
