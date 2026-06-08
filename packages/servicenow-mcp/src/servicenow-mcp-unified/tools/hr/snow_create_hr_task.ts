/**
 * snow_create_hr_task - Create HR task
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_hr_task",
  description: "Create HR task for case fulfillment",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "hr",
  use_cases: ["hr-service-delivery", "task-management", "case-fulfillment"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      hr_case: { type: "string", description: "Parent HR case sys_id" },
      type: { type: "string", description: "Task type" },
      assigned_to: { type: "string", description: "Assigned user sys_id" },
      short_description: { type: "string", description: "Task description" },
      due_date: { type: "string", description: "Due date" },
      instructions: { type: "string", description: "Task instructions" },
    },
    required: ["hr_case", "type", "short_description"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { hr_case, type, assigned_to, short_description, due_date, instructions } = args
  try {
    const client = await getAuthenticatedClient(context)

    const taskData: any = { hr_case, type, short_description }
    if (assigned_to) taskData.assigned_to = assigned_to
    if (due_date) taskData.due_date = due_date
    if (instructions) taskData.instructions = instructions

    const response = await client.post("/api/now/table/sn_hr_core_task", taskData)
    return createSuccessResult({ created: true, task: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
