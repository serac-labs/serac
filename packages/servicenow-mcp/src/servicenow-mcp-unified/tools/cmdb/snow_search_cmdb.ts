/**
 * snow_search_cmdb - Search the CMDB for Configuration Items
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_search_cmdb",
  description: "Search the CMDB for Configuration Items with various filters",
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "query",
  use_cases: ["cmdb", "search", "query"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Search operation - reads data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query for CI name" },
      ci_class: { type: "string", description: "Filter by CI class" },
      operational_status: { type: "string", description: "Filter by operational status" },
      location: { type: "string", description: "Filter by location" },
      limit: { type: "number", description: "Maximum results to return", default: 50 },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { query, ci_class, operational_status, location, limit = 50 } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Build query string
    const queryParts: string[] = []

    if (query) {
      queryParts.push(`nameLIKE${query}`)
    }
    if (ci_class) {
      queryParts.push(`sys_class_name=${ci_class}`)
    }
    if (operational_status) {
      queryParts.push(`operational_status=${operational_status}`)
    }
    if (location) {
      queryParts.push(`location=${location}`)
    }

    const queryString = queryParts.join("^")
    const url = `/api/now/table/cmdb_ci?sysparm_query=${queryString}&sysparm_limit=${limit}`

    const response = await client.get(url)
    const cis = response.data.result || []

    return createSuccessResult({
      total: cis.length,
      cis: cis,
      query: queryString,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
