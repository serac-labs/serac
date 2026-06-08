/**
 * snow_get_ci_relationships - Get CI relationship map
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_ci_relationships",
  description: "Get all relationships for a Configuration Item",
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "relationships",
  use_cases: ["cmdb", "relationships", "mapping"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      ci_sys_id: { type: "string", description: "CI sys_id" },
      depth: { type: "number", description: "Relationship depth", default: 1 },
    },
    required: ["ci_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { ci_sys_id, depth = 1 } = args
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.get("/api/now/table/cmdb_rel_ci", {
      params: {
        sysparm_query: `parent=${ci_sys_id}^ORchild=${ci_sys_id}`,
        sysparm_display_value: "all",
        sysparm_limit: 1000,
      },
    })
    return createSuccessResult({ relationships: response.data.result, depth })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
