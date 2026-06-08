/**
 * snow_create_purchase_order
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_purchase_order",
  description: "Open a purchase order (proc_po) against a vendor, with optional requested_by user and total_cost. Captures the buy-side step after a procurement request has been approved.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "procurement",
  use_cases: ["purchase-orders", "procurement", "vendor-management"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      vendor: { type: "string" },
      requested_by: { type: "string" },
      items: { type: "array", items: { type: "object" } },
      total_cost: { type: "number" },
    },
    required: ["vendor"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { vendor, requested_by, items, total_cost } = args
  try {
    const client = await getAuthenticatedClient(context)
    const poData: any = { vendor }
    if (requested_by) poData.requested_by = requested_by
    if (total_cost) poData.total_cost = total_cost
    const response = await client.post("/api/now/table/proc_po", poData)
    return createSuccessResult({ created: true, purchase_order: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
