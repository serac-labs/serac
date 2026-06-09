/**
 * snow_graphql_query
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_graphql_query",
  description: "Run a GraphQL query against /api/now/graphql with optional variables. Use when you need to fetch nested data across tables in one round-trip; for simple list/get on a single table, prefer the table API.",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "graphql",
  use_cases: ["graphql", "query", "data-retrieval"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Query operation - only reads data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "GraphQL query" },
      variables: { type: "object", description: "Query variables" },
    },
    required: ["query"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { query, variables } = args
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.post("/api/now/graphql", {
      query,
      variables: variables || {},
    })

    return createSuccessResult({
      success: true,
      data: response.data,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
