/**
 * snow_create_hr_case - Create HR case
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_hr_case",
  description: "Open an HR Service Delivery case on sn_hr_core_case for a given HR service, with subject, opened_for (employee), and optional priority. Use this for HR tickets; for IT incidents use snow_create_incident.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "hr",
  use_cases: ["hr-service-delivery", "case-management", "hr"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      subject: { type: "string" },
      opened_for: { type: "string" },
      hr_service: { type: "string" },
      priority: { type: "number" },
    },
    required: ["subject", "hr_service"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { subject, opened_for, hr_service, priority } = args
  try {
    const client = await getAuthenticatedClient(context)
    const caseData: any = { subject, hr_service }
    if (opened_for) caseData.opened_for = opened_for
    if (priority) caseData.priority = priority
    const response = await client.post("/api/now/table/sn_hr_core_case", caseData)
    return createSuccessResult({ created: true, hr_case: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
