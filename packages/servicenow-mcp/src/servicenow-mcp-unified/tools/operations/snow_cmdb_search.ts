/**
 * snow_cmdb_search - Search CMDB
 *
 * Searches Configuration Management Database (CMDB) for configuration items with relationship mapping.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_cmdb_search",
  description: "Searches Configuration Management Database (CMDB) for configuration items with relationship mapping",
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "discovery",
  use_cases: ["cmdb", "configuration-items"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Search operation - reads data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: 'Search query for configuration items (e.g., "server name", "application")',
      },
      ci_type: {
        type: "string",
        description: "Type of CI to search",
        enum: ["server", "application", "database", "network_device", "service", "any"],
        default: "any",
      },
      limit: {
        type: "number",
        description: "Maximum number of results",
        default: 10,
        minimum: 1,
        maximum: 100,
      },
      include_relationships: {
        type: "boolean",
        description: "Include CI relationships",
        default: false,
      },
    },
    required: ["query"],
  },
}

// CI type to table mapping
const ciTableMapping: Record<string, string> = {
  server: "cmdb_ci_server",
  application: "cmdb_ci_application",
  database: "cmdb_ci_database",
  network_device: "cmdb_ci_network_device",
  service: "cmdb_ci_service",
  any: "cmdb_ci",
}

function processSearchQuery(query: string): string {
  // If already a ServiceNow encoded query, return as-is
  if (query.includes("=") || query.includes("!=") || query.includes("^") || query.includes("LIKE")) {
    return query
  }

  // Default: search in name and short_description
  return `nameLIKE${query}^ORshort_descriptionLIKE${query}`
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { query, ci_type = "any", limit = 10, include_relationships = false } = args

  // Validate required parameters
  if (!query || typeof query !== "string" || query.trim() === "") {
    return createErrorResult('Parameter "query" is required and must be a non-empty string')
  }

  try {
    const client = await getAuthenticatedClient(context)

    // Get the appropriate CI table
    const ciTable = ciTableMapping[ci_type] || "cmdb_ci"

    // Process query
    const processedQuery = processSearchQuery(query.trim())

    // Search CIs with better error handling
    var response
    try {
      response = await client.get(`/api/now/table/${ciTable}`, {
        params: {
          sysparm_query: processedQuery,
          sysparm_limit: limit,
          sysparm_fields: "sys_id,name,short_description,operational_status,support_group,sys_class_name",
        },
      })
    } catch (apiError: any) {
      // If specific table fails, fall back to base cmdb_ci table
      if (ciTable !== "cmdb_ci" && apiError.response?.status === 400) {
        response = await client.get("/api/now/table/cmdb_ci", {
          params: {
            sysparm_query: processedQuery,
            sysparm_limit: limit,
            sysparm_fields: "sys_id,name,short_description,operational_status,support_group,sys_class_name",
          },
        })
      } else {
        throw apiError
      }
    }

    const configItems = response.data.result || []

    let result: any = {
      total_results: configItems.length,
      ci_type,
      table_searched: ciTable,
      query_used: processedQuery,
      configuration_items: configItems.map((ci: any) => ({
        sys_id: ci.sys_id,
        name: ci.name,
        short_description: ci.short_description,
        operational_status: ci.operational_status,
        support_group: ci.support_group,
        sys_class_name: ci.sys_class_name,
      })),
    }

    // Include relationships if requested
    if (include_relationships && configItems.length > 0) {
      const relationships = []

      for (const ci of configItems) {
        try {
          const relResponse = await client.get("/api/now/table/cmdb_rel_ci", {
            params: {
              sysparm_query: `parent=${ci.sys_id}^ORchild=${ci.sys_id}`,
              sysparm_limit: 20,
            },
          })

          if (relResponse.data.result && relResponse.data.result.length > 0) {
            relationships.push({
              ci_sys_id: ci.sys_id,
              ci_name: ci.name,
              relationship_count: relResponse.data.result.length,
              relationships: relResponse.data.result.map((rel: any) => ({
                type: rel.type,
                parent: rel.parent?.name || rel.parent,
                child: rel.child?.name || rel.child,
              })),
            })
          }
        } catch (error) {
          // Log but don't fail the entire request
          console.warn(`Failed to get relationships for CI ${ci.sys_id}:`, error)
        }
      }

      result.relationships = relationships
    }

    return createSuccessResult(result, { query: processedQuery, ci_type, limit, count: configItems.length })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
