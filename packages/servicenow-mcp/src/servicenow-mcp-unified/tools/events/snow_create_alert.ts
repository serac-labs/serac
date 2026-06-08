/**
 * snow_create_alert
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_alert",
  description: "Create system alert for monitoring",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "event-management",
  use_cases: ["alerts", "monitoring", "notifications"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Alert name" },
      table: { type: "string", description: "Target table" },
      condition: { type: "string", description: "Alert condition" },
      message: { type: "string", description: "Alert message" },
      severity: { type: "number", enum: [1, 2, 3, 4, 5], description: "Alert severity" },
    },
    required: ["name", "table", "condition"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, table, condition, message, severity } = args
  try {
    const client = await getAuthenticatedClient(context)
    const alertData: any = { name, table, condition }
    if (message) alertData.message = message
    if (severity) alertData.severity = severity
    const response = await client.post("/api/now/table/em_alert", alertData)
    return createSuccessResult({ created: true, alert: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
