/**
 * snow_create_catalog_item - Create service catalog item
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_catalog_item",
  description: "Publish a Service Catalog item (sc_cat_item) with name, short/long descriptions, category, and price. The item becomes orderable; attach question variables with snow_create_catalog_variable.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "service-catalog",
  use_cases: ["catalog", "create", "service-catalog"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      short_description: { type: "string" },
      description: { type: "string" },
      category: { type: "string" },
      price: { type: "string" },
    },
    required: ["name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, short_description, description, category, price } = args
  try {
    const client = await getAuthenticatedClient(context)
    const itemData: any = { name, short_description, description }
    if (category) itemData.category = category
    if (price) itemData.price = price
    const response = await client.post("/api/now/table/sc_cat_item", itemData)
    return createSuccessResult({ created: true, catalog_item: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
