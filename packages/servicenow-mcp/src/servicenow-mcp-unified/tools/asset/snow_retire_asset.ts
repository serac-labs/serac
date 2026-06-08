/**
 * snow_retire_asset
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_retire_asset",
  description: "Mark an asset as retired (install_status=7) on alm_asset, optionally recording a retirement date and disposal reason. End-of-lifecycle counterpart to procurement/transfer flows.",
  // Metadata for tool discovery (not sent to LLM)
  category: "asset-management",
  subcategory: "asset-lifecycle",
  use_cases: ["asset-management", "retirement", "lifecycle"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      asset_sys_id: { type: "string" },
      retirement_date: { type: "string" },
      disposal_reason: { type: "string" },
    },
    required: ["asset_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { asset_sys_id, retirement_date, disposal_reason } = args
  try {
    const client = await getAuthenticatedClient(context)
    const retireData: any = { install_status: "7" } // Retired
    if (retirement_date) retireData.retirement_date = retirement_date
    if (disposal_reason) retireData.disposal_reason = disposal_reason
    const response = await client.put(`/api/now/table/alm_asset/${asset_sys_id}`, retireData)
    return createSuccessResult({ retired: true, asset: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
