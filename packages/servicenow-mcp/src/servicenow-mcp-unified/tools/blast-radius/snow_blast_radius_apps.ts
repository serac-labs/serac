/**
 * snow_blast_radius_apps - List all applications/scopes with configuration counts
 *
 * Entry point for Blast Radius - provides a metadata catalog of all apps
 * in the instance with counts of business rules, client scripts, etc.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import { SCOPE_COUNT_TABLES } from "./shared/metadata-tables.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_blast_radius_apps",
  description: `List all applications/scopes in the instance with configuration summary counts.

📋 USE THIS TO:
- Get an overview of all apps and their configuration footprint
- Find which apps have the most business rules, client scripts, etc.
- Identify apps by name or scope prefix
- Start a Blast Radius analysis session

📊 RETURNS:
- List of applications with name, scope, vendor
- Per-app counts of business rules, client scripts, UI actions, UI policies, script includes, ACLs
- Instance-level summary totals`,
  category: "blast-radius",
  subcategory: "catalog",
  use_cases: ["impact-analysis", "discovery", "governance"],
  complexity: "beginner",
  frequency: "medium",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description: "Filter by app name or scope prefix (partial match)",
      },
      include_global: {
        type: "boolean",
        description: "Include Global scope in results (default: true)",
        default: true,
      },
      include_config_counts: {
        type: "boolean",
        description: "Include per-app counts of BRs, client scripts, etc. (default: true)",
        default: true,
      },
      active_only: {
        type: "boolean",
        description: "Only show active applications (default: true)",
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

async function getConfigCounts(
  client: any,
  scopeSysId: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}

  const countPromises = SCOPE_COUNT_TABLES.map(async ({ key, table }) => {
    try {
      const response = await client.get(`/api/now/table/${table}`, {
        params: {
          sysparm_query: `sys_scope=${scopeSysId}`,
          sysparm_fields: "sys_id",
          sysparm_limit: 1,
          sysparm_count: "true",
        },
      })
      counts[key] = parseInt(response.headers["x-total-count"] || "0", 10)
    } catch {
      counts[key] = 0
    }
  })

  await Promise.allSettled(countPromises)
  return counts
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    search,
    include_global = true,
    include_config_counts = true,
    active_only = true,
    limit = 50,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Build query for scoped apps
    const queryParts: string[] = []
    if (active_only) queryParts.push("active=true")
    if (search) queryParts.push(`nameLIKE${search}^ORscopeLIKE${search}`)
    const query = queryParts.length > 0 ? queryParts.join("^") : ""

    const response = await client.get("/api/now/table/sys_app", {
      params: {
        sysparm_query: query + "^ORDERBYname",
        sysparm_fields: "sys_id,name,scope,version,vendor,active",
        sysparm_limit: limit,
      },
    })

    const apps = response.data.result || []
    const applications: any[] = []

    // Add global scope if requested
    if (include_global) {
      const shouldInclude = !search ||
        "global".includes(search.toLowerCase()) ||
        "Global".toLowerCase().includes(search.toLowerCase())

      if (shouldInclude) {
        const globalEntry: any = {
          sys_id: "global",
          name: "Global",
          scope: "global",
          vendor: "ServiceNow",
          active: true,
        }

        if (include_config_counts) {
          globalEntry.config_counts = await getConfigCounts(client, "global")
        }

        applications.push(globalEntry)
      }
    }

    // Process scoped apps - limit config count queries to avoid API overload
    const maxCountApps = 20
    for (let i = 0; i < apps.length; i++) {
      const app = apps[i]
      const entry: any = {
        sys_id: app.sys_id,
        name: app.name,
        scope: app.scope,
        vendor: app.vendor || null,
        active: app.active === "true" || app.active === true,
      }

      if (include_config_counts && i < maxCountApps) {
        entry.config_counts = await getConfigCounts(client, app.sys_id)
      }

      applications.push(entry)
    }

    // Calculate totals
    let totalConfigs = 0
    for (const app of applications) {
      if (app.config_counts) {
        for (const count of Object.values(app.config_counts)) {
          totalConfigs += count as number
        }
      }
    }

    const result = {
      applications,
      total_count: applications.length,
      instance_summary: {
        total_apps: applications.length,
        total_configurations: totalConfigs,
        config_counts_limited: apps.length > maxCountApps
          ? `Config counts shown for first ${maxCountApps} apps only`
          : undefined,
      },
    }

    const summary = `Found ${applications.length} application${applications.length === 1 ? "" : "s"}${search ? ` matching "${search}"` : ""}. Total configurations: ${totalConfigs}`

    return createSuccessResult(result, { apiCalls: 1 + (include_config_counts ? applications.length * SCOPE_COUNT_TABLES.length : 0) }, summary)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Blast Radius"
