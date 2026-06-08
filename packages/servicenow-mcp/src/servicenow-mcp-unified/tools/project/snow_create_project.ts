/**
 * snow_create_project
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_project",
  description: "Create a PPM project (pm_project) with name, description, planned start/end dates, and a project manager (sys_user). Container for project tasks created via snow_create_project_task.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "project-management",
  use_cases: ["project-management", "ppm", "project-creation"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      start_date: { type: "string" },
      end_date: { type: "string" },
      project_manager: { type: "string" },
    },
    required: ["name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, description, start_date, end_date, project_manager } = args
  try {
    const client = await getAuthenticatedClient(context)
    const projectData: any = { name, description }
    if (start_date) projectData.start_date = start_date
    if (end_date) projectData.end_date = end_date
    if (project_manager) projectData.project_manager = project_manager
    const response = await client.post("/api/now/table/pm_project", projectData)
    return createSuccessResult({ created: true, project: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
