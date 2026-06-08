/**
 * snow_monitor_metrics
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_monitor_metrics",
  description: "Monitor system metrics and performance indicators",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "monitoring",
  use_cases: ["metrics", "monitoring", "performance"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      metric_type: { type: "string", enum: ["cpu", "memory", "database", "transactions"], description: "Metric type" },
      time_range: { type: "string", description: "Time range for metrics" },
    },
    required: ["metric_type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { metric_type, time_range = "1hour" } = args
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.get("/api/now/table/metric", {
      params: {
        sysparm_query: `type=${metric_type}^created_at>javascript:gs.hoursAgo(1)`,
        sysparm_limit: 100,
      },
    })
    return createSuccessResult({ metrics: response.data.result, metric_type, time_range })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
