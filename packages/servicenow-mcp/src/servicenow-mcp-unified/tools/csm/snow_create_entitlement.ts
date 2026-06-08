/**
 * snow_create_entitlement - Create entitlement
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_entitlement",
  description: "Create service entitlement for customer",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "customer-service",
  use_cases: ["csm", "entitlements", "sla"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      account: { type: "string", description: "Customer account sys_id" },
      service: { type: "string", description: "Service offering" },
      start_date: { type: "string", description: "Entitlement start date" },
      end_date: { type: "string", description: "Entitlement end date" },
      support_level: { type: "string", description: "Support level: Basic, Standard, Premium" },
      hours_included: { type: "number", description: "Support hours included" },
      response_time: { type: "string", description: "SLA response time" },
    },
    required: ["account", "service", "start_date", "end_date"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { account, service, start_date, end_date, support_level, hours_included, response_time } = args
  try {
    const client = await getAuthenticatedClient(context)

    const entitlementData: any = { account, service, start_date, end_date }
    if (support_level) entitlementData.support_level = support_level
    if (hours_included) entitlementData.hours_included = hours_included
    if (response_time) entitlementData.response_time = response_time

    const response = await client.post("/api/now/table/sn_customerservice_entitlement", entitlementData)
    return createSuccessResult({ created: true, entitlement: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
