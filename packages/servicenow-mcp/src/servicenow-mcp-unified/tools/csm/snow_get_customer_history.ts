/**
 * snow_get_customer_history - Get customer history
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_customer_history",
  description: "Retrieve complete customer interaction history",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "customer-service",
  use_cases: ["csm", "history", "customer-360"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      customer: { type: "string", description: "Customer account or contact sys_id" },
      include_cases: { type: "boolean", description: "Include case history", default: true },
      include_communications: { type: "boolean", description: "Include communications", default: true },
      date_range: { type: "string", description: "Date range filter" },
    },
    required: ["customer"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { customer, include_cases = true, include_communications = true, date_range } = args
  try {
    const client = await getAuthenticatedClient(context)

    const result: any = { customer }

    // Get cases if requested
    if (include_cases) {
      let caseQuery = `customer=${customer}`
      if (date_range) caseQuery += `^sys_created_on>${date_range}`
      const casesResponse = await client.get(`/api/now/table/sn_customerservice_case?sysparm_query=${caseQuery}`)
      result.cases = casesResponse.data?.result || []
      result.case_count = result.cases.length
    }

    // Get communications if requested
    if (include_communications) {
      let commQuery = `customer=${customer}`
      if (date_range) commQuery += `^sys_created_on>${date_range}`
      const commResponse = await client.get(`/api/now/table/sys_email?sysparm_query=${commQuery}`)
      result.communications = commResponse.data?.result || []
      result.communication_count = result.communications.length
    }

    return createSuccessResult(result)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
