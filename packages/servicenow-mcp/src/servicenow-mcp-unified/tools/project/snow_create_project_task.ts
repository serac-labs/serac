/**
 * snow_create_project_task
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_project_task",
  description: "Add a task to an existing PPM project (pm_project_task) with short description, optional assignee, and planned_hours. Use snow_create_project to make the parent project first.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "project-management",
  use_cases: ["project-tasks", "ppm", "task-management"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string" },
      short_description: { type: "string" },
      assigned_to: { type: "string" },
      planned_hours: { type: "number" },
    },
    required: ["project", "short_description"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { project, short_description, assigned_to, planned_hours } = args
  try {
    const client = await getAuthenticatedClient(context)
    const taskData: any = { project, short_description }
    if (assigned_to) taskData.assigned_to = assigned_to
    if (planned_hours) taskData.planned_hours = planned_hours
    const response = await client.post("/api/now/table/pm_project_task", taskData)
    return createSuccessResult({ created: true, task: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
