/**
 * snow_schedule_job - Scheduled job creation
 *
 * Create scheduled jobs with cron expressions, repeat intervals,
 * and conditional execution logic.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_schedule_job",
  description: "Create scheduled job with cron expression or repeat interval",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "scheduling",
  use_cases: ["automation", "scheduling", "jobs"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Job name",
      },
      script: {
        type: "string",
        description: "Script to execute (ES5 only)",
      },
      description: {
        type: "string",
        description: "Job description",
      },
      schedule_type: {
        type: "string",
        enum: ["daily", "weekly", "monthly", "periodically", "run_once", "on_demand"],
        description: "Schedule type",
        default: "periodically",
      },
      repeat_interval: {
        type: "number",
        description: "Repeat interval in seconds (for periodically type)",
        default: 3600,
      },
      time: {
        type: "string",
        description: "Time to run (HH:MM:SS format for daily/weekly/monthly)",
      },
      day_of_week: {
        type: "string",
        description: "Day of week for weekly schedule (1=Monday, 7=Sunday)",
      },
      day_of_month: {
        type: "number",
        description: "Day of month for monthly schedule (1-31)",
        minimum: 1,
        maximum: 31,
      },
      conditional_script: {
        type: "string",
        description: "Condition script that must return true to execute (ES5)",
      },
      active: {
        type: "boolean",
        description: "Activate the job immediately",
        default: true,
      },
    },
    required: ["name", "script"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    script,
    description = "",
    schedule_type = "periodically",
    repeat_interval = 3600,
    time,
    day_of_week,
    day_of_month,
    conditional_script,
    active = true,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Build scheduled job data
    const jobData: any = {
      name,
      script,
      description,
      active,
    }

    // Configure schedule based on type
    switch (schedule_type) {
      case "daily":
        jobData.run_type = "daily"
        jobData.run_time = time || "00:00:00"
        break

      case "weekly":
        jobData.run_type = "weekly"
        jobData.run_time = time || "00:00:00"
        jobData.run_dayofweek = day_of_week || "1"
        break

      case "monthly":
        jobData.run_type = "monthly"
        jobData.run_time = time || "00:00:00"
        jobData.run_dayofmonth = day_of_month || 1
        break

      case "periodically":
        jobData.run_type = "periodically"
        jobData.repeat_interval = repeat_interval
        break

      case "run_once":
        jobData.run_type = "run_once"
        jobData.run_start = new Date().toISOString()
        break

      case "on_demand":
        jobData.run_type = "on_demand"
        break
    }

    // Add conditional script if provided
    if (conditional_script) {
      jobData.condition = conditional_script
    }

    // Create scheduled job
    const response = await client.post("/api/now/table/sysauto_script", jobData)
    const scheduledJob = response.data.result

    // Calculate next run time if applicable
    let nextRunInfo = null
    if (schedule_type !== "on_demand" && active) {
      nextRunInfo = calculateNextRun(schedule_type, {
        time,
        day_of_week,
        day_of_month,
        repeat_interval,
      })
    }

    return createSuccessResult({
      created: true,
      scheduled_job: {
        sys_id: scheduledJob.sys_id,
        name: scheduledJob.name,
        schedule_type,
        active: scheduledJob.active === "true",
        next_run: nextRunInfo,
      },
      schedule_details: {
        type: schedule_type,
        repeat_interval: schedule_type === "periodically" ? repeat_interval : undefined,
        time: time,
        day_of_week: day_of_week,
        day_of_month: day_of_month,
      },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function calculateNextRun(scheduleType: string, config: any): any {
  const now = new Date()
  let nextRun = new Date()

  switch (scheduleType) {
    case "daily":
      const [hours, minutes] = (config.time || "00:00:00").split(":")
      nextRun.setHours(parseInt(hours), parseInt(minutes), 0, 0)
      if (nextRun <= now) {
        nextRun.setDate(nextRun.getDate() + 1)
      }
      break

    case "weekly":
      // Simplified calculation
      nextRun.setDate(now.getDate() + 1)
      break

    case "monthly":
      nextRun.setDate(config.day_of_month || 1)
      if (nextRun <= now) {
        nextRun.setMonth(nextRun.getMonth() + 1)
      }
      break

    case "periodically":
      nextRun = new Date(now.getTime() + config.repeat_interval * 1000)
      break

    case "run_once":
      nextRun = now
      break
  }

  return {
    estimated_next_run: nextRun.toISOString(),
    schedule_description: getScheduleDescription(scheduleType, config),
  }
}

function getScheduleDescription(scheduleType: string, config: any): string {
  switch (scheduleType) {
    case "daily":
      return `Runs daily at ${config.time || "00:00:00"}`
    case "weekly":
      return `Runs weekly on day ${config.day_of_week || "1"} at ${config.time || "00:00:00"}`
    case "monthly":
      return `Runs monthly on day ${config.day_of_month || "1"} at ${config.time || "00:00:00"}`
    case "periodically":
      return `Runs every ${config.repeat_interval} seconds`
    case "run_once":
      return "Runs once immediately"
    case "on_demand":
      return "Runs on demand only"
    default:
      return "Custom schedule"
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
