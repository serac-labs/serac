/**
 * snow_create_atf_test_step - Add test step to ATF test
 *
 * Adds a test step to an existing ATF test. Steps define the actions
 * and assertions for testing using the sys_atf_step table.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_atf_test_step",
  description:
    "Adds a test step to an existing ATF test. Steps define the actions and assertions for testing using the sys_atf_step table.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "testing",
  use_cases: ["testing", "atf", "test-steps"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      testId: { type: "string", description: "Parent test sys_id or name" },
      stepType: {
        type: "string",
        description: "Step type (e.g., form_submission, impersonate, assert_condition, open_form, server_script)",
      },
      order: { type: "number", description: "Step execution order" },
      description: { type: "string", description: "Step description" },
      stepConfig: { type: "object", description: "Step configuration (varies by type)" },
      timeout: { type: "number", description: "Step timeout in seconds", default: 30 },
    },
    required: ["testId", "stepType", "order"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { testId, stepType, order, description = "", stepConfig = {}, timeout = 30 } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Resolve test ID if name provided
    let resolvedTestId = testId
    if (!testId.match(/^[a-f0-9]{32}$/)) {
      const testQuery = await client.get(`/api/now/table/sys_atf_test?sysparm_query=name=${testId}&sysparm_limit=1`)
      if (!testQuery.data.result || testQuery.data.result.length === 0) {
        throw new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Test not found: ${testId}`)
      }
      resolvedTestId = testQuery.data.result[0].sys_id
    }

    const stepData: any = {
      test: resolvedTestId,
      step_config: {
        type: stepType,
        ...stepConfig,
      },
      order,
      description,
      timeout,
    }

    const response = await client.post("/api/now/table/sys_atf_step", stepData)
    const step = response.data.result

    return createSuccessResult({
      created: true,
      step: {
        sys_id: step.sys_id,
        test_id: resolvedTestId,
        type: stepType,
        order,
        timeout,
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
