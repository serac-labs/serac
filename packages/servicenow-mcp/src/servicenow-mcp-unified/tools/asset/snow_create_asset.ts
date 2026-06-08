/**
 * snow_create_asset - Create asset
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_asset",
  description: "Create hardware/software asset",
  // Metadata for tool discovery (not sent to LLM)
  category: "asset-management",
  subcategory: "asset-lifecycle",
  use_cases: ["asset-management", "creation", "alm"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      asset_tag: { type: "string" },
      ci: { type: "string" },
      model_category: { type: "string" },
      assigned_to: { type: "string" },
    },
    required: ["asset_tag"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { asset_tag, ci, model_category, assigned_to } = args
  try {
    const client = await getAuthenticatedClient(context)
    const assetData: any = { asset_tag }
    if (ci) assetData.ci = ci
    if (model_category) assetData.model_category = model_category
    if (assigned_to) assetData.assigned_to = assigned_to
    const response = await client.post("/api/now/table/alm_asset", assetData)
    return createSuccessResult({ created: true, asset: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
