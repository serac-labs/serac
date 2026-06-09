/**
 * snow_create_atf_test_suite - Create ATF test suite
 *
 * Creates an ATF test suite to group and run multiple tests together
 * using sys_atf_test_suite table.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_atf_test_suite",
  description: "Creates an ATF test suite to group and run multiple tests together using sys_atf_test_suite table.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "testing",
  use_cases: ["testing", "atf", "test-suites"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Test suite name" },
      description: { type: "string", description: "Suite description" },
      tests: { type: "array", items: { type: "string" }, description: "Test IDs or names to include" },
      active: { type: "boolean", description: "Suite active status", default: true },
      runParallel: { type: "boolean", description: "Run tests in parallel", default: false },
    },
    required: ["name", "tests"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, description = "", tests = [], active = true, runParallel = false } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Create test suite
    const suiteData: any = {
      name,
      description,
      active,
      run_parallel: runParallel,
    }

    const response = await client.post("/api/now/table/sys_atf_test_suite", suiteData)
    const suite = response.data.result

    // Add tests to suite
    const addedTests = []
    for (const testId of tests) {
      // Resolve test ID if name provided
      let resolvedTestId = testId
      if (!testId.match(/^[a-f0-9]{32}$/)) {
        const testQuery = await client.get(`/api/now/table/sys_atf_test?sysparm_query=name=${testId}&sysparm_limit=1`)
        if (testQuery.data.result && testQuery.data.result.length > 0) {
          resolvedTestId = testQuery.data.result[0].sys_id
        } else {
          continue // Skip if test not found
        }
      }

      const testSuiteRelation = await client.post("/api/now/table/sys_atf_test_suite_test", {
        test_suite: suite.sys_id,
        test: resolvedTestId,
      })

      addedTests.push({
        test_id: resolvedTestId,
        relation_sys_id: testSuiteRelation.data.result.sys_id,
      })
    }

    return createSuccessResult({
      created: true,
      suite: {
        sys_id: suite.sys_id,
        name: suite.name,
        active,
        run_parallel: runParallel,
        tests_count: addedTests.length,
        tests: addedTests,
      },
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
