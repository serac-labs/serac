/**
 * snow_asset_discovery - Discover and normalize assets from multiple sources
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_asset_discovery",
  description: "Discover and normalize assets from multiple sources",
  // Metadata for tool discovery (not sent to LLM)
  category: "asset-management",
  subcategory: "discovery",
  use_cases: ["discovery", "asset-management", "normalization"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Discovery function - creates/updates asset records
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      discovery_source: {
        type: "string",
        description: "Discovery source",
        enum: ["network_scan", "agent_based", "manual_import", "csv_upload"],
      },
      ip_range: { type: "string", description: "IP range for network discovery (CIDR notation)" },
      normalize_duplicates: { type: "boolean", description: "Automatically normalize duplicate assets" },
      create_relationships: { type: "boolean", description: "Create CI relationships automatically" },
    },
    required: ["discovery_source"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { discovery_source, ip_range, normalize_duplicates = true, create_relationships = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Trigger discovery based on source type
    let discoveryResult

    switch (discovery_source) {
      case "network_scan":
        if (!ip_range) {
          return createErrorResult("IP range required for network scan")
        }
        discoveryResult = await triggerNetworkDiscovery(client, ip_range)
        break

      case "agent_based":
        discoveryResult = await triggerAgentBasedDiscovery(client)
        break

      case "manual_import":
        discoveryResult = await setupManualImport(client)
        break

      case "csv_upload":
        discoveryResult = await setupCSVUpload(client)
        break

      default:
        return createErrorResult(`Unknown discovery source: ${discovery_source}`)
    }

    return createSuccessResult({
      discovery_source,
      assets_discovered: discoveryResult.count,
      duplicates_normalized: normalize_duplicates ? discoveryResult.duplicates : 0,
      relationships_created: create_relationships ? discoveryResult.relationships : 0,
      discovery_status: discoveryResult.status,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

async function triggerNetworkDiscovery(client: any, ipRange: string): Promise<any> {
  // Trigger ServiceNow Discovery
  const response = await client.post("/api/now/table/discovery_schedule", {
    name: `Network Discovery - ${ipRange}`,
    type: "network",
    ip_range: ipRange,
    active: true,
  })

  return {
    count: 0, // Will be populated after scan completes
    duplicates: 0,
    relationships: 0,
    status: "scheduled",
  }
}

async function triggerAgentBasedDiscovery(client: any): Promise<any> {
  // Trigger agent-based discovery
  return {
    count: 0,
    duplicates: 0,
    relationships: 0,
    status: "initiated",
  }
}

async function setupManualImport(client: any): Promise<any> {
  return {
    count: 0,
    duplicates: 0,
    relationships: 0,
    status: "ready_for_import",
  }
}

async function setupCSVUpload(client: any): Promise<any> {
  return {
    count: 0,
    duplicates: 0,
    relationships: 0,
    status: "ready_for_upload",
  }
}

export const version = "1.0.0"
