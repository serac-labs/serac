/**
 * snow_track_deployment - Track deployment
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_track_deployment",
  description: "Track application deployment through DevOps pipeline",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "devops",
  use_cases: ["devops", "deployments", "tracking"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create/update/delete operation
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      application: { type: "string", description: "Application name" },
      version: { type: "string", description: "Version being deployed" },
      environment: { type: "string", description: "Target environment" },
      pipeline: { type: "string", description: "Pipeline used" },
      change_request: { type: "string", description: "Associated change request" },
      status: { type: "string", description: "Deployment status" },
      start_time: { type: "string", description: "Deployment start time" },
    },
    required: ["application", "version", "environment"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { application, version, environment, pipeline, change_request, status, start_time } = args
  try {
    const client = await getAuthenticatedClient(context)

    const deploymentData: any = {
      application,
      version,
      environment,
      status: status || "in_progress",
      start_time: start_time || new Date().toISOString(),
    }

    if (pipeline) deploymentData.pipeline = pipeline
    if (change_request) deploymentData.change_request = change_request

    const response = await client.post("/api/now/table/sn_devops_deployment", deploymentData)
    return createSuccessResult({ tracked: true, deployment: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
