/**
 * snow_discover_mobile_configs - Discover mobile configurations
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_discover_mobile_configs",
  description: "Discovers mobile application configurations including layouts, actions, and offline sync settings.",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "discovery",
  use_cases: ["discovery", "mobile-config", "mobile"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Discovery operation - reads metadata
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      config_type: {
        type: "string",
        description: "Configuration type: layout, action, offline_sync, all",
      },
      table: {
        type: "string",
        description: "Filter by table name",
      },
      active_only: {
        type: "boolean",
        description: "Show only active configurations",
        default: true,
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { config_type = "all", table, active_only = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    const results: any = {
      layouts: [],
      actions: [],
      offline_sync: [],
    }

    // Build query filters
    let queryFilter = ""
    if (table) queryFilter = `table=${table}`
    if (active_only && queryFilter) queryFilter += "^active=true"
    else if (active_only) queryFilter = "active=true"

    const queryParam = queryFilter ? `sysparm_query=${queryFilter}&` : ""

    // Fetch layouts
    if (config_type === "all" || config_type === "layout") {
      try {
        const layoutsResponse = await client.get(`/api/now/table/sys_ui_mobile_layout?${queryParam}sysparm_limit=50`)
        results.layouts = layoutsResponse.data.result || []
      } catch (err) {
        // Table might not exist, continue
      }
    }

    // Fetch actions
    if (config_type === "all" || config_type === "action") {
      try {
        const actionsResponse = await client.get(`/api/now/table/sys_ui_mobile_action?${queryParam}sysparm_limit=50`)
        results.actions = actionsResponse.data.result || []
      } catch (err) {
        // Table might not exist, continue
      }
    }

    // Fetch offline sync configs
    if (config_type === "all" || config_type === "offline_sync") {
      try {
        const syncResponse = await client.get(`/api/now/table/sys_mobile_offline_config?${queryParam}sysparm_limit=50`)
        results.offline_sync = syncResponse.data.result || []
      } catch (err) {
        // Table might not exist, continue
      }
    }

    const totalCount = results.layouts.length + results.actions.length + results.offline_sync.length

    if (totalCount === 0) {
      return createSuccessResult({
        results,
        total_count: 0,
        message: "❌ No mobile configurations found",
      })
    }

    return createSuccessResult({
      results,
      counts: {
        layouts: results.layouts.length,
        actions: results.actions.length,
        offline_sync: results.offline_sync.length,
      },
      total_count: totalCount,
      message: `🔍 Found ${totalCount} mobile configuration(s)`,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
