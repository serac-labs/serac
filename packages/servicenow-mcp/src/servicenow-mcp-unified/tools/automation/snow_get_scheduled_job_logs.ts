/**
 * snow_get_scheduled_job_logs - View Scheduled Job execution history
 *
 * Retrieve scheduled job execution logs to monitor job runs,
 * identify failures, and track job performance.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_scheduled_job_logs",
  description:
    "Retrieve scheduled job execution history and logs for monitoring automation, identifying failures, and tracking performance",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "monitoring",
  use_cases: ["scheduled-jobs", "automation", "monitoring", "debugging"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      job_name: {
        type: "string",
        description: "Filter by job name (partial match)",
      },
      state: {
        type: "string",
        enum: ["ready", "running", "complete", "error", "cancelled", "all"],
        description: "Filter by job state",
        default: "all",
      },
      job_type: {
        type: "string",
        enum: ["scheduled", "run_once", "on_demand", "all"],
        description: "Filter by job type",
        default: "all",
      },
      include_inactive: {
        type: "boolean",
        description: "Include inactive/disabled jobs",
        default: false,
      },
      limit: {
        type: "number",
        description: "Maximum number of jobs to return",
        default: 50,
        minimum: 1,
        maximum: 200,
      },
      since: {
        type: "string",
        description: 'Get jobs that ran since this timestamp (ISO 8601 or relative like "1h", "30m", "7d")',
      },
      failed_only: {
        type: "boolean",
        description: "Only show jobs that had errors in their last run",
        default: false,
      },
      include_logs: {
        type: "boolean",
        description: "Include recent syslog entries for each job",
        default: false,
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var job_name = args.job_name
  var state = args.state || "all"
  var job_type = args.job_type || "all"
  var include_inactive = args.include_inactive || false
  var limit = args.limit || 50
  var since = args.since
  var failed_only = args.failed_only || false
  var include_logs = args.include_logs || false

  try {
    var client = await getAuthenticatedClient(context)

    // Build query for sys_trigger (scheduled jobs)
    var queryParts: string[] = []

    // Job name filter
    if (job_name) {
      queryParts.push("nameLIKE" + job_name)
    }

    // State filter
    if (state !== "all") {
      queryParts.push("state=" + state)
    }

    // Active filter
    if (!include_inactive) {
      queryParts.push("active=true")
    }

    // Time range filter - jobs that ran since
    if (since) {
      var sinceTimestamp = parseRelativeTime(since)
      queryParts.push("last_run>" + sinceTimestamp)
    }

    // Job type filter (based on trigger_type or run pattern)
    if (job_type === "run_once") {
      queryParts.push("run_type=once")
    } else if (job_type === "on_demand") {
      queryParts.push("run_type=on_demand")
    } else if (job_type === "scheduled") {
      queryParts.push("run_type=periodic")
    }

    var query = queryParts.join("^")

    // Get scheduled jobs from sys_trigger
    var response = await client.get("/api/now/table/sys_trigger", {
      params: {
        sysparm_query: query + "^ORDERBYDESClast_run",
        sysparm_limit: limit,
        sysparm_fields:
          "sys_id,name,state,active,last_run,next_run,run_type,run_count,run_as,script,claimed_by,error_count,run_dayofweek,run_time",
        sysparm_display_value: "all",
      },
    })

    var jobs = response.data.result

    // Map to clean format
    var jobLogs = jobs.map(function (job: any) {
      return {
        sys_id: job.sys_id,
        name: job.name,
        state: job.state && job.state.display_value ? job.state.display_value : job.state,
        active: job.active === "true" || job.active === true,
        last_run: job.last_run && job.last_run.display_value ? job.last_run.display_value : job.last_run,
        next_run: job.next_run && job.next_run.display_value ? job.next_run.display_value : job.next_run,
        run_type: job.run_type,
        run_count: parseInt(job.run_count) || 0,
        error_count: parseInt(job.error_count) || 0,
        run_as: job.run_as && job.run_as.display_value ? job.run_as.display_value : job.run_as,
        schedule: formatSchedule(job),
        claimed_by: job.claimed_by && job.claimed_by.display_value ? job.claimed_by.display_value : null,
        has_errors: (parseInt(job.error_count) || 0) > 0,
      }
    })

    // Filter by failed_only if requested
    if (failed_only) {
      jobLogs = jobLogs.filter(function (job: any) {
        return job.has_errors || job.state === "error"
      })
    }

    // Optionally fetch recent logs for each job
    if (include_logs && jobLogs.length > 0 && jobLogs.length <= 10) {
      for (var i = 0; i < jobLogs.length; i++) {
        var logResponse = await client.get("/api/now/table/syslog", {
          params: {
            sysparm_query: "sourceLIKE" + jobLogs[i].name + "^ORDERBYDESCsys_created_on",
            sysparm_limit: 10,
            sysparm_fields: "sys_created_on,level,message,source",
          },
        })

        jobLogs[i].recent_logs = logResponse.data.result.map(function (log: any) {
          return {
            timestamp: log.sys_created_on,
            level: log.level,
            message: log.message,
          }
        })
      }
    }

    // Calculate statistics
    var stats = {
      total: jobLogs.length,
      active: 0,
      inactive: 0,
      running: 0,
      ready: 0,
      with_errors: 0,
      total_runs: 0,
      total_errors: 0,
    }

    jobLogs.forEach(function (job: any) {
      if (job.active) stats.active++
      else stats.inactive++

      if (job.state === "Running") stats.running++
      if (job.state === "Ready") stats.ready++
      if (job.has_errors) stats.with_errors++

      stats.total_runs += job.run_count
      stats.total_errors += job.error_count
    })

    // Group by state
    var byState: any = {}
    jobLogs.forEach(function (job: any) {
      var jobState = job.state || "Unknown"
      byState[jobState] = (byState[jobState] || 0) + 1
    })

    // Get jobs with most errors
    var errorProne = jobLogs
      .filter(function (job: any) {
        return job.error_count > 0
      })
      .sort(function (a: any, b: any) {
        return b.error_count - a.error_count
      })
      .slice(0, 5)
      .map(function (job: any) {
        return {
          name: job.name,
          error_count: job.error_count,
          run_count: job.run_count,
          error_rate: job.run_count > 0 ? Math.round((job.error_count / job.run_count) * 100) + "%" : "N/A",
        }
      })

    return createSuccessResult({
      jobs: jobLogs,
      count: jobLogs.length,
      statistics: stats,
      by_state: byState,
      error_prone_jobs: errorProne,
      filters: {
        job_name: job_name,
        state: state,
        job_type: job_type,
        include_inactive: include_inactive,
        since: since,
        failed_only: failed_only,
      },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function formatSchedule(job: any): string {
  if (job.run_type === "once") {
    return "Run once"
  } else if (job.run_type === "on_demand") {
    return "On demand"
  }

  var schedule = ""
  if (job.run_dayofweek) {
    // Handle both string and object (display_value) formats
    var dayOfWeekValue =
      typeof job.run_dayofweek === "string"
        ? job.run_dayofweek
        : job.run_dayofweek.value || job.run_dayofweek.display_value || ""

    if (dayOfWeekValue && typeof dayOfWeekValue === "string") {
      var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
      var dayNums = dayOfWeekValue.split(",")
      var dayNames = dayNums.map(function (d: string) {
        return days[parseInt(d) - 1] || d
      })
      schedule = dayNames.join(", ")
    }
  }
  if (job.run_time) {
    var runTimeValue =
      typeof job.run_time === "string" ? job.run_time : job.run_time.value || job.run_time.display_value || ""
    schedule += (schedule ? " at " : "") + runTimeValue
  }
  return schedule || "Periodic"
}

function parseRelativeTime(relative: string): string {
  var now = new Date()
  var match = relative.match(/^(\d+)([mhd])$/)

  if (!match) {
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
