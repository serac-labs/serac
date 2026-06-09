/**
 * snow_track_asset_lifecycle - Track complete asset lifecycle from procurement to disposal
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_track_asset_lifecycle",
  description: "Track complete asset lifecycle from procurement to disposal",
  // Metadata for tool discovery (not sent to LLM)
  category: "asset-management",
  subcategory: "asset-lifecycle",
  use_cases: ["lifecycle", "tracking", "audit-trail"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Tracking function - updates asset lifecycle state
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      asset_sys_id: { type: "string", description: "Asset sys_id to track" },
      action: {
        type: "string",
        description: "Lifecycle action",
        enum: ["procure", "receive", "deploy", "transfer", "retire", "dispose"],
      },
      reason: { type: "string", description: "Reason for lifecycle change" },
      user_sys_id: { type: "string", description: "User performing the action" },
      notes: { type: "string", description: "Additional notes" },
    },
    required: ["asset_sys_id", "action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { asset_sys_id, action, reason, user_sys_id, notes } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Get current asset state
    const assetResponse = await client.get(`/api/now/table/alm_asset/${asset_sys_id}`)
    if (!assetResponse.data.result) {
      return createErrorResult(`Asset ${asset_sys_id} not found`)
    }

    const asset = assetResponse.data.result

    // Update asset state based on action
    const stateMapping: Record<string, string> = {
      procure: "on_order",
      receive: "in_stock",
      deploy: "deployed",
      transfer: "deployed", // Stays deployed, just changes assignment
      retire: "retired",
      dispose: "disposed",
    }

    const newState = stateMapping[action]

    if (newState && newState !== asset.state) {
      await client.patch(`/api/now/table/alm_asset/${asset_sys_id}`, {
        state: newState,
      })
    }

    // Create audit trail entry
    await client.post("/api/now/table/alm_audit", {
      asset: asset_sys_id,
      action,
      state: newState || asset.state,
      user: user_sys_id || "system",
      reason: reason || `Asset ${action} via Serac automation`,
      notes: notes || "",
      timestamp: new Date().toISOString(),
    })

    return createSuccessResult({
      asset_tag: asset.asset_tag,
      display_name: asset.display_name,
      action,
      previous_state: asset.state,
      new_state: newState || asset.state,
      reason: reason || `Automated via Serac`,
      notes,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
