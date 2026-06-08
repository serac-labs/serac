/**
 * snow_get_atf_results - Get ATF test results
 *
 * Retrieves ATF test execution results including pass/fail status,
 * error details, and execution time from sys_atf_test_result table.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_atf_results",
  description:
    "Retrieves ATF test execution results including pass/fail status, error details, and execution time from sys_atf_test_result table.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "testing",
  use_cases: ["testing", "atf", "results"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      executionId: { type: "string", description: "Test execution ID" },
      testId: { type: "string", description: "Test ID to get latest results" },
      limit: { type: "number", description: "Number of recent results to retrieve", default: 10 },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { executionId, testId, limit = 10 } = args

  try {
    const client = await getAuthenticatedClient(context)

    if (!executionId && !testId) {
      throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "Either executionId or testId must be provided")
    }

    let query = ""
    if (executionId) {
      query = `sys_id=${executionId}`
    } else if (testId) {
      // Resolve test ID if name provided
      let resolvedTestId = testId
      if (!testId.match(/^[a-f0-9]{32}$/)) {
        const testQuery = await client.get(`/api/now/table/sys_atf_test?sysparm_query=name=${testId}&sysparm_limit=1`)
        if (!testQuery.data.result || testQuery.data.result.length === 0) {
          throw new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Test not found: ${testId}`)
        }
        resolvedTestId = testQuery.data.result[0].sys_id
      }
      query = `test=${resolvedTestId}^ORDERBYDESCsys_created_on`
    }

    const response = await client.get(
      `/api/now/table/sys_atf_test_result?sysparm_query=${query}&sysparm_limit=${limit}`,
    )

    const results = response.data.result

    if (!results || results.length === 0) {
      return createSuccessResult({
        found: false,
        message: "No test results found",
        results: [],
      })
    }

    const formattedResults = results.map((result: any) => ({
      sys_id: result.sys_id,
      test_id: result.test?.value || result.test,
      test_name: result.test?.display_value || "Unknown",
      status: result.status,
      passed: result.status === "success",
      duration: result.run_time,
      start_time: result.start_time,
      end_time: result.end_time,
      output: result.output,
      error_message: result.error_message || null,
      steps_passed: result.steps_passed || 0,
      steps_failed: result.steps_failed || 0,
      steps_total: result.total_steps || 0,
    }))

    return createSuccessResult({
      found: true,
      count: formattedResults.length,
      results: formattedResults,
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
