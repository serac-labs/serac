/**
 * snow_define_kpi - Define KPIs (Key Performance Indicators)
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_define_kpi",
  description: "Define Key Performance Indicators for monitoring",
  // Metadata for tool discovery (not sent to LLM)
  category: "reporting",
  subcategory: "kpi",
  use_cases: ["kpi", "monitoring", "metrics"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Definition function - creates KPI definition in ServiceNow
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "KPI name" },
      description: { type: "string", description: "KPI description" },
      table: { type: "string", description: "Source table" },
      metric: { type: "string", description: "Metric to measure" },
      aggregation: {
        type: "string",
        description: "Aggregation function",
        enum: ["count", "sum", "avg", "max", "min"],
      },
      conditions: { type: "string", description: "KPI conditions/filters" },
      target: { type: "number", description: "Target value" },
      threshold: { type: "object", description: "Threshold configuration" },
      unit: { type: "string", description: "Unit of measurement" },
      frequency: { type: "string", description: "Update frequency", enum: ["hourly", "daily", "weekly", "monthly"] },
    },
    required: ["name", "table", "metric", "aggregation"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    description,
    table,
    metric,
    aggregation,
    conditions,
    target,
    threshold,
    unit,
    frequency = "daily",
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Create KPI using pa_indicators table
    const kpiData: any = {
      name,
      label: name,
      description: description || "",
      facts_table: table,
      field: metric,
      aggregate: aggregation.toUpperCase(),
      conditions: conditions || "",
      unit: unit || "",
      frequency,
      active: true,
      direction: target ? "minimize" : "maximize",
    }

    if (target) {
      kpiData.target = target
    }

    if (threshold) {
      kpiData.threshold_config = JSON.stringify(threshold)
    }

    const response = await client.post("/api/now/table/pa_indicators", kpiData)

    return createSuccessResult({
      created: true,
      kpi: response.data.result,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
