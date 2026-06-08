/**
 * snow_get_flow_execution_logs - View Flow Designer execution history
 *
 * Retrieve Flow Designer execution logs to monitor flow runs,
 * debug failures, and analyze performance.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_flow_execution_logs",
  description:
    "Retrieve Flow Designer execution logs for monitoring flow runs, debugging failures, and analyzing performance",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "monitoring",
  use_cases: ["flow-designer", "automation", "monitoring", "debugging"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["complete", "error", "cancelled", "in_progress", "waiting", "all"],
        description: "Filter by execution status",
        default: "all",
      },
      flow_name: {
        type: "string",
        description: "Filter by flow name (partial match)",
      },
      source_table: {
        type: "string",
        description: "Filter by source table that triggered the flow (e.g., incident, change_request)",
      },
      source_record: {
        type: "string",
        description: "Filter by specific source record sys_id",
      },
      trigger_type: {
        type: "string",
        enum: ["record", "scheduled", "application", "inbound_email", "rest", "all"],
        description: "Filter by trigger type",
        default: "all",
      },
      limit: {
        type: "number",
        description: "Maximum number of execution records to return",
        default: 50,
        minimum: 1,
        maximum: 500,
      },
      since: {
        type: "string",
        description: 'Get executions since this timestamp (ISO 8601 or relative like "1h", "30m", "7d")',
      },
      errors_only: {
        type: "boolean",
        description: "Only show failed executions with errors",
        default: false,
      },
      include_logs: {
        type: "boolean",
        description: "Include detailed execution logs (can be verbose)",
        default: false,
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var status = args.status || "all"
  var flow_name = args.flow_name
  var source_table = args.source_table
  var source_record = args.source_record
  var trigger_type = args.trigger_type || "all"
  var limit = args.limit || 50
  var since = args.since
  var errors_only = args.errors_only || false
  var include_logs = args.include_logs || false

  try {
    var client = await getAuthenticatedClient(context)

    // Build query for sys_flow_context
    var queryParts: string[] = []

    // Status filter
    if (status !== "all") {
      queryParts.push("state=" + status)
    }

    // Errors only filter
    if (errors_only) {
      queryParts.push("state=error")
    }

    // Source table filter
    if (source_table) {
      queryParts.push("source_table=" + source_table)
    }

    // Source record filter
    if (source_record) {
      queryParts.push("source_record=" + source_record)
    }

    // Trigger type filter
    if (trigger_type !== "all") {
      queryParts.push("trigger_type=" + trigger_type)
    }

    // Time range filter
    if (since) {
      var sinceTimestamp = parseRelativeTime(since)
      queryParts.push("started>" + sinceTimestamp)
    }

    var query = queryParts.join("^")

    // Get flow executions from sys_flow_context
    var response = await client.get("/api/now/table/sys_flow_context", {
      params: {
        sysparm_query: query + "^ORDERBYDESCstarted",
        sysparm_limit: limit,
        sysparm_fields:
          "sys_id,flow,state,started,ended,error_message,trigger_type,source_table,source_record,run_count,sys_created_by",
        sysparm_display_value: "all",
      },
    })

    // Filter by flow name if specified (need to do client-side since it's a reference field)
    var executions = response.data.result
    if (flow_name) {
      executions = executions.filter(function (exec: any) {
        var flowDisplayValue = exec.flow && exec.flow.display_value ? exec.flow.display_value : ""
        return flowDisplayValue.toLowerCase().indexOf(flow_name.toLowerCase()) !== -1
      })
    }

    // Map to clean format
    var logs = executions.map(function (exec: any) {
      var startTime = exec.started && exec.started.display_value ? new Date(exec.started.display_value) : null
      var endTime = exec.ended && exec.ended.display_value ? new Date(exec.ended.display_value) : null
      var duration = null

      if (startTime && endTime) {
        duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000)
      }

      return {
        sys_id: exec.sys_id,
        flow_name: exec.flow && exec.flow.display_value ? exec.flow.display_value : "Unknown",
        flow_sys_id: exec.flow && exec.flow.value ? exec.flow.value : null,
        state: exec.state && exec.state.display_value ? exec.state.display_value : exec.state,
        started: exec.started && exec.started.display_value ? exec.started.display_value : null,
        ended: exec.ended && exec.ended.display_value ? exec.ended.display_value : null,
        duration_seconds: duration,
        trigger_type:
          exec.trigger_type && exec.trigger_type.display_value ? exec.trigger_type.display_value : exec.trigger_type,
        source_table: exec.source_table,
        source_record: exec.source_record && exec.source_record.value ? exec.source_record.value : exec.source_record,
        run_count: exec.run_count,
        created_by: exec.sys_created_by,
        error_message: exec.error_message || null,
      }
    })

    // Optionally fetch detailed logs for each execution
    if (include_logs && logs.length > 0 && logs.length <= 10) {
      for (var i = 0; i < logs.length; i++) {
        var logResponse = await client.get("/api/now/table/sys_flow_log", {
          params: {
            sysparm_query: "context=" + logs[i].sys_id + "^ORDERBYsys_created_on",
            sysparm_limit: 50,
            sysparm_fields: "sys_created_on,level,message,step",
          },
        })

        logs[i].execution_logs = logResponse.data.result.map(function (log: any) {
          return {
            timestamp: log.sys_created_on,
            level: log.level,
            message: log.message,
            step: log.step,
          }
        })
      }
    }

    // Calculate statistics
    var stats = {
      total: logs.length,
      complete: 0,
      error: 0,
      cancelled: 0,
      in_progress: 0,
      waiting: 0,
      avg_duration_seconds: 0,
    }

    var totalDuration = 0
    var durationCount = 0

    logs.forEach(function (log: any) {
      var state = (log.state || "").toLowerCase()
      if (state === "complete") stats.complete++
      else if (state === "error") stats.error++
      else if (state === "cancelled") stats.cancelled++
      else if (state === "in_progress" || state === "in progress") stats.in_progress++
      else if (state === "waiting") stats.waiting++

      if (log.duration_seconds !== null) {
        totalDuration += log.duration_seconds
        durationCount++
      }
    })

    if (durationCount > 0) {
      stats.avg_duration_seconds = Math.round(totalDuration / durationCount)
    }

    // Group by flow name
    var byFlow: any = {}
    logs.forEach(function (log: any) {
      var flowName = log.flow_name || "Unknown"
      if (!byFlow[flowName]) {
        byFlow[flowName] = { total: 0, errors: 0 }
      }
      byFlow[flowName].total++
      if ((log.state || "").toLowerCase() === "error") {
        byFlow[flowName].errors++
      }
    })

    // Get error summary
    var errorSummary: any[] = []
    logs.forEach(function (log: any) {
      if (log.error_message) {
        errorSummary.push({
          flow_name: log.flow_name,
          error: log.error_message,
          timestamp: log.started,
          sys_id: log.sys_id,
        })
      }
    })

    return createSuccessResult({
      executions: logs,
      count: logs.length,
      statistics: stats,
      by_flow: byFlow,
      recent_errors: errorSummary.slice(0, 10),
      filters: {
        status: status,
        flow_name: flow_name,
        source_table: source_table,
        trigger_type: trigger_type,
        since: since,
        errors_only: errors_only,
      },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function parseRelativeTime(relative: string): string {
  var now = new Date()
  var match = relative.match(/^(\d+)([mhd])$/)

  if (!match) {
    // Assume it's an absolute timestamp
    return relative
  }

  var value = parseInt(match[1])
  var unit = match[2]

  var milliseconds = 0
  switch (unit) {
    case "m":
      milliseconds = value * 60 * 1000
      break
    case "h":
      milliseconds = value * 60 * 60 * 1000
      break
    case "d":
      milliseconds = value * 24 * 60 * 60 * 1000
      break
  }

  var sinceDate = new Date(now.getTime() - milliseconds)
  return sinceDate.toISOString()
}

export const version = "1.0.0"
export const author = "Serac Team"
