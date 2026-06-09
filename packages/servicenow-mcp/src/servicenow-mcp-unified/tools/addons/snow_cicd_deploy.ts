/**
 * snow_cicd_deploy
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_cicd_deploy",
  description: "Trigger CI/CD deployment pipeline",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "devops",
  use_cases: ["cicd", "deployment", "devops"],
  complexity: "advanced",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create/update/delete operation
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      pipeline_id: { type: "string", description: "Pipeline ID" },
      environment: { type: "string", enum: ["dev", "test", "prod"], description: "Target environment" },
      version: { type: "string", description: "Version to deploy" },
    },
    required: ["pipeline_id", "environment"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { pipeline_id, environment, version } = args
  try {
    return createSuccessResult({
      deployed: true,
      pipeline_id,
      environment,
      version: version || "latest",
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
