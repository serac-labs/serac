/**
 * snow_uib_discover - Unified UI Builder Discovery Operations
 *
 * UI Builder discovery: find pages, components, routes, and page usage analytics.
 *
 * Replaces: snow_discover_uib_pages, snow_discover_uib_components,
 *           snow_discover_uib_routes, snow_discover_uib_page_usage
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_uib_discover",
  description: "Unified UI Builder discovery (pages, components, routes, page_usage)",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-frameworks",
  subcategory: "ui-builder",
  use_cases: ["ui-builder", "discovery", "components", "pages"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Discovery function - reads UI Builder configuration
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Discovery action to perform",
        enum: ["pages", "components", "routes", "page_usage"],
      },
      // PAGES parameters
      search: {
        type: "string",
        description: "[pages/components] Search names and titles",
      },
      experience: {
        type: "string",
        description: "[pages] Filter by experience sys_id",
      },
      active_only: {
        type: "boolean",
        description: "[pages] Return only active pages",
        default: true,
      },
      include_routes: {
        type: "boolean",
        description: "[pages] Include route information",
        default: true,
      },
      // COMPONENTS parameters
      category: {
        type: "string",
        description: "[components] Filter by category",
      },
      include_custom: {
        type: "boolean",
        description: "[components] Include custom components",
        default: true,
      },
      include_builtin: {
        type: "boolean",
        description: "[components] Include built-in components",
        default: true,
      },
      // ROUTES parameters
      experience_sys_id: {
        type: "string",
        description: "[routes] Experience sys_id to get routes",
      },
      // PAGE_USAGE parameters
      page_sys_id: {
        type: "string",
        description: "[page_usage] Page sys_id to analyze",
      },
      days_back: {
        type: "number",
        description: "[page_usage] Days of usage history",
        default: 30,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    switch (action) {
      case "pages":
        return await executePages(args, context)
      case "components":
        return await executeComponents(args, context)
      case "routes":
        return await executeRoutes(args, context)
      case "page_usage":
        return await executePageUsage(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== PAGES ====================
async function executePages(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { search, experience, active_only = true, include_routes = true } = args

  const client = await getAuthenticatedClient(context)

  let query = ""
  const queryParts = []

  if (search) {
    queryParts.push("nameLIKE" + search + "^ORtitleLIKE" + search)
  }
  if (experience) {
    queryParts.push("experience=" + experience)
  }
  if (active_only) {
    queryParts.push("active=true")
  }

  query = queryParts.join("^")

  const response = await client.get("/api/now/table/sys_ux_page", {
    params: {
      sysparm_query: query,
      sysparm_limit: 100,
    },
  })

  const pages = response.data.result

  // Get routes if requested
  if (include_routes && pages.length > 0) {
    for (const page of pages) {
      const routeResponse = await client.get("/api/now/table/sys_ux_page_registry", {
        params: {
          sysparm_query: "page=" + page.sys_id,
          sysparm_limit: 10,
        },
      })
      page.routes = routeResponse.data.result
    }
  }

  return createSuccessResult({
    action: "pages",
    pages,
    count: pages.length,
  })
}

// ==================== COMPONENTS ====================
async function executeComponents(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { category, search, include_custom = true, include_builtin = true } = args

  const client = await getAuthenticatedClient(context)

  let query = ""
  const queryParts = []

  if (category) {
    queryParts.push("category=" + category)
  }
  if (search) {
    queryParts.push("nameLIKE" + search + "^ORlabelLIKE" + search)
  }

  // Filter by component type
  const typeParts = []
  if (include_custom) typeParts.push("sys_scope!=global")
  if (include_builtin) typeParts.push("sys_scope=global")
  if (typeParts.length > 0) {
    queryParts.push("(" + typeParts.join("^OR") + ")")
  }

  query = queryParts.join("^")

  const response = await client.get("/api/now/table/sys_ux_lib_component", {
    params: {
      sysparm_query: query || undefined,
      sysparm_limit: 100,
    },
  })

  return createSuccessResult({
    action: "components",
    components: response.data.result,
    count: response.data.result.length,
  })
}

// ==================== ROUTES ====================
async function executeRoutes(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { experience_sys_id } = args

  if (!experience_sys_id) {
    return createErrorResult("experience_sys_id is required for routes action")
  }

  const client = await getAuthenticatedClient(context)

  const response = await client.get("/api/now/table/sys_ux_page_registry", {
    params: {
      sysparm_query: "experience=" + experience_sys_id,
      sysparm_limit: 100,
      sysparm_orderby: "route",
    },
  })

  return createSuccessResult({
    action: "routes",
    routes: response.data.result,
    count: response.data.result.length,
  })
}

// ==================== PAGE USAGE ====================
async function executePageUsage(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { page_sys_id, days_back = 30 } = args

  if (!page_sys_id) {
    return createErrorResult("page_sys_id is required for page_usage action")
  }

  const client = await getAuthenticatedClient(context)

  // Calculate date range
  const endDate = new Date()
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - days_back)

  // Get usage analytics
  // Note: This is a simplified version. Actual implementation may need to query
  // analytics tables specific to the ServiceNow instance
  const usageData = {
    page_sys_id,
    analyzed_period: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      days: days_back,
    },
    note: "Usage analytics require specific analytics configuration in ServiceNow",
  }

  return createSuccessResult({
    action: "page_usage",
    usage: usageData,
  })
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging - Phase 1"
