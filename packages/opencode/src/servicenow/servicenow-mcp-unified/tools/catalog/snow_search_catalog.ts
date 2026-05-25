/**
 * snow_search_catalog - Search service catalog
 *
 * Searches service catalog for items, categories, or catalogs. Returns available items for ordering.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_search_catalog",
  description: "Searches service catalog for items, categories, or catalogs. Returns available items for ordering.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "service-catalog",
  use_cases: ["search", "catalog", "discovery"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Search operation - reads data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      category: { type: "string", description: "Filter by category" },
      catalog: { type: "string", description: "Filter by catalog" },
      active_only: { type: "boolean", description: "Show only active items", default: true },
      include_variables: { type: "boolean", description: "Include item variables", default: false },
      limit: { type: "number", description: "Maximum results", default: 20 },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { query, category, catalog, active_only = true, include_variables = false, limit = 20 } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Build query string
    let queryString = ""

    if (query) {
      queryString = `nameLIKE${query}^ORshort_descriptionLIKE${query}`
    }

    if (category) {
      queryString += queryString ? "^" : ""
      queryString += `category=${category}`
    }

    if (catalog) {
      queryString += queryString ? "^" : ""
      queryString += `sc_catalogs=${catalog}`
    }

    if (active_only) {
      queryString += queryString ? "^" : ""
      queryString += "active=true"
    }

    const response = await client.get("/api/now/table/sc_cat_item", {
      params: {
        sysparm_query: queryString,
        sysparm_limit: limit,
      },
    })

    const items = response.data.result

    // Get variables if requested
    let itemsWithVariables = items
    if (include_variables) {
      itemsWithVariables = await Promise.all(
        items.map(async (item: any) => {
          const varResponse = await client.get("/api/now/table/sc_cat_item_option", {
            params: {
              sysparm_query: `cat_item=${item.sys_id}`,
              sysparm_limit: 50,
            },
          })
          return {
            ...item,
            variables: varResponse.data.result,
          }
        }),
      )
    }

    return createSuccessResult(
      {
        items: itemsWithVariables,
        count: items.length,
        query_used: queryString,
      },
      {
        operation: "search_catalog",
        query,
        results: items.length,
      },
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
