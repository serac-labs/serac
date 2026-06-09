/**
 * snow_property_query - Query System Properties
 *
 * Unified tool for querying system properties: list all, search by pattern, or get categories.
 *
 * Replaces: snow_property_list, snow_property_search, snow_property_categories
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_property_query",
  description: "Query system properties (list, search, categories)",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "properties",
  use_cases: ["properties", "discovery", "search"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query operation - only reads data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Query action to perform",
        enum: ["list", "search", "categories"],
      },
      // LIST/SEARCH parameters
      pattern: {
        type: "string",
        description: "[search] Search pattern (property name pattern)",
      },
      suffix: {
        type: "string",
        description: "[list] Filter by suffix/scope",
      },
      limit: {
        type: "number",
        description: "[list/search] Maximum results",
        default: 100,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    switch (action) {
      case "list":
        return await executeList(args, context)
      case "search":
        return await executeSearch(args, context)
      case "categories":
        return await executeCategories(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== LIST ====================
async function executeList(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { suffix, limit = 100 } = args
  const client = await getAuthenticatedClient(context)

  let query = ""
  if (suffix) {
    query = `suffix=${suffix}`
  }

  const response = await client.get("/api/now/table/sys_properties", {
    params: {
      sysparm_query: query,
      sysparm_fields: "name,value,description,type,suffix",
      sysparm_limit: limit,
      sysparm_orderby: "name",
    },
  })

  const properties = response.data.result || []

  return createSuccessResult({
    properties: properties.map((p: any) => ({
      name: p.name,
      value: p.value,
      description: p.description || "",
      type: p.type || "string",
      suffix: p.suffix || "global",
    })),
    count: properties.length,
    filtered_by_suffix: suffix || "all",
  })
}

// ==================== SEARCH ====================
async function executeSearch(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { pattern, limit = 100 } = args

  if (!pattern) {
    return createErrorResult("pattern is required for search action")
  }

  const client = await getAuthenticatedClient(context)

  const response = await client.get("/api/now/table/sys_properties", {
    params: {
      sysparm_query: `nameLIKE${pattern}`,
      sysparm_fields: "name,value,description,type,suffix",
      sysparm_limit: limit,
      sysparm_orderby: "name",
    },
  })

  const properties = response.data.result || []

  return createSuccessResult({
    properties: properties.map((p: any) => ({
      name: p.name,
      value: p.value,
      description: p.description || "",
      type: p.type || "string",
      suffix: p.suffix || "global",
    })),
    count: properties.length,
    search_pattern: pattern,
  })
}

// ==================== CATEGORIES ====================
async function executeCategories(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const client = await getAuthenticatedClient(context)

  // Get all properties and extract unique suffixes (categories)
  const response = await client.get("/api/now/table/sys_properties", {
    params: {
      sysparm_fields: "suffix",
      sysparm_limit: 10000,
    },
  })

  const properties = response.data.result || []
  const suffixCounts: Record<string, number> = {}

  properties.forEach((p: any) => {
    const suffix = p.suffix || "global"
    suffixCounts[suffix] = (suffixCounts[suffix] || 0) + 1
  })

  const categories = Object.entries(suffixCounts)
    .map(([suffix, count]) => ({ suffix, count }))
    .sort((a, b) => b.count - a.count)

  return createSuccessResult({
    categories,
    total_categories: categories.length,
    total_properties: properties.length,
  })
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging"
