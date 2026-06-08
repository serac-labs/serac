/**
 * snow_create_choice
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_choice",
  description: "Create choice list value for field",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "platform",
  use_cases: ["choices", "fields", "customization"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table name" },
      element: { type: "string", description: "Field name" },
      value: { type: "string", description: "Choice value" },
      label: { type: "string", description: "Choice label" },
      sequence: { type: "number", description: "Display order" },
      inactive: { type: "boolean", default: false },
    },
    required: ["table", "element", "value", "label"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, element, value, label, sequence, inactive = false } = args
  try {
    const client = await getAuthenticatedClient(context)
    const choiceData: any = { name: table, element, value, label, inactive }
    if (sequence !== undefined) choiceData.sequence = sequence
    const response = await client.post("/api/now/table/sys_choice", choiceData)
    return createSuccessResult({ created: true, choice: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
