/**
 * snow_job_status - Unified visibility into running and recent background work
 *
 * Real-time and historical view across the three job/worker registries on
 * a ServiceNow instance:
 *   - sys_trigger          — scheduled job triggers (next_action, last_run, state)
 *   - sys_progress_worker  — background workers (transforms, large operations)
 *   - sys_execution_tracker — execution trackers (fix scripts, imports, async ops)
 *
 * Companion to snow_trigger_scheduled_job (which starts jobs) and
 * snow_scheduled_job_manage (which defines them). This tool is read-only.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

type SourceKey = "trigger" | "worker" | "tracker"

const SOURCE_TABLES: Record<SourceKey, string> = {
  trigger: "sys_trigger",
  worker: "sys_progress_worker",
  tracker: "sys_execution_tracker",
}

export const toolDefinition: MCPToolDefinition = {
  name: "snow_job_status",
  description: `Unified read-only visibility into ServiceNow background work. Spans sys_trigger (scheduled-job triggers), sys_progress_worker (background workers for transforms, imports, large operations), and sys_execution_tracker (fix-script and async-operation trackers).

Actions:
- list_active — list currently running/queued work across triggers, workers, and trackers
- get_status — fetch the full record for a single job/worker/tracker by sys_id
- get_history — historical runs for a specific scheduled job (sys_trigger), bounded by limit and time window
- get_errors — surface recent failed/errored runs across the three sources

Use when: the agent needs real-time situational awareness of what is running on the instance, debugging a slow transform, or auditing why a scheduled job did not fire. Companion to snow_trigger_scheduled_job for starting jobs and snow_scheduled_job_manage for defining them.

Returns: per-source arrays of normalized records with sys_id, name, state, progress, started_at, completed_at, and source-specific fields. All operations are read-only Table API queries.`,
  category: "automation",
  subcategory: "scheduled-jobs",
  use_cases: ["monitoring", "scheduled-jobs", "background-jobs", "debugging", "observability"],
  complexity: "intermediate",
  frequency: "high",
  permission: "read",
  allowedRoles: ["developer", "admin", "stakeholder"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Status-query action to perform",
        enum: ["list_active", "get_status", "get_history", "get_errors"],
      },
      source: {
        type: "string",
        description:
          "[list_active/get_status/get_errors] Which source to query. Defaults to 'all' which queries trigger, worker, and tracker in parallel.",
        enum: ["all", "trigger", "worker", "tracker"],
        default: "all",
      },
      sys_id: {
        type: "string",
        description: "[get_status/get_history] Record sys_id to inspect",
      },
      job_name: {
        type: "string",
        description: "[get_history] Scheduled job name (alternative to sys_id, queries sys_trigger by name)",
      },
      limit: {
        type: "number",
        description: "[list_active/get_history/get_errors] Maximum records to return per source",
        default: 50,
      },
      since_hours: {
        type: "number",
        description: "[list_active/get_history/get_errors] Only include records updated within the last N hours",
        default: 24,
      },
      fields: {
        type: "string",
        description: "[get_status] Comma-separated list of fields to return for the specific record",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list_active":
        return await executeListActive(args, context)
      case "get_status":
        return await executeGetStatus(args, context)
      case "get_history":
        return await executeGetHistory(args, context)
      case "get_errors":
        return await executeGetErrors(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list_active, get_status, get_history, get_errors`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Job status ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

function buildSourceList(source: string | undefined): SourceKey[] {
  if (!source || source === "all") return ["trigger", "worker", "tracker"]
  return [source as SourceKey]
}

function activeQueryFor(source: SourceKey, sinceHours: number): string {
  const sinceClause = `sys_updated_on>=javascript:gs.beginningOfLastXHours(${sinceHours})`
  switch (source) {
    case "trigger":
      // sys_trigger has a 'state' field — running triggers are state=1 (ready) or state=2 (running)
      // TODO: verify state codes against a live instance
      return `state!=0^${sinceClause}`
    case "worker":
      // sys_progress_worker state: running/pending/queued
      return `stateIN0,1,2^${sinceClause}`
    case "tracker":
      // sys_execution_tracker.state: running/pending — completion is usually >= 4
      return `stateIN0,1,2^${sinceClause}`
  }
}

function normalizeRecord(source: SourceKey, raw: Record<string, unknown>): Record<string, unknown> {
  const common = {
    source,
    sys_id: raw.sys_id,
    name: raw.name,
    state: raw.state,
    updated_at: raw.sys_updated_on,
  }

  switch (source) {
    case "trigger":
      return {
        ...common,
        next_action: raw.next_action,
        trigger_type: raw.trigger_type,
        document_key: raw.document_key,
        document: raw.document,
      }
    case "worker":
      // sys_progress_worker exposes message, error_message, output_summary, state_code,
      // total_execute_time, total_run_time, queued_time. It has no start_time/end_time/progress_percent.
      return {
        ...common,
        state_code: raw.state_code,
        queued_time: raw.queued_time,
        total_run_time: raw.total_run_time,
        total_execute_time: raw.total_execute_time,
        message: raw.message,
        error_message: raw.error_message,
        output_summary: raw.output_summary,
      }
    case "tracker":
      // sys_execution_tracker uses start_time, completion_time, percent_complete (not end_time/progress).
      return {
        ...common,
        percent_complete: raw.percent_complete,
        started_at: raw.start_time,
        completed_at: raw.completion_time,
        result: raw.result,
        message: raw.message,
        detail_message: raw.detail_message,
      }
  }
}

// ==================== LIST_ACTIVE ====================

async function executeListActive(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const source = args.source as string | undefined
  const limit = (args.limit as number) || 50
  const since_hours = (args.since_hours as number) || 24

  const client = await getAuthenticatedClient(context)
  const sources = buildSourceList(source)

  const results: Record<string, Array<Record<string, unknown>>> = {}

  await Promise.all(
    sources.map(async (s) => {
      const table = SOURCE_TABLES[s]
      const response = await client.get(`/api/now/table/${table}`, {
        params: {
          sysparm_query: activeQueryFor(s, since_hours),
          sysparm_limit: limit,
          sysparm_orderby: "sys_updated_on",
          sysparm_order: "desc",
        },
      })
      const rows = (response.data.result || []) as Array<Record<string, unknown>>
      results[s] = rows.map((r) => normalizeRecord(s, r))
    }),
  )

  const totalActive = Object.values(results).reduce((sum, arr) => sum + arr.length, 0)

  return createSuccessResult({
    action: "list_active",
    since_hours,
    total_active: totalActive,
    sources: results,
  })
}

// ==================== GET_STATUS ====================

async function executeGetStatus(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const source = (args.source as string | undefined) || "all"
  const fields = args.fields as string | undefined

  if (!sys_id) {
    return createErrorResult("sys_id is required for get_status action")
  }

  const client = await getAuthenticatedClient(context)
  const sources = buildSourceList(source)

  for (const s of sources) {
    const table = SOURCE_TABLES[s]
    try {
      const response = await client.get(`/api/now/table/${table}/${sys_id}`, {
        params: fields ? { sysparm_fields: fields } : {},
      })
      const record = response.data.result as Record<string, unknown> | undefined
      if (record && record.sys_id) {
        return createSuccessResult({
          action: "get_status",
          source: s,
          sys_id: record.sys_id,
          record: normalizeRecord(s, record),
          raw: record,
          url: `${context.instanceUrl}/nav_to.do?uri=${table}.do?sys_id=${sys_id}`,
        })
      }
    } catch {
      // Not in this source, try the next one
    }
  }

  return createErrorResult(`Record ${sys_id} not found in any of: ${sources.join(", ")}`)
}

// ==================== GET_HISTORY ====================

async function executeGetHistory(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const job_name = args.job_name as string | undefined
  const limit = (args.limit as number) || 50
  const since_hours = (args.since_hours as number) || 168 // default 7 days for history

  if (!sys_id && !job_name) {
    return createErrorResult("sys_id or job_name is required for get_history action")
  }

  const client = await getAuthenticatedClient(context)

  // Resolve the scheduled job (sysauto_script) the trigger refers to.
  // sys_trigger.document_key is the sys_id of the referenced sysauto/sysauto_script record.
  let triggerQuery = ""
  if (sys_id) {
    triggerQuery = `document_key=${sys_id}^ORsys_id=${sys_id}`
  } else if (job_name) {
    triggerQuery = `nameLIKE${job_name}`
  }

  // sys_trigger doesn't carry rich per-run history on every release; the
  // execution_tracker and progress_worker tables typically do.
  // TODO: verify mapping between sys_trigger and execution_tracker on a live instance.
  const triggerResponse = await client.get("/api/now/table/sys_trigger", {
    params: {
      sysparm_query: `${triggerQuery}^sys_updated_on>=javascript:gs.beginningOfLastXHours(${since_hours})`,
      sysparm_limit: limit,
      sysparm_orderby: "sys_updated_on",
      sysparm_order: "desc",
    },
  })

  const trackerResponse = await client.get("/api/now/table/sys_execution_tracker", {
    params: {
      sysparm_query: `nameLIKE${job_name || ""}^sys_updated_on>=javascript:gs.beginningOfLastXHours(${since_hours})`,
      sysparm_limit: limit,
      sysparm_orderby: "sys_created_on",
      sysparm_order: "desc",
    },
  })

  const triggers = ((triggerResponse.data.result || []) as Array<Record<string, unknown>>).map((r) =>
    normalizeRecord("trigger", r),
  )
  const trackers = ((trackerResponse.data.result || []) as Array<Record<string, unknown>>).map((r) =>
    normalizeRecord("tracker", r),
  )

  return createSuccessResult({
    action: "get_history",
    since_hours,
    job_identifier: sys_id || job_name,
    trigger_runs: triggers,
    execution_trackers: trackers,
  })
}

// ==================== GET_ERRORS ====================

async function executeGetErrors(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const source = args.source as string | undefined
  const limit = (args.limit as number) || 50
  const since_hours = (args.since_hours as number) || 24

  const client = await getAuthenticatedClient(context)
  const sources = buildSourceList(source)

  const results: Record<string, Array<Record<string, unknown>>> = {}

  await Promise.all(
    sources.map(async (s) => {
      const table = SOURCE_TABLES[s]
      // Error state codes vary per table. The common pattern across ServiceNow:
      //   sys_progress_worker.state = 4 (cancelled), 5 (error)
      //   sys_execution_tracker.state = 5 (error), 6 (cancelled)
      //   sys_trigger has no canonical error state — surface those whose last_action recorded a failure.
      // TODO: verify state codes against a live instance.
      let query: string
      const sinceClause = `sys_updated_on>=javascript:gs.beginningOfLastXHours(${since_hours})`
      if (s === "worker") {
        query = `stateIN4,5^${sinceClause}`
      } else if (s === "tracker") {
        query = `stateIN5,6^${sinceClause}`
      } else {
        // trigger: sys_trigger has `last_error` (text) and `error_count` (int) — surface rows
        // whose error_count is non-zero or whose last_error is set.
        query = `error_count>0^ORlast_errorISNOTEMPTY^${sinceClause}`
      }

      const response = await client.get(`/api/now/table/${table}`, {
        params: {
          sysparm_query: query,
          sysparm_limit: limit,
          sysparm_orderby: "sys_updated_on",
          sysparm_order: "desc",
        },
      })

      const rows = (response.data.result || []) as Array<Record<string, unknown>>
      results[s] = rows.map((r) => normalizeRecord(s, r))
    }),
  )

  const totalErrors = Object.values(results).reduce((sum, arr) => sum + arr.length, 0)

  return createSuccessResult({
    action: "get_errors",
    since_hours,
    total_errors: totalErrors,
    sources: results,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
