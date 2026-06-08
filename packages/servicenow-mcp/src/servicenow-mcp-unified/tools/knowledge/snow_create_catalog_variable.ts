/**
 * snow_create_catalog_variable - Catalog item variable
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_catalog_variable",
  description: "Add an input variable to a catalog item (item_option_new) with name, question text, and input type (single/multi-line text, multiple_choice, select_box). Mostly equivalent to snow_create_variable but with a narrower type list.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "service-catalog",
  use_cases: ["catalog", "variables", "forms"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      cat_item: { type: "string" },
      name: { type: "string" },
      question_text: { type: "string" },
      type: { type: "string", enum: ["single_line_text", "multi_line_text", "multiple_choice", "select_box"] },
    },
    required: ["cat_item", "name", "question_text", "type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { cat_item, name, question_text, type } = args
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.post("/api/now/table/item_option_new", {
      cat_item,
      name,
      question_text,
      type,
    })
    return createSuccessResult({ created: true, variable: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
