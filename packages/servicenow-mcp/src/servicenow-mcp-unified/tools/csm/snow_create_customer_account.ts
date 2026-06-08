/**
 * snow_create_customer_account - Create customer account
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_customer_account",
  description: "Create customer account for tracking relationships and entitlements",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "customer-service",
  use_cases: ["csm", "accounts", "customers"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Account name" },
      account_number: { type: "string", description: "Account number" },
      type: { type: "string", description: "Account type: Customer, Partner, Prospect" },
      industry: { type: "string", description: "Industry" },
      annual_revenue: { type: "string", description: "Annual revenue" },
      employees: { type: "number", description: "Number of employees" },
      primary_contact: { type: "string", description: "Primary contact sys_id" },
    },
    required: ["name", "type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, account_number, type, industry, annual_revenue, employees, primary_contact } = args
  try {
    const client = await getAuthenticatedClient(context)

    const accountData: any = { name, type }
    if (account_number) accountData.account_number = account_number
    if (industry) accountData.industry = industry
    if (annual_revenue) accountData.annual_revenue = annual_revenue
    if (employees) accountData.employees = employees
    if (primary_contact) accountData.primary_contact = primary_contact

    const response = await client.post("/api/now/table/sn_customerservice_account", accountData)
    return createSuccessResult({ created: true, account: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
