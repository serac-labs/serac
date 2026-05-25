/**
 * snow_discover_automation_jobs - Discover automation jobs
 *
 * Discovers automation jobs (scheduled scripts, executions) in the instance.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_discover_automation_jobs",
  description: "Discovers automation jobs (scheduled scripts, executions) in the instance.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "discovery",
  use_cases: ["automation", "discovery", "jobs"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Discovery operation - reads metadata
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      active: { type: "boolean", description: "Filter by active status" },
      nameContains: { type: "string", description: "Search by name pattern" },
      limit: { type: "number", description: "Maximum number of jobs to return", default: 50 },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { active, nameContains, limit = 50 } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Build query
    const queryParts: string[] = []

    if (active !== undefined) {
      queryParts.push(`active=${active}`)
    }

    if (nameContains) {
      queryParts.push(`nameLIKE${nameContains}`)
    }

    const query = queryParts.join("^")

    const response = await client.get(
      `/api/now/table/sysauto_script?sysparm_query=${query}&sysparm_limit=${limit}&sysparm_display_value=true`,
    )

    const jobs = response.data.result

    const formattedJobs = jobs.map((job: any) => ({
      sys_id: job.sys_id,
      name: job.name,
      description: job.description,
      active: job.active === "true",
      run_type: job.run_type,
      run_start: job.run_start,
      run_dayofweek: job.run_dayofweek,
      run_time: job.run_time,
      script: job.script ? "(script present)" : null,
      created_on: job.sys_created_on,
      updated_on: job.sys_updated_on,
    }))

    return createSuccessResult({
      found: true,
      count: formattedJobs.length,
      jobs: formattedJobs,
    })
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, error.message, { originalError: error }),
    )
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
