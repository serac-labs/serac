/**
 * snow_workflow_analyze - Workflow execution analysis
 *
 * Analyze workflow executions for performance bottlenecks,
 * error patterns, and optimization opportunities.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_workflow_analyze",
  description: "Analyze workflow executions for performance and errors",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "workflow",
  use_cases: ["integration", "workflow", "analysis"],
  complexity: "advanced",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      workflow_name: {
        type: "string",
        description: "Workflow name or sys_id",
      },
      time_range_hours: {
        type: "number",
        description: "Analyze executions from last N hours",
        default: 24,
      },
      include_performance: {
        type: "boolean",
        description: "Include performance analysis",
        default: true,
      },
      include_errors: {
        type: "boolean",
        description: "Include error analysis",
        default: true,
      },
    },
    required: ["workflow_name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { workflow_name, time_range_hours = 24, include_performance = true, include_errors = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Get workflow definition
    let workflowSysId = workflow_name
    if (workflow_name.length !== 32) {
      const wfResponse = await client.get("/api/now/table/wf_workflow", {
        params: {
          sysparm_query: `name=${workflow_name}`,
          sysparm_fields: "sys_id,name",
          sysparm_limit: 1,
        },
      })
      if (wfResponse.data.result && wfResponse.data.result.length > 0) {
        workflowSysId = wfResponse.data.result[0].sys_id
      }
    }

    // Calculate time range
    const startTime = new Date(Date.now() - time_range_hours * 60 * 60 * 1000).toISOString()

    // Get workflow context executions
    const executionsResponse = await client.get("/api/now/table/wf_context", {
      params: {
        sysparm_query: `workflow=${workflowSysId}^started>javascript:gs.dateGenerate('${startTime}')`,
        sysparm_fields: "sys_id,state,started,ended,duration",
        sysparm_limit: 1000,
      },
    })

    const executions = executionsResponse.data.result || []

    const analysis: any = {
      workflow_name,
      workflow_sys_id: workflowSysId,
      time_range_hours,
      total_executions: executions.length,
    }

    // State distribution
    const stateCount: Record<string, number> = {}
    executions.forEach((exec: any) => {
      stateCount[exec.state] = (stateCount[exec.state] || 0) + 1
    })

    analysis.state_distribution = stateCount
    analysis.success_rate =
      executions.length > 0 ? (((stateCount["finished"] || 0) / executions.length) * 100).toFixed(2) + "%" : "0%"

    // Performance analysis
    if (include_performance) {
      const durations = executions.filter((exec: any) => exec.duration).map((exec: any) => parseInt(exec.duration))

      if (durations.length > 0) {
        durations.sort((a: number, b: number) => a - b)

        analysis.performance = {
          average_duration_ms: Math.round(durations.reduce((a: number, b: number) => a + b, 0) / durations.length),
          median_duration_ms: durations[Math.floor(durations.length / 2)],
          min_duration_ms: durations[0],
          max_duration_ms: durations[durations.length - 1],
          p95_duration_ms: durations[Math.floor(durations.length * 0.95)],
        }

        // Identify slow executions
        const slowThreshold = analysis.performance.p95_duration_ms
        const slowExecutions = executions.filter((exec: any) => parseInt(exec.duration) > slowThreshold)

        analysis.performance.slow_executions_count = slowExecutions.length
      }
    }

    // Error analysis
    if (include_errors) {
      const errorStates = ["error", "cancelled", "waiting"]
      const errorExecutions = executions.filter((exec: any) => errorStates.includes(exec.state))

      analysis.error_analysis = {
        total_errors: errorExecutions.length,
        error_rate:
          executions.length > 0 ? ((errorExecutions.length / executions.length) * 100).toFixed(2) + "%" : "0%",
        error_types: errorStates.map((state) => ({
          state,
          count: stateCount[state] || 0,
        })),
      }

      // Get specific error messages if available
      if (errorExecutions.length > 0) {
        const errorSample = errorExecutions.slice(0, 5)
        analysis.error_analysis.sample_errors = errorSample.map((exec: any) => ({
          sys_id: exec.sys_id,
          state: exec.state,
          started: exec.started,
        }))
      }
    }

    // Recommendations
    const recommendations = []

    if (analysis.error_analysis && parseFloat(analysis.error_analysis.error_rate) > 10) {
      recommendations.push({
        priority: "high",
        type: "error_rate",
        message: `High error rate (${analysis.error_analysis.error_rate}) - review workflow logic and error handling`,
      })
    }

    if (analysis.performance?.p95_duration_ms > 60000) {
      recommendations.push({
        priority: "medium",
        type: "performance",
        message: "Workflow executions are slow - consider optimization or parallelization",
      })
    }

    if (executions.length === 0) {
      recommendations.push({
        priority: "info",
        type: "no_data",
        message: `No executions found in the last ${time_range_hours} hours`,
      })
    }

    analysis.recommendations = recommendations

    return createSuccessResult({
      analysis,
      health_score: calculateHealthScore(analysis),
      action_required: recommendations.some((r) => r.priority === "high"),
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function calculateHealthScore(analysis: any): string {
  let score = 100

  if (analysis.error_analysis) {
    const errorRate = parseFloat(analysis.error_analysis.error_rate)
    score -= Math.min(errorRate * 2, 40) // Max 40 point deduction
  }

  if (analysis.performance?.p95_duration_ms > 30000) {
    score -= 20
  } else if (analysis.performance?.p95_duration_ms > 10000) {
    score -= 10
  }

  if (score >= 90) return "excellent"
  if (score >= 70) return "good"
  if (score >= 50) return "moderate"
  return "poor"
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
