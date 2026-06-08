/**
 * snow_velocity_tracking - Velocity tracking
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_velocity_tracking",
  description: "Track team velocity and delivery metrics",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "devops",
  use_cases: ["devops", "metrics", "velocity"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      team: { type: "string", description: "Team name" },
      sprint: { type: "string", description: "Sprint identifier" },
      story_points: { type: "number", description: "Story points completed" },
      deployments: { type: "number", description: "Number of deployments" },
      lead_time: { type: "number", description: "Average lead time in hours" },
      mttr: { type: "number", description: "Mean time to recovery in minutes" },
    },
    required: ["team"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { team, sprint, story_points, deployments, lead_time, mttr } = args
  try {
    const client = await getAuthenticatedClient(context)

    const velocityData: any = { team }
    if (sprint) velocityData.sprint = sprint
    if (story_points) velocityData.story_points = story_points
    if (deployments) velocityData.deployments = deployments
    if (lead_time) velocityData.lead_time = lead_time
    if (mttr) velocityData.mttr = mttr

    const response = await client.post("/api/now/table/sn_devops_velocity", velocityData)
    return createSuccessResult({ tracked: true, velocity: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
