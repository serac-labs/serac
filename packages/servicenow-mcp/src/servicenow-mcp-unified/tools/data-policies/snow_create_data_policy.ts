/**
 * snow_create_data_policy
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_data_policy",
  description: "Create a Data Policy (sys_data_policy2) on a table — server-side equivalent of UI Policies, enforced for API/import writes. reverse_if_false re-applies the inverse when the condition turns false. Add field-level rules with snow_create_data_policy_rule.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "platform",
  use_cases: ["data-policies", "validation", "governance"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      short_description: { type: "string", description: "Policy description" },
      table: { type: "string", description: "Table name" },
      condition: { type: "string", description: "When to apply" },
      reverse_if_false: { type: "boolean", default: true },
      active: { type: "boolean", default: true },
    },
    required: ["short_description", "table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { short_description, table, condition, reverse_if_false = true, active = true } = args
  try {
    const client = await getAuthenticatedClient(context)
    // Note: sys_data_policy2 table uses 'model_table' and 'conditions' (plural) fields
    const policyData: any = {
      short_description,
      model_table: table,
      reverse_if_false,
      active,
    }
    if (condition) policyData.conditions = condition
    const response = await client.post("/api/now/table/sys_data_policy2", policyData)
    return createSuccessResult({ created: true, data_policy: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.1.0"
export const author = "Serac v8.41.17"
