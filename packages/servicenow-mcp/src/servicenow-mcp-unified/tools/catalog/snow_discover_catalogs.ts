/**
 * snow_discover_catalogs - Discover service catalogs
 *
 * Discovers available service catalogs and their categories in the ServiceNow instance.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_discover_catalogs",
  description: "Discovers available service catalogs and their categories in the ServiceNow instance.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "service-catalog",
  use_cases: ["discovery", "catalogs", "categories"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Discovery operation - reads metadata
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      include_categories: { type: "boolean", description: "Include category tree", default: true },
      active_only: { type: "boolean", description: "Show only active catalogs", default: true },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { include_categories = true, active_only = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Build query
    const query = active_only ? "active=true" : ""

    // Get catalogs
    const response = await client.get("/api/now/table/sc_catalog", {
      params: {
        sysparm_query: query,
        sysparm_limit: 50,
      },
    })

    const catalogs = response.data.result

    // Get categories for each catalog if requested
    let catalogsWithDetails = catalogs
    if (include_categories) {
      catalogsWithDetails = await Promise.all(
        catalogs.map(async (catalog: any) => {
          const catResponse = await client.get("/api/now/table/sc_category", {
            params: {
              sysparm_query: `sc_catalog=${catalog.sys_id}`,
              sysparm_limit: 20,
            },
          })
          return {
            ...catalog,
            categories: catResponse.data.result,
          }
        }),
      )
    }

    return createSuccessResult(
      {
        catalogs: catalogsWithDetails,
        count: catalogsWithDetails.length,
      },
      {
        operation: "discover_catalogs",
        active_only,
        include_categories,
      },
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
