/**
 * snow_create_atf_test - Create Automated Test Framework test
 *
 * Creates an ATF test for automated testing of ServiceNow applications.
 * Uses sys_atf_test table.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_atf_test",
  description: "Create Automated Test Framework (ATF) test for automated testing",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "testing",
  use_cases: ["testing", "atf", "automation"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Test name" },
      description: { type: "string", description: "Test description" },
      testFor: { type: "string", description: "What to test (form, list, service_portal, api, workflow)" },
      table: { type: "string", description: "Table to test (if applicable)" },
      active: { type: "boolean", description: "Test active status", default: true },
      category: { type: "string", description: "Test category (regression, smoke, integration)" },
    },
    required: ["name", "testFor"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, description = "", testFor, table, active = true, category = "general" } = args

  try {
    const client = await getAuthenticatedClient(context)

    const testData: any = {
      name,
      description,
      active,
      category,
      sys_class_name: "sys_atf_test",
    }

    if (table) {
      testData.table_name = table
    }

    const response = await client.post("/api/now/table/sys_atf_test", testData)
    const test = response.data.result

    return createSuccessResult({
      created: true,
      test: {
        sys_id: test.sys_id,
        name: test.name,
        test_for: testFor,
        table: table || null,
        category,
        active,
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
