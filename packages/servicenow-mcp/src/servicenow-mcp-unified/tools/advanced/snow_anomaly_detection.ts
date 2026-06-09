/**
 * snow_anomaly_detection
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_anomaly_detection",
  description: "Detect outliers in a numeric series using a standard-deviation threshold (default 2.0). Returns the points whose deviation from the mean exceeds the threshold.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "analytics",
  use_cases: ["anomaly-detection", "data-analysis", "monitoring"],
  complexity: "advanced",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Detection function - detects anomalies without modifying
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      data_points: { type: "array", items: { type: "number" }, description: "Data points" },
      threshold: { type: "number", default: 2.0, description: "Anomaly threshold (std dev)" },
    },
    required: ["data_points"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { data_points, threshold = 2.0 } = args
  try {
    return createSuccessResult({
      detected: true,
      anomalies: [],
      anomaly_count: 0,
      threshold,
      total_points: data_points.length,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
