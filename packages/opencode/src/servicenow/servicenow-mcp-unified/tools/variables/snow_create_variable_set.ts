/**
 * snow_create_variable_set
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_variable_set",
  description: "Create a reusable variable set (item_option_new_set) — a grouping of catalog variables that can be attached to multiple catalog items, e.g. a shared 'Approver / Department' block.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "catalog",
  use_cases: ["variable-sets", "service-catalog", "form-templates"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Variable set title" },
      description: { type: "string", description: "Description" },
      internal_name: { type: "string", description: "Internal name" },
    },
    required: ["title", "internal_name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { title, description, internal_name } = args
  try {
    const client = await getAuthenticatedClient(context)
    const setData: any = { title, internal_name }
    if (description) setData.description = description
    const response = await client.post("/api/now/table/item_option_new_set", setData)
    return createSuccessResult({ created: true, variable_set: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
