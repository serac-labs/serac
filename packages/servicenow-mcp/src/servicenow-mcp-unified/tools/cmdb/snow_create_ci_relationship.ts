/**
 * snow_create_ci_relationship - Create CI relationships
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_ci_relationship",
  description: "Create relationship between Configuration Items",
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "relationships",
  use_cases: ["cmdb", "relationships", "dependencies"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      parent_ci: { type: "string", description: "Parent CI sys_id" },
      child_ci: { type: "string", description: "Child CI sys_id" },
      relationship_type: { type: "string", description: "Relationship type sys_id" },
    },
    required: ["parent_ci", "child_ci", "relationship_type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { parent_ci, child_ci, relationship_type } = args
  try {
    const client = await getAuthenticatedClient(context)
    const relData = { parent: parent_ci, child: child_ci, type: relationship_type }
    const response = await client.post("/api/now/table/cmdb_rel_ci", relData)
    return createSuccessResult({ created: true, relationship: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
