/**
 * snow_collect_metric
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_collect_metric",
  description: "Sample a defined metric on-demand: runs the platform MetricBaseCollector against a metric_definition sys_id to write a fresh measurement point. Companion to snow_create_metric.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "monitoring",
  use_cases: ["metrics", "data-collection", "monitoring"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      metric_sys_id: { type: "string", description: "Metric definition sys_id" },
    },
    required: ["metric_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { metric_sys_id } = args
  try {
    const client = await getAuthenticatedClient(context)
    const collectScript = `
var metric = new GlideRecord('metric_definition');
if (metric.get('${metric_sys_id}')) {
  var collector = new MetricBaseCollector();
  collector.collect(metric);
  gs.info('Metric collected: ' + metric.name);
}
    `
    await client.post("/api/now/table/sys_script_execution", { script: collectScript })
    return createSuccessResult({ collected: true, metric: metric_sys_id })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
