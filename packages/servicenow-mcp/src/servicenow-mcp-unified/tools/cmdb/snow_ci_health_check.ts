/**
 * snow_ci_health_check - CI health monitoring
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_ci_health_check",
  description: "Check CI health and compliance status",
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "monitoring",
  use_cases: ["cmdb", "monitoring", "health"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Health check - validates CI health without modifying
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      ci_sys_id: { type: "string" },
      include_metrics: { type: "boolean", default: true },
    },
    required: ["ci_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { ci_sys_id, include_metrics = true } = args
  try {
    const client = await getAuthenticatedClient(context)
    const ciResponse = await client.get(`/api/now/table/cmdb_ci/${ci_sys_id}`)
    const ci = ciResponse.data.result
    const health = {
      operational_status: ci.operational_status,
      install_status: ci.install_status,
      support_group: ci.support_group,
      last_discovered: ci.last_discovered,
      health_score: calculateHealthScore(ci),
    }
    return createSuccessResult({ ci_sys_id, health, ci_name: ci.name })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function calculateHealthScore(ci: any): number {
  let score = 100
  if (ci.operational_status != "1") score -= 30
  if (!ci.last_discovered) score -= 20
  return Math.max(0, score)
}

export const version = "1.0.0"
