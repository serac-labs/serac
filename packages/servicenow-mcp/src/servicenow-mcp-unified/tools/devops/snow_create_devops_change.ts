/**
 * snow_create_devops_change - Create DevOps change
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_devops_change",
  description: "Create automated DevOps change request for deployments",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "devops",
  use_cases: ["devops", "change-management", "deployments"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      application: { type: "string", description: "Application to deploy" },
      version: { type: "string", description: "Version to deploy" },
      environment: { type: "string", description: "Target environment" },
      deployment_date: { type: "string", description: "Planned deployment date" },
      risk_assessment: { type: "object", description: "Risk assessment data" },
      rollback_plan: { type: "string", description: "Rollback procedure" },
    },
    required: ["application", "version", "environment", "deployment_date"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { application, version, environment, deployment_date, risk_assessment, rollback_plan } = args
  try {
    const client = await getAuthenticatedClient(context)

    const changeData: any = {
      application,
      version,
      environment,
      deployment_date,
      type: "standard",
      category: "Software",
      short_description: `Deploy ${application} v${version} to ${environment}`,
    }

    if (risk_assessment) changeData.risk_assessment = JSON.stringify(risk_assessment)
    if (rollback_plan) changeData.rollback_plan = rollback_plan

    const response = await client.post("/api/now/table/change_request", changeData)
    return createSuccessResult({ created: true, change: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
