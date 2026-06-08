/**
 * snow_configure_offline_sync - Configure mobile offline sync
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_configure_offline_sync",
  description:
    "Configure offline synchronization settings for mobile applications. Controls which data is available offline.",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-frameworks",
  subcategory: "mobile",
  use_cases: ["offline-sync", "mobile", "data-sync"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Table name for offline sync",
      },
      enabled: {
        type: "boolean",
        description: "Enable offline sync for this table",
        default: true,
      },
      sync_frequency: {
        type: "string",
        description: "Sync frequency: manual, hourly, daily, on_launch",
      },
      query: {
        type: "string",
        description: "Query filter for synced records",
      },
      max_records: {
        type: "number",
        description: "Maximum records to sync",
        default: 100,
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Specific fields to sync (all if not specified)",
      },
    },
    required: ["table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, enabled = true, sync_frequency, query, max_records = 100, fields } = args

  try {
    const client = await getAuthenticatedClient(context)

    const syncConfig: any = {
      table,
      enabled,
      max_records,
    }

    if (sync_frequency) syncConfig.sync_frequency = sync_frequency
    if (query) syncConfig.query = query
    if (fields && fields.length > 0) syncConfig.fields = fields.join(",")

    const response = await client.post("/api/now/table/sys_mobile_offline_config", syncConfig)

    return createSuccessResult({
      configured: true,
      config: response.data.result,
      table,
      enabled,
      max_records,
      message: `✅ Offline sync configured for table: ${table}`,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
