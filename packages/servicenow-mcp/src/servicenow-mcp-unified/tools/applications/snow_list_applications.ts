/**
 * snow_list_applications - List Available Applications
 *
 * Lists all scoped applications in the ServiceNow instance with filtering
 * and search capabilities. Useful for finding the right scope to work in.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_list_applications",
  description: `List all scoped applications (sys_app) in the ServiceNow instance. Use to find available scopes before switching, see which applications are active/inactive, or decide which scope to use for development.

Search options: filter by name (partial match), scope (partial match, e.g. "x_myco"), or vendor. Active-only by default; pass active_only=false to include inactive. include_global controls whether the Global scope appears in the list.

Returns each application with name, scope prefix, version, vendor, sys_id, and an is_current flag for the currently active scope. Optional include_artifact_count adds a per-application sys_metadata count (slower).`,
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "applications",
  use_cases: ["app-development", "scoped-apps", "development", "discovery"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query only, no modifications
  permission: "read",
  allowedRoles: ["developer", "admin", "stakeholder"],
  inputSchema: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description: "Search term to filter applications by name or scope (partial match)",
      },
      vendor: {
        type: "string",
        description: "Filter by vendor name (partial match)",
      },
      active_only: {
        type: "boolean",
        description: "Only show active applications (default: true)",
        default: true,
      },
      include_artifact_count: {
        type: "boolean",
        description: "Include count of artifacts in each application (slower, default: false)",
        default: false,
      },
      include_global: {
        type: "boolean",
        description: 'Include "Global" scope in the list (default: true)',
        default: true,
      },
      limit: {
        type: "number",
        description: "Maximum number of applications to return (default: 50)",
        default: 50,
      },
    },
    required: [],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { search, vendor, active_only = true, include_artifact_count = false, include_global = true, limit = 50 } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Build query
    const queryParts: string[] = []

    if (active_only) {
      queryParts.push("active=true")
    }

    if (search) {
      queryParts.push(`nameLIKE${search}^ORscopeLIKE${search}`)
    }

    if (vendor) {
      queryParts.push(`vendorLIKE${vendor}`)
    }

    const query = queryParts.length > 0 ? queryParts.join("^") : ""

    // Query applications
    const response = await client.get("/api/now/table/sys_app", {
      params: {
        sysparm_query: query + "^ORDERBYname",
        sysparm_fields:
          "sys_id,name,scope,version,short_description,vendor,vendor_prefix,active,sys_created_on,sys_updated_on",
        sysparm_limit: limit,
      },
    })

    const applications = response.data.result || []

    // Get current scope to mark it
    let currentScopeId = "global"
    try {
      const scopePrefResponse = await client.get("/api/now/table/sys_user_preference", {
        params: {
          sysparm_query: "name=sys_scope^user=javascript:gs.getUserID()",
          sysparm_fields: "value",
          sysparm_limit: 1,
        },
      })

      if (scopePrefResponse.data.result && scopePrefResponse.data.result.length > 0) {
        currentScopeId = scopePrefResponse.data.result[0].value || "global"
      }
    } catch (e) {
      // Ignore - default to global
    }

    // Build application list
    const appList: any[] = []

    // Add global scope first if requested
    if (include_global) {
      const globalEntry: any = {
        sys_id: "global",
        name: "Global",
        scope: "global",
        version: null,
        short_description: "Global scope for cross-application development",
        vendor: "ServiceNow",
        is_global: true,
        is_current: currentScopeId === "global",
        active: true,
      }

      if (include_artifact_count) {
        try {
          const globalCountResponse = await client.get("/api/now/table/sys_metadata", {
            params: {
              sysparm_query: "sys_scope=global",
              sysparm_fields: "sys_id",
              sysparm_limit: 1,
              sysparm_count: "true",
            },
          })
          globalEntry.artifact_count = parseInt(globalCountResponse.headers["x-total-count"] || "0", 10)
        } catch (e) {
          globalEntry.artifact_count = "unknown"
        }
      }

      // Only add global if it matches search
      if (!search || "global".includes(search.toLowerCase()) || "Global".toLowerCase().includes(search.toLowerCase())) {
        appList.push(globalEntry)
      }
    }

    // Process each application
    for (const app of applications) {
      const appEntry: any = {
        sys_id: app.sys_id,
        name: app.name,
        scope: app.scope,
        version: app.version || null,
        short_description: app.short_description || null,
        vendor: app.vendor || null,
        vendor_prefix: app.vendor_prefix || null,
        is_global: false,
        is_current: currentScopeId === app.sys_id,
        active: app.active === "true" || app.active === true,
        created_at: app.sys_created_on,
        updated_at: app.sys_updated_on,
      }

      // Get artifact count if requested
      if (include_artifact_count) {
        try {
          const countResponse = await client.get("/api/now/table/sys_metadata", {
            params: {
              sysparm_query: `sys_scope=${app.sys_id}`,
              sysparm_fields: "sys_id",
              sysparm_limit: 1,
              sysparm_count: "true",
            },
          })
          appEntry.artifact_count = parseInt(countResponse.headers["x-total-count"] || "0", 10)
        } catch (e) {
          appEntry.artifact_count = "unknown"
        }
      }

      appList.push(appEntry)
    }

    // Build result
    const result: any = {
      applications: appList,
      total_count: appList.length,
      current_scope: currentScopeId === "global" ? "Global" : appList.find((a) => a.is_current)?.name || currentScopeId,
      filters_applied: {
        search: search || null,
        vendor: vendor || null,
        active_only,
        include_global,
      },
    }

    // Add summary by vendor
    const vendorSummary: Record<string, number> = {}
    for (const app of appList) {
      const v = app.vendor || "Unknown"
      vendorSummary[v] = (vendorSummary[v] || 0) + 1
    }
    result.by_vendor = vendorSummary

    // Build message
    let message = `Found ${appList.length} application${appList.length === 1 ? "" : "s"}`
    if (search) {
      message += ` matching "${search}"`
    }

    const currentApp = appList.find((a) => a.is_current)
    if (currentApp) {
      message += `. Current scope: ${currentApp.is_global ? "Global" : `"${currentApp.name}" (${currentApp.scope})`}`
    }

    result.message = message

    // Add recommendations
    result.recommendations = []

    if (appList.length === 0) {
      result.recommendations.push(
        "No applications found. Use snow_create_application to create a new scoped application.",
      )
    } else if (!currentApp) {
      result.recommendations.push(
        "Current scope not in list. Use snow_switch_application_scope to switch to a listed scope.",
      )
    }

    return createSuccessResult(result)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Application Scope Enhancement"
