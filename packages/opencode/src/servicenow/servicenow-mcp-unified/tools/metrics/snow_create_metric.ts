/**
 * snow_create_metric
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_metric",
  description: "Define a metric (metric_definition) over a table — count rows, or sum/avg/min/max a numeric field. Stored definition is later sampled by snow_collect_metric or platform schedulers.",
  // Metadata for tool discovery (not sent to LLM)
  category: "reporting",
  subcategory: "metrics",
  use_cases: ["metrics", "analytics", "monitoring"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Metric name" },
      table: { type: "string", description: "Table to measure" },
      field: { type: "string", description: "Field to measure" },
      calculation: { type: "string", enum: ["count", "sum", "avg", "min", "max"], default: "count" },
    },
    required: ["name", "table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, table, field, calculation = "count" } = args
  try {
    const client = await getAuthenticatedClient(context)
    const metricData: any = { name, table, calculation }
    if (field) metricData.field = field
    const response = await client.post("/api/now/table/metric_definition", metricData)
    return createSuccessResult({ created: true, metric: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
