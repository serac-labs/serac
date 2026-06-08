/**
 * snow_transfer_asset
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_transfer_asset",
  description: "Transfer asset to user/location",
  // Metadata for tool discovery (not sent to LLM)
  category: "asset-management",
  subcategory: "asset-lifecycle",
  use_cases: ["asset-management", "transfer", "relocation"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      asset_sys_id: { type: "string" },
      to_user: { type: "string" },
      to_location: { type: "string" },
    },
    required: ["asset_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { asset_sys_id, to_user, to_location } = args
  try {
    const client = await getAuthenticatedClient(context)
    const transferData: any = {}
    if (to_user) transferData.assigned_to = to_user
    if (to_location) transferData.location = to_location
    const response = await client.put(`/api/now/table/alm_asset/${asset_sys_id}`, transferData)
    return createSuccessResult({ transferred: true, asset: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
