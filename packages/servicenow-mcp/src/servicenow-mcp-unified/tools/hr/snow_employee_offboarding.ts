/**
 * snow_employee_offboarding - Employee offboarding
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_employee_offboarding",
  description: "Initiate employee offboarding workflow",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "hr",
  use_cases: ["hr-service-delivery", "offboarding", "lifecycle"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      employee: { type: "string", description: "Employee sys_id or user name" },
      last_date: { type: "string", description: "Last working date" },
      reason: { type: "string", description: "Offboarding reason" },
      assets_to_return: { type: "array", items: { type: "string" }, description: "Assets to collect" },
      knowledge_transfer: { type: "string", description: "Knowledge transfer plan" },
    },
    required: ["employee", "last_date", "reason"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { employee, last_date, reason, assets_to_return, knowledge_transfer } = args
  try {
    const client = await getAuthenticatedClient(context)

    const offboardingData: any = {
      employee,
      last_date,
      reason,
      hr_service: "Employee Offboarding",
      short_description: `Offboarding for ${employee}`,
      category: "Offboarding",
    }

    if (assets_to_return) offboardingData.assets_to_return = assets_to_return.join(",")
    if (knowledge_transfer) offboardingData.knowledge_transfer = knowledge_transfer

    const response = await client.post("/api/now/table/sn_hr_core_case", offboardingData)
    return createSuccessResult({ initiated: true, case: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
