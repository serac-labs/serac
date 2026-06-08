/**
 * snow_create_variable
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_variable",
  description: "Add a question variable to a catalog item: name, question text, input type (string, multi_line_text, select_box, checkbox, reference), mandatory flag, and display order. Writes to item_option_new under the given cat_item.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "catalog",
  use_cases: ["catalog-variables", "service-catalog", "form-fields"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      cat_item: { type: "string", description: "Catalog item sys_id to attach this variable to" },
      name: { type: "string", description: "Variable name" },
      question_text: { type: "string", description: "Question text" },
      type: {
        type: "string",
        enum: ["string", "multi_line_text", "select_box", "checkbox", "reference"],
        default: "string",
      },
      mandatory: { type: "boolean", default: false },
      order: { type: "number", description: "Display order" },
    },
    required: ["name", "question_text", "cat_item"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const client = await getAuthenticatedClient(context)
    const data: Record<string, unknown> = {
      name: args.name,
      question_text: args.question_text,
      type: args.type || "string",
      mandatory: args.mandatory || false,
      cat_item: args.cat_item,
    }
    if (args.order !== undefined) data.order = args.order
    const response = await client.post("/api/now/table/item_option_new", data)
    return createSuccessResult({ created: true, variable: response.data.result })
  } catch (error: unknown) {
    return createErrorResult(error instanceof Error ? error.message : String(error))
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
