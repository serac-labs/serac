/**
 * snow_execute_atf_test - Execute ATF test or suite
 *
 * Executes an ATF test or test suite and returns the results.
 * Tests run asynchronously in ServiceNow using sys_atf_test_result table.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_execute_atf_test",
  description:
    "Executes an ATF test or test suite and returns the results. Tests run asynchronously in ServiceNow using sys_atf_test_result table.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "testing",
  use_cases: ["testing", "atf", "execution"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Execution operation - can have side effects
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      testId: { type: "string", description: "Test sys_id or name to execute" },
      suiteId: { type: "string", description: "Test suite sys_id or name (alternative to testId)" },
      async: { type: "boolean", description: "Run asynchronously", default: true },
      waitForResult: { type: "boolean", description: "Wait for test completion", default: false },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { testId, suiteId, async = true, waitForResult = false } = args

  try {
    const client = await getAuthenticatedClient(context)

    if (!testId && !suiteId) {
      throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "Either testId or suiteId must be provided")
    }

    let executionId: string
    let executionType: string

    // Execute test or suite
    if (testId) {
      // Resolve test ID if name provided
      let resolvedTestId = testId
      if (!testId.match(/^[a-f0-9]{32}$/)) {
        const testQuery = await client.get(`/api/now/table/sys_atf_test?sysparm_query=name=${testId}&sysparm_limit=1`)
        if (!testQuery.data.result || testQuery.data.result.length === 0) {
          throw new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Test not found: ${testId}`)
        }
        resolvedTestId = testQuery.data.result[0].sys_id
      }

      // Trigger test execution
      const response = await client.post("/api/now/atf/test/execute", {
        test: resolvedTestId,
        async,
      })
      executionId = response.data.result.execution_id
      executionType = "test"
    } else {
      // Resolve suite ID if name provided
      let resolvedSuiteId = suiteId
      if (!suiteId.match(/^[a-f0-9]{32}$/)) {
        const suiteQuery = await client.get(
          `/api/now/table/sys_atf_test_suite?sysparm_query=name=${suiteId}&sysparm_limit=1`,
        )
        if (!suiteQuery.data.result || suiteQuery.data.result.length === 0) {
          throw new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Test suite not found: ${suiteId}`)
        }
        resolvedSuiteId = suiteQuery.data.result[0].sys_id
      }

      // Trigger suite execution
      const response = await client.post("/api/now/atf/suite/execute", {
        test_suite: resolvedSuiteId,
        async,
      })
      executionId = response.data.result.execution_id
      executionType = "suite"
    }

    // Optionally wait for results
    if (waitForResult && async) {
      let attempts = 0
      const maxAttempts = 60 // 5 minutes max

      while (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 5000)) // Wait 5 seconds

        const statusResponse = await client.get(`/api/now/table/sys_atf_test_result/${executionId}`)
        const result = statusResponse.data.result

        if (result.status === "success" || result.status === "failure") {
          return createSuccessResult({
            executed: true,
            execution_id: executionId,
            type: executionType,
            status: result.status,
            duration: result.run_time,
            passed: result.status === "success",
            result_details: result,
          })
        }

        attempts++
      }

      throw new SnowFlowError(ErrorType.TIMEOUT_ERROR, "Test execution timeout")
    }

    return createSuccessResult({
      executed: true,
      execution_id: executionId,
      type: executionType,
      status: async ? "running" : "completed",
      message: async ? "Test execution started" : "Test execution completed",
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
