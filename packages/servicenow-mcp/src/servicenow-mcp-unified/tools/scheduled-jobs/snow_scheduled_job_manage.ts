/**
 * snow_scheduled_job_manage - Comprehensive scheduled job management
 *
 * Manage ServiceNow scheduled jobs (sysauto_script) with full CRUD operations,
 * execution control, and debugging capabilities.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_scheduled_job_manage",
  description: "Manage scheduled jobs: list, get details, create, update, delete, enable/disable, run now, get history",
  category: "automation",
  subcategory: "scheduled-jobs",
  use_cases: ["scheduled-jobs", "automation", "background-processing"],
  complexity: "intermediate",
  frequency: "high",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "list",
          "get",
          "create",
          "update",
          "delete",
          "enable",
          "disable",
          "run_now",
          "get_history",
          "get_next_run",
        ],
        description: "Action to perform",
      },
      job_id: {
        type: "string",
        description: "Job sys_id or name (required for get, update, delete, enable, disable, run_now, get_history)",
      },
      name: {
        type: "string",
        description: "Job name (for create/update)",
      },
      script: {
        type: "string",
        description: "Script to execute (ES5 JavaScript)",
      },
      run_type: {
        type: "string",
        enum: ["daily", "weekly", "monthly", "periodically", "once", "on_demand"],
        description: "How often to run",
      },
      run_time: {
        type: "string",
        description: "Time to run (HH:MM:SS format for daily/weekly/monthly)",
      },
      run_dayofweek: {
        type: "number",
        description: "Day of week (1=Sunday, 7=Saturday) for weekly jobs",
      },
      run_dayofmonth: {
        type: "number",
        description: "Day of month (1-31) for monthly jobs",
      },
      run_period: {
        type: "string",
        description: 'Period for periodic jobs (e.g., "00:05:00" for every 5 minutes)',
      },
      run_start: {
        type: "string",
        description: "Start date/time for one-time jobs (YYYY-MM-DD HH:MM:SS)",
      },
      conditional: {
        type: "boolean",
        description: "Whether job has a condition script",
        default: false,
      },
      condition: {
        type: "string",
        description: "Condition script (job only runs if this returns true)",
      },
      active: {
        type: "boolean",
        description: "Whether job is active",
        default: true,
      },
      active_only: {
        type: "boolean",
        description: "Only list active jobs",
        default: false,
      },
      limit: {
        type: "number",
        description: "Max results for list/get_history",
        default: 50,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    action,
    job_id,
    name,
    script,
    run_type,
    run_time,
    run_dayofweek,
    run_dayofmonth,
    run_period,
    run_start,
    conditional = false,
    condition,
    active = true,
    active_only = false,
    limit = 50,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Helper to resolve job name to sys_id
    async function resolveJobId(jobId: string): Promise<string> {
      if (jobId.length === 32 && !/\s/.test(jobId)) return jobId
      const lookup = await client.get("/api/now/table/sysauto_script", {
        params: {
          sysparm_query: "name=" + jobId,
          sysparm_fields: "sys_id",
          sysparm_limit: 1,
        },
      })
      if (!lookup.data.result?.[0]) {
        throw new SnowFlowError(ErrorType.NOT_FOUND, "Scheduled job not found: " + jobId)
      }
      return lookup.data.result[0].sys_id
    }

    switch (action) {
      case "list": {
        var query = ""
        if (active_only) {
          query = "active=true"
        }

        const response = await client.get("/api/now/table/sysauto_script", {
          params: {
            sysparm_query: query + "^ORDERBYname",
            sysparm_fields:
              "sys_id,name,active,run_type,run_time,run_start,run_dayofweek,run_dayofmonth,sys_created_on,sys_updated_on",
            sysparm_limit: limit,
          },
        })

        var jobs = (response.data.result || []).map(function (j: any) {
          return {
            sys_id: j.sys_id,
            name: j.name,
            active: j.active === "true",
            run_type: j.run_type,
            run_time: j.run_time,
            run_start: j.run_start,
            run_dayofweek: j.run_dayofweek,
            run_dayofmonth: j.run_dayofmonth,
            created: j.sys_created_on,
            updated: j.sys_updated_on,
          }
        })

        return createSuccessResult({
          action: "list",
          count: jobs.length,
          jobs: jobs,
        })
      }

      case "get": {
        if (!job_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "job_id is required for get action")
        }

        var getSysId = await resolveJobId(job_id)
        const response = await client.get("/api/now/table/sysauto_script/" + getSysId)
        var job = response.data.result

        // Get next scheduled run from sys_trigger
        const triggerResponse = await client.get("/api/now/table/sys_trigger", {
          params: {
            sysparm_query: "document=" + getSysId,
            sysparm_fields: "next_action,state",
            sysparm_limit: 1,
          },
        })
        var nextRun = triggerResponse.data.result?.[0]

        return createSuccessResult({
          action: "get",
          job: {
            sys_id: job.sys_id,
            name: job.name,
            active: job.active === "true",
            run_type: job.run_type,
            run_time: job.run_time,
            run_start: job.run_start,
            run_dayofweek: job.run_dayofweek,
            run_dayofmonth: job.run_dayofmonth,
            run_period: job.run_period,
            conditional: job.conditional === "true",
            condition: job.condition,
            script: job.script,
            created: job.sys_created_on,
            updated: job.sys_updated_on,
          },
          next_run: nextRun
            ? {
                next_action: nextRun.next_action,
                state: nextRun.state,
              }
            : null,
        })
      }

      case "create": {
        if (!name) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "name is required for create action")
        }
        if (!script) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "script is required for create action")
        }

        var createData: any = {
          name: name,
          script: script,
          active: active,
          run_type: run_type || "on_demand",
        }

        if (run_time) createData.run_time = run_time
        if (run_dayofweek) createData.run_dayofweek = run_dayofweek
        if (run_dayofmonth) createData.run_dayofmonth = run_dayofmonth
        if (run_period) createData.run_period = run_period
        if (run_start) createData.run_start = run_start
        if (conditional) createData.conditional = conditional
        if (condition) createData.condition = condition

        const createResponse = await client.post("/api/now/table/sysauto_script", createData)

        return createSuccessResult({
          action: "create",
          created: true,
          job: {
            sys_id: createResponse.data.result.sys_id,
            name: createResponse.data.result.name,
            run_type: createResponse.data.result.run_type,
          },
        })
      }

      case "update": {
        if (!job_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "job_id is required for update action")
        }

        var updateSysId = await resolveJobId(job_id)

        var updateData: any = {}
        if (name !== undefined) updateData.name = name
        if (script !== undefined) updateData.script = script
        if (run_type !== undefined) updateData.run_type = run_type
        if (run_time !== undefined) updateData.run_time = run_time
        if (run_dayofweek !== undefined) updateData.run_dayofweek = run_dayofweek
        if (run_dayofmonth !== undefined) updateData.run_dayofmonth = run_dayofmonth
        if (run_period !== undefined) updateData.run_period = run_period
        if (run_start !== undefined) updateData.run_start = run_start
        if (conditional !== undefined) updateData.conditional = conditional
        if (condition !== undefined) updateData.condition = condition
        if (active !== undefined) updateData.active = active

        if (Object.keys(updateData).length === 0) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "No fields to update")
        }

        await client.patch("/api/now/table/sysauto_script/" + updateSysId, updateData)

        return createSuccessResult({
          action: "update",
          updated: true,
          job_id: updateSysId,
          fields_updated: Object.keys(updateData),
        })
      }

      case "delete": {
        if (!job_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "job_id is required for delete action")
        }

        var deleteSysId = await resolveJobId(job_id)
        await client.delete("/api/now/table/sysauto_script/" + deleteSysId)

        return createSuccessResult({
          action: "delete",
          deleted: true,
          job_id: deleteSysId,
        })
      }

      case "enable":
      case "disable": {
        if (!job_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "job_id is required for " + action + " action")
        }

        var toggleSysId = await resolveJobId(job_id)
        await client.patch("/api/now/table/sysauto_script/" + toggleSysId, {
          active: action === "enable",
        })

        return createSuccessResult({
          action: action,
          job_id: toggleSysId,
          active: action === "enable",
          message: "Scheduled job " + (action === "enable" ? "enabled" : "disabled"),
        })
      }

      case "run_now": {
        if (!job_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "job_id is required for run_now action")
        }

        var runSysId = await resolveJobId(job_id)

        // Create a trigger to run immediately
        const triggerResponse = await client.post("/api/now/table/sys_trigger", {
          name: "Execute Now: " + runSysId,
          document: runSysId,
          document_key: runSysId,
          trigger_type: 0, // Run once
          next_action: new Date().toISOString().slice(0, 19).replace("T", " "),
          state: 0, // Ready
          claimed_by: "",
        })

        return createSuccessResult({
          action: "run_now",
          job_id: runSysId,
          trigger_id: triggerResponse.data.result?.sys_id,
          message: "Job scheduled for immediate execution",
          note: "Use get_history action to check execution results",
          important:
            "There may be a 30-60 second propagation delay before the job executes and logs appear. If get_history returns empty, wait and try again.",
        })
      }

      case "get_history": {
        if (!job_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "job_id is required for get_history action")
        }

        var historySysId = await resolveJobId(job_id)

        // Get job name for log search
        const jobInfo = await client.get("/api/now/table/sysauto_script/" + historySysId, {
          params: {
            sysparm_fields: "name",
          },
        })
        var jobName = jobInfo.data.result?.name

        // Search scheduler logs
        const logsResponse = await client.get("/api/now/table/syslog", {
          params: {
            sysparm_query: "source=Scheduler^messageLIKE" + jobName + "^ORDERBYDESCsys_created_on",
            sysparm_fields: "sys_id,message,level,sys_created_on",
            sysparm_limit: limit,
          },
        })

        // Get trigger history
        const triggerResponse = await client.get("/api/now/table/sys_trigger", {
          params: {
            sysparm_query: "document=" + historySysId + "^ORDERBYDESCsys_created_on",
            sysparm_fields: "sys_id,next_action,state,last_error,processed,sys_created_on",
            sysparm_limit: limit,
          },
        })

        const logs = (logsResponse.data.result || []).map(function (l: any) {
          return {
            timestamp: l.sys_created_on,
            level: l.level,
            message: l.message,
          }
        })

        const triggers = (triggerResponse.data.result || []).map(function (t: any) {
          return {
            sys_id: t.sys_id,
            next_action: t.next_action,
            state: t.state,
            last_error: t.last_error,
            processed: t.processed,
            created: t.sys_created_on,
          }
        })

        // Add helpful note if no history found
        const noHistoryNote =
          logs.length === 0 && triggers.length === 0
            ? "No execution history found. If you just triggered run_now, there is typically a 30-60 second propagation delay before logs appear. Please wait and try again."
            : undefined

        return createSuccessResult({
          action: "get_history",
          job_id: historySysId,
          job_name: jobName,
          logs,
          triggers,
          note: noHistoryNote,
        })
      }

      case "get_next_run": {
        if (!job_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "job_id is required for get_next_run action")
        }

        var nextSysId = await resolveJobId(job_id)

        const triggerResponse = await client.get("/api/now/table/sys_trigger", {
          params: {
            sysparm_query: "document=" + nextSysId + "^state=0",
            sysparm_fields: "next_action,state",
            sysparm_limit: 1,
          },
        })

        var trigger = triggerResponse.data.result?.[0]

        return createSuccessResult({
          action: "get_next_run",
          job_id: nextSysId,
          next_run: trigger?.next_action || null,
          state: trigger?.state || "not_scheduled",
          message: trigger ? "Next run scheduled for " + trigger.next_action : "No scheduled run found",
        })
      }

      default:
        throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "Unknown action: " + action)
    }
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, error.message, { originalError: error }),
    )
  }
}

export const version = "1.0.0"
export const author = "Serac"
