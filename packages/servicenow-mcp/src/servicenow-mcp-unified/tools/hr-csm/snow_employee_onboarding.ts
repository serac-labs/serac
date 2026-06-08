/**
 * snow_employee_onboarding - Employee onboarding
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_employee_onboarding",
  description: "Trigger employee onboarding workflow",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "hr",
  use_cases: ["hr-service-delivery", "onboarding", "lifecycle"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      employee_sys_id: { type: "string" },
      start_date: { type: "string" },
      department: { type: "string" },
    },
    required: ["employee_sys_id", "start_date"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { employee_sys_id, start_date, department } = args
  try {
    const client = await getAuthenticatedClient(context)
    const onboardingData: any = { employee: employee_sys_id, start_date }
    if (department) onboardingData.department = department
    const response = await client.post("/api/now/table/sn_hr_le_onboarding", onboardingData)
    return createSuccessResult({ initiated: true, onboarding: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
