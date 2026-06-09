/**
 * snow_discover_atf_tests - Discover ATF tests
 *
 * Discovers ATF tests in the instance with filtering and search capabilities.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_discover_atf_tests",
  description: "Discovers ATF tests in the instance with filtering and search capabilities.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "testing",
  use_cases: ["testing", "atf", "discovery"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Discovery operation - reads metadata
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      category: { type: "string", description: "Filter by test category" },
      table: { type: "string", description: "Filter by table name" },
      active: { type: "boolean", description: "Filter by active status" },
      nameContains: { type: "string", description: "Search by name pattern" },
      limit: { type: "number", description: "Maximum number of tests to return", default: 50 },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { category, table, active, nameContains, limit = 50 } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Build query
    const queryParts: string[] = []

    if (category) {
      queryParts.push(`category=${category}`)
    }

    if (table) {
      queryParts.push(`table_name=${table}`)
    }

    if (active !== undefined) {
      queryParts.push(`active=${active}`)
    }

    if (nameContains) {
      queryParts.push(`nameLIKE${nameContains}`)
    }

    const query = queryParts.join("^") || "sys_class_name=sys_atf_test"

    const response = await client.get(
      `/api/now/table/sys_atf_test?sysparm_query=${query}&sysparm_limit=${limit}&sysparm_display_value=true`,
    )

    const tests = response.data.result

    const formattedTests = tests.map((test: any) => ({
      sys_id: test.sys_id,
      name: test.name,
      description: test.description,
      category: test.category,
      table: test.table_name || null,
      active: test.active === "true",
      created_on: test.sys_created_on,
      updated_on: test.sys_updated_on,
      created_by: test.sys_created_by?.display_value || test.sys_created_by,
    }))

    return createSuccessResult({
      found: true,
      count: formattedTests.length,
      tests: formattedTests,
    })
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, error.message, { originalError: error }),
    )
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
