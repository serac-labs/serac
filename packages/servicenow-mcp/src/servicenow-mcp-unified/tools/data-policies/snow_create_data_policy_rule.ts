/**
 * snow_create_data_policy_rule
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_data_policy_rule",
  description: "Add a field rule to an existing Data Policy: mark the field as mandatory and/or read-only when the parent policy's condition is true. Writes to sys_data_policy_rule.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "platform",
  use_cases: ["data-policies", "rules", "validation"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      data_policy_sys_id: { type: "string", description: "Data policy sys_id" },
      field: { type: "string", description: "Field name" },
      mandatory: { type: "boolean", description: "Make mandatory" },
      readonly: { type: "boolean", description: "Make readonly" },
    },
    required: ["data_policy_sys_id", "field"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { data_policy_sys_id, field, mandatory, readonly } = args
  try {
    const client = await getAuthenticatedClient(context)
    const ruleData: any = {
      sys_data_policy: data_policy_sys_id,
      element: field,
    }
    if (mandatory !== undefined) ruleData.mandatory = mandatory
    if (readonly !== undefined) ruleData.readonly = readonly
    const response = await client.post("/api/now/table/sys_data_policy_rule", ruleData)
    return createSuccessResult({ created: true, rule: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
