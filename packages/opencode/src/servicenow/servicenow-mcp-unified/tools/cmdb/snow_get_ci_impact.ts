/**
 * snow_get_ci_impact - Calculate CI impact analysis
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_ci_impact",
  description: "Calculate impact analysis for CI outage",
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "impact-analysis",
  use_cases: ["cmdb", "impact", "analysis"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      ci_sys_id: { type: "string", description: "CI sys_id" },
      include_services: { type: "boolean", description: "Include business services", default: true },
    },
    required: ["ci_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { ci_sys_id, include_services = true } = args
  try {
    const client = await getAuthenticatedClient(context)
    const relResponse = await client.get("/api/now/table/cmdb_rel_ci", {
      params: { sysparm_query: `child=${ci_sys_id}`, sysparm_limit: 100 },
    })
    const impactedCIs = relResponse.data.result
    return createSuccessResult({ ci_sys_id, impacted_count: impactedCIs.length, impacted_cis: impactedCIs })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
