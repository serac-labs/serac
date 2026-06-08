/**
 * snow_update_set_query - Query Update Sets
 *
 * Unified tool for querying Update Set information: get current active set
 * or list multiple sets filtered by state.
 *
 * Replaces: snow_update_set_current, snow_update_set_list
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_update_set_query",
  description: "Query Update Sets (get current or list multiple)",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "update-sets",
  use_cases: ["update-sets", "query", "status"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Update operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Query action to perform",
        enum: ["current", "list"],
      },
      // LIST parameters
      state: {
        type: "string",
        description: "[list] Filter by state",
        enum: ["in progress", "complete", "released"],
      },
      limit: {
        type: "number",
        description: "[list] Maximum number of results",
        default: 10,
      },
      order_by: {
        type: "string",
        description: "[list] Order by field",
        default: "sys_created_on",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    switch (action) {
      case "current":
        return await executeCurrent(args, context)
      case "list":
        return await executeList(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== CURRENT ====================
async function executeCurrent(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const client = await getAuthenticatedClient(context)

  // Get current Update Set
  const response = await client.get("/api/now/table/sys_update_set", {
    params: {
      sysparm_query: "is_current=true",
      sysparm_fields: "sys_id,name,description,state,sys_created_on,sys_created_by",
      sysparm_limit: 1,
    },
  })

  if (!response.data.result || response.data.result.length === 0) {
    return createSuccessResult({
      active: false,
      message: "No active Update Set found",
    })
  }

  const updateSet = response.data.result[0]

  // Get artifact count
  const artifactsResponse = await client.get("/api/now/table/sys_update_xml", {
    params: {
      sysparm_query: `update_set=${updateSet.sys_id}`,
      sysparm_fields: "sys_id",
      sysparm_limit: 1000,
    },
  })

  const artifactCount = artifactsResponse.data.result?.length || 0

  return createSuccessResult({
    active: true,
    sys_id: updateSet.sys_id,
    name: updateSet.name,
    description: updateSet.description,
    state: updateSet.state,
    created_at: updateSet.sys_created_on,
    created_by: updateSet.sys_created_by,
    artifact_count: artifactCount,
  })
}

// ==================== LIST ====================
async function executeList(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { state, limit = 10, order_by = "sys_created_on" } = args
  const client = await getAuthenticatedClient(context)

  // Build query
  let query = ""
  if (state) {
    query = `state=${state}`
  }

  // Get Update Sets
  const response = await client.get("/api/now/table/sys_update_set", {
    params: {
      sysparm_query: query,
      sysparm_fields: "sys_id,name,description,state,sys_created_on,sys_created_by,sys_updated_on",
      sysparm_limit: limit,
      sysparm_orderby: `DESC${order_by}`,
    },
  })

  const updateSets = response.data.result || []

  // Enrich with artifact counts
  const enrichedSets = await Promise.all(
    updateSets.map(async (us: any) => {
      const artifactsResponse = await client.get("/api/now/table/sys_update_xml", {
        params: {
          sysparm_query: `update_set=${us.sys_id}`,
          sysparm_fields: "sys_id",
          sysparm_limit: 1,
        },
      })

      return {
        sys_id: us.sys_id,
        name: us.name,
        description: us.description,
        state: us.state,
        created_at: us.sys_created_on,
        created_by: us.sys_created_by,
        updated_at: us.sys_updated_on,
        artifact_count: artifactsResponse.data.result?.length || 0,
      }
    }),
  )

  return createSuccessResult({
    update_sets: enrichedSets,
    count: enrichedSets.length,
    filtered_by: state || "all",
    limit,
  })
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging"
