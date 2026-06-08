/**
 * snow_create_devops_pipeline - Create DevOps pipeline
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_devops_pipeline",
  description: "Create DevOps pipeline for CI/CD automation",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "specialized",
  use_cases: ["devops"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Pipeline name" },
      repository: { type: "string", description: "Source repository" },
      branch: { type: "string", description: "Branch to build" },
      stages: { type: "array", items: { type: "object" }, description: "Pipeline stages" },
      triggers: { type: "array", items: { type: "string" }, description: "Pipeline triggers" },
      environment: { type: "string", description: "Target environment" },
    },
    required: ["name", "repository", "branch"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, repository, branch, stages, triggers, environment } = args
  try {
    const client = await getAuthenticatedClient(context)

    const pipelineData: any = { name, repository, branch }
    if (stages) pipelineData.stages = JSON.stringify(stages)
    if (triggers) pipelineData.triggers = triggers.join(",")
    if (environment) pipelineData.environment = environment

    const response = await client.post("/api/now/table/sn_devops_pipeline", pipelineData)
    return createSuccessResult({ created: true, pipeline: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
