/**
 * snow_trigger_scheduled_job - Trigger an existing scheduled job
 *
 * ⚠️ IMPORTANT: This tool triggers jobs via sys_trigger, not direct execution.
 * The job will be picked up by the ServiceNow scheduler.
 *
 * How it works:
 * 1. Verifies the scheduled job exists
 * 2. Creates a sys_trigger to run it immediately
 * 3. Returns success - but job runs asynchronously via scheduler
 *
 * Note: The job may not run instantly if scheduler is busy.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_trigger_scheduled_job",
  description:
    "⚠️ UNRELIABLE: Attempts to trigger a scheduled job via sys_trigger, but CANNOT guarantee execution. The job runs asynchronously when the ServiceNow scheduler picks it up — this frequently times out. Do NOT rely on this for verification or testing. Only use when you need to trigger a specific existing scheduled job and can accept that it may not run.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "scheduling",
  use_cases: ["job-execution", "testing", "manual-trigger"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      job_sys_id: {
        type: "string",
        description: "Scheduled job sys_id (from sysauto_script table)",
      },
      wait_for_completion: {
        type: "boolean",
        description: "Wait and poll for job completion (max 60 seconds)",
        default: false,
      },
    },
    required: ["job_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { job_sys_id, wait_for_completion = false } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Step 1: Verify the scheduled job exists
    const jobResponse = await client.get(`/api/now/table/sysauto_script/${job_sys_id}`, {
      params: {
        sysparm_fields: "name,sys_id,active,run_type",
      },
    })

    if (!jobResponse.data?.result) {
      throw new SnowFlowError(ErrorType.NOT_FOUND, `Scheduled job not found: ${job_sys_id}`, { retryable: false })
    }

    const job = jobResponse.data.result

    // Step 2: Create sys_trigger to execute immediately
    const now = new Date()
    const triggerTime = new Date(now.getTime() + 2000) // 2 seconds from now
    const triggerTimeStr = triggerTime.toISOString().replace("T", " ").substring(0, 19)

    const triggerResponse = await client.post("/api/now/table/sys_trigger", {
      name: `Serac Trigger - ${job.name}`,
      next_action: triggerTimeStr,
      trigger_type: 0, // Run Once
      state: 0, // Ready
      document: "sysauto_script",
      document_key: job_sys_id,
      claimed_by: "",
      system_id: "snow-flow",
    })

    const triggerCreated = !!triggerResponse.data?.result?.sys_id

    if (!triggerCreated) {
      return createSuccessResult(
        {
          triggered: false,
          job_sys_id,
          job_name: job.name,
          message:
            "Could not create sys_trigger. You may not have permission to create triggers. Run the job manually via System Scheduler > Scheduled Jobs.",
          manual_url: `/sysauto_script.do?sys_id=${job_sys_id}`,
        },
        {
          operation: "trigger_scheduled_job",
          method: "sys_trigger_failed",
        },
      )
    }

    // Step 3: Optionally wait for completion
    if (wait_for_completion) {
      // Poll sys_trigger to see if it was executed
      const startTime = Date.now()
      const maxWait = 60000 // 60 seconds

      while (Date.now() - startTime < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, 3000))

        try {
          const triggerCheck = await client.get(`/api/now/table/sys_trigger/${triggerResponse.data.result.sys_id}`, {
            params: { sysparm_fields: "state,next_action" },
          })

          // State 2 = Executed, State 3 = Error
          if (triggerCheck.data?.result?.state === "2" || triggerCheck.data?.result?.state === "3") {
            return createSuccessResult(
              {
                triggered: true,
                executed: true,
                job_sys_id,
                job_name: job.name,
                trigger_sys_id: triggerResponse.data.result.sys_id,
                final_state: triggerCheck.data.result.state === "2" ? "completed" : "error",
                message: "Job trigger was processed by scheduler",
              },
              {
                operation: "trigger_scheduled_job",
                method: "sys_trigger_completed",
              },
            )
          }
        } catch (pollError) {
          // Trigger may have been deleted after execution
          break
        }
      }
    }

    return createSuccessResult(
      {
        triggered: true,
        job_sys_id,
        job_name: job.name,
        trigger_sys_id: triggerResponse.data.result.sys_id,
        message: "Trigger created successfully. Job will run when scheduler picks it up.",
        note: "Use wait_for_completion=true to poll for completion status",
      },
      {
        operation: "trigger_scheduled_job",
        method: "sys_trigger",
      },
    )
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, error.message, { originalError: error }),
    )
  }
}

export const version = "2.0.0"
export const author = "Serac SDK"
