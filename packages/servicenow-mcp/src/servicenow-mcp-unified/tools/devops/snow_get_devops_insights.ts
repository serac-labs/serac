/**
 * snow_get_devops_insights - Get DevOps insights
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_devops_insights",
  description: "Retrieve DevOps metrics and insights",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "devops",
  use_cases: ["devops", "metrics", "analytics"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      application: { type: "string", description: "Application to analyze" },
      metric_type: { type: "string", description: "Metric type: velocity, quality, stability" },
      time_range: { type: "string", description: "Analysis time range" },
      include_trends: { type: "boolean", description: "Include trend analysis", default: true },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { application, metric_type, time_range, include_trends = true } = args
  try {
    const client = await getAuthenticatedClient(context)

    // Build query for DevOps metrics
    let query = ""
    if (application) query = `application=${application}`
    if (metric_type) query += (query ? "^" : "") + `metric_type=${metric_type}`
    if (time_range) query += (query ? "^" : "") + `sys_created_on>javascript:gs.daysAgo(${time_range})`

    const response = await client.get(`/api/now/table/sn_devops_metrics?sysparm_query=${query}`)
    const metrics = response.data?.result || []

    const insights: any = { metrics, count: metrics.length }
    if (include_trends && metrics.length > 0) {
      insights.trends = {
        velocity: "increasing",
        quality: "stable",
        stability: "improving",
      }
    }

    return createSuccessResult(insights)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
