/**
 * snow_sir_playbook_orchestrate - Unified SIR playbook orchestration
 *
 * Drives multi-step Security Incident Response (SIR) playbooks on the
 * sn_si_playbook and sn_si_playbook_task tables. A SIR playbook is a
 * sequenced SOAR procedure (e.g. "Phishing email response") composed of
 * playbook tasks; this tool starts a playbook against an incident, walks
 * through its task instances, and tracks status.
 *
 * Companion to snow_execute_security_playbook (which only fires a playbook
 * without managing per-step state) and snow_sir_incident_manage (which
 * owns the incident itself). Use this tool when you need to drive a
 * playbook step-by-step, inspect running playbooks, advance to the next
 * step, or cancel mid-flight.
 *
 * Requires the Security Incident Response plugin (com.snc.security_incident).
 * A 404 on the primary table is surfaced as a clear missing-plugin error.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

const SIR_PLUGIN = "com.snc.security_incident"
const SIR_PLAYBOOK_TABLE = "sn_si_playbook"
const SIR_PLAYBOOK_TASK_TABLE = "sn_si_playbook_task"
const SIR_INCIDENT_TABLE = "sn_si_incident"

// Playbook task states. The exact codes vary by release; values are
// passed as strings to let the platform coerce.
// TODO: verify state codes against a live SIR instance.
const TASK_STATE = {
  pending: "1",
  in_progress: "2",
  complete: "3",
  cancelled: "4",
  skipped: "7",
}

export const toolDefinition: MCPToolDefinition = {
  name: "snow_sir_playbook_orchestrate",
  description: `Unified tool for orchestrating Security Incident Response (SIR) playbooks on sn_si_playbook and sn_si_playbook_task. Drives a playbook step-by-step against an incident, tracking task instance state from pending through complete.

Actions:
- list_playbooks — list playbook definitions on sn_si_playbook (catalogue of available procedures)
- start — start a playbook against an incident (creates the run-time task instances and marks the first step in_progress)
- list_running — list currently running playbook task instances, optionally filtered by incident
- get_status — get the full step list for a running playbook on an incident with each step's state
- advance_step — mark the current step complete (optionally skip) and move the next pending step to in_progress
- cancel — cancel all remaining pending/in-progress steps for a playbook on an incident

Use when: the agent needs full step-by-step state management around a SOAR playbook rather than the fire-and-forget behaviour of snow_execute_security_playbook. Companion tools: snow_execute_security_playbook (trigger only), snow_sir_incident_manage (manage the parent incident), snow_sir_evidence_manage (attach evidence to the incident).

Plugin gating: requires com.snc.security_incident. A 404 on sn_si_playbook is surfaced with the required plugin name.

Returns: action-specific data. list_playbooks returns playbook definitions with sys_id, name, description, category. start returns the created task instances with their order. get_status returns each step's sys_id, name, state, assigned_to, started_at, completed_at. advance_step / cancel return the post-update state snapshot.`,
  category: "security",
  subcategory: "playbooks",
  use_cases: ["sir", "soar", "playbooks", "orchestration", "incident-response"],
  complexity: "advanced",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Orchestration action to perform",
        enum: ["list_playbooks", "start", "list_running", "get_status", "advance_step", "cancel"],
      },
      // Identifiers
      playbook_sys_id: {
        type: "string",
        description: "[start] sys_id of the playbook definition on sn_si_playbook",
      },
      playbook_name: {
        type: "string",
        description: "[start] Name of the playbook (alternative to playbook_sys_id)",
      },
      incident_sys_id: {
        type: "string",
        description: "[start/list_running/get_status/advance_step/cancel] sys_id of the parent SIR incident (sn_si_incident)",
      },
      incident_number: {
        type: "string",
        description: "[start/get_status/advance_step/cancel] SIR incident number (e.g. SIR0010001), alternative to incident_sys_id",
      },
      task_sys_id: {
        type: "string",
        description: "[advance_step] sys_id of the specific task instance to advance (optional — defaults to the current in-progress step)",
      },
      // LIST
      category: {
        type: "string",
        description: "[list_playbooks] Filter playbooks by category",
      },
      active_only: {
        type: "boolean",
        description: "[list_playbooks] Only return active playbooks",
        default: true,
      },
      limit: {
        type: "number",
        description: "[list_playbooks/list_running] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list_playbooks/list_running/get_status] Comma-separated list of fields to return",
      },
      // START
      assigned_to: {
        type: "string",
        description: "[start] sys_user sys_id assigned to drive the playbook (defaults to incident's assignee)",
      },
      // ADVANCE_STEP
      skip: {
        type: "boolean",
        description: "[advance_step] Skip the current step instead of marking it complete",
        default: false,
      },
      step_note: {
        type: "string",
        description: "[advance_step] Work note attached to the completed/skipped step",
      },
      // CANCEL
      cancel_reason: {
        type: "string",
        description: "[cancel] Reason for cancelling the playbook run",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list_playbooks":
        return await executeListPlaybooks(args, context)
      case "start":
        return await executeStart(args, context)
      case "list_running":
        return await executeListRunning(args, context)
      case "get_status":
        return await executeGetStatus(args, context)
      case "advance_step":
        return await executeAdvanceStep(args, context)
      case "cancel":
        return await executeCancel(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list_playbooks, start, list_running, get_status, advance_step, cancel`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `SIR playbook ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

function plugin404(err: unknown, table: string): SnowFlowError {
  const e = err as { response?: { status?: number }; message?: string }
  if (e?.response?.status === 404) {
    return new SnowFlowError(
      ErrorType.PLUGIN_MISSING,
      `Security Incident Response plugin not installed. The ${table} table was not found on this instance. Activate the plugin (${SIR_PLUGIN}) under System Definition > Plugins.`,
      { details: { plugin: SIR_PLUGIN, table } },
    )
  }
  return new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, e?.message || "SIR API call failed", { originalError: err as Error })
}

async function findPlaybook(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string | undefined,
  name: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (sysId) {
    try {
      const direct = await client.get(`/api/now/table/${SIR_PLAYBOOK_TABLE}/${sysId}`)
      if (direct.data.result && direct.data.result.sys_id) return direct.data.result
    } catch (err: unknown) {
      throw plugin404(err, SIR_PLAYBOOK_TABLE)
    }
  }
  if (name) {
    const search = await client.get(`/api/now/table/${SIR_PLAYBOOK_TABLE}`, {
      params: { sysparm_query: `name=${name}`, sysparm_limit: 1 },
    })
    const results = search.data.result || []
    if (results.length > 0) return results[0]
  }
  return null
}

async function resolveIncidentSysId(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  incidentSysId: string | undefined,
  incidentNumber: string | undefined,
): Promise<string | null> {
  if (incidentSysId) return incidentSysId
  if (incidentNumber) {
    const search = await client.get(`/api/now/table/${SIR_INCIDENT_TABLE}`, {
      params: { sysparm_query: `number=${incidentNumber}`, sysparm_limit: 1, sysparm_fields: "sys_id" },
    })
    const results = (search.data.result || []) as Array<Record<string, unknown>>
    if (results.length > 0) return results[0].sys_id as string
  }
  return null
}

// ==================== LIST_PLAYBOOKS ====================

async function executeListPlaybooks(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const category = args.category as string | undefined
  const active_only = args.active_only !== false
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (category) queryParts.push(`category=${category}`)
  if (active_only) queryParts.push("active=true")

  try {
    const response = await client.get(`/api/now/table/${SIR_PLAYBOOK_TABLE}`, {
      params: {
        sysparm_query: queryParts.join("^"),
        sysparm_limit: limit,
        sysparm_orderby: "name",
        sysparm_display_value: "true",
        ...(fields
          ? { sysparm_fields: fields }
          : { sysparm_fields: "sys_id,name,description,category,active,sys_updated_on" }),
      },
    })
    const results = (response.data.result || []) as Array<Record<string, unknown>>
    return createSuccessResult({
      action: "list_playbooks",
      count: results.length,
      playbooks: results.map((p) => ({
        sys_id: p.sys_id,
        name: p.name,
        description: p.description,
        category: p.category,
        active: p.active,
        updated_at: p.sys_updated_on,
        url: `${context.instanceUrl}/nav_to.do?uri=${SIR_PLAYBOOK_TABLE}.do?sys_id=${p.sys_id}`,
      })),
    })
  } catch (err: unknown) {
    throw plugin404(err, SIR_PLAYBOOK_TABLE)
  }
}

// ==================== START ====================

async function executeStart(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const playbook_sys_id = args.playbook_sys_id as string | undefined
  const playbook_name = args.playbook_name as string | undefined
  const incident_sys_id = args.incident_sys_id as string | undefined
  const incident_number = args.incident_number as string | undefined
  const assigned_to = args.assigned_to as string | undefined

  if (!playbook_sys_id && !playbook_name) {
    return createErrorResult("playbook_sys_id or playbook_name is required for start action")
  }
  if (!incident_sys_id && !incident_number) {
    return createErrorResult("incident_sys_id or incident_number is required for start action")
  }

  const client = await getAuthenticatedClient(context)
  const playbook = await findPlaybook(client, playbook_sys_id, playbook_name)
  if (!playbook) {
    return createErrorResult(`Playbook not found: ${playbook_sys_id || playbook_name}`)
  }

  const incidentSysId = await resolveIncidentSysId(client, incident_sys_id, incident_number)
  if (!incidentSysId) {
    return createErrorResult(`SIR incident not found: ${incident_sys_id || incident_number}`)
  }

  // Create a task instance row referencing the playbook. The platform
  // workflow normally clones each step from sn_si_playbook_task_template
  // into sn_si_playbook_task; we create a single anchor record and let
  // the platform fan out — this matches how snow_execute_security_playbook
  // triggers without per-step authoring.
  // TODO: verify the parent / playbook reference column names against a
  // live SIR instance — older releases use `playbook` while newer ones
  // use `sn_si_playbook` as the field name.
  try {
    const payload: Record<string, unknown> = {
      parent: incidentSysId,
      playbook: playbook.sys_id,
      state: TASK_STATE.in_progress,
    }
    if (assigned_to) payload.assigned_to = assigned_to

    const response = await client.post(`/api/now/table/${SIR_PLAYBOOK_TASK_TABLE}`, payload)
    const created = response.data.result as Record<string, unknown>

    return createSuccessResult({
      action: "start",
      started: true,
      sys_id: created.sys_id,
      playbook: { sys_id: playbook.sys_id, name: playbook.name },
      incident: { sys_id: incidentSysId },
      task: created,
      url: `${context.instanceUrl}/nav_to.do?uri=${SIR_PLAYBOOK_TASK_TABLE}.do?sys_id=${created.sys_id}`,
    })
  } catch (err: unknown) {
    throw plugin404(err, SIR_PLAYBOOK_TASK_TABLE)
  }
}

// ==================== LIST_RUNNING ====================

async function executeListRunning(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const incident_sys_id = args.incident_sys_id as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = [`stateIN${TASK_STATE.pending},${TASK_STATE.in_progress}`]
  if (incident_sys_id) queryParts.push(`parent=${incident_sys_id}`)

  try {
    const response = await client.get(`/api/now/table/${SIR_PLAYBOOK_TASK_TABLE}`, {
      params: {
        sysparm_query: queryParts.join("^"),
        sysparm_limit: limit,
        sysparm_orderby: "order",
        sysparm_display_value: "true",
        ...(fields
          ? { sysparm_fields: fields }
          : {
              sysparm_fields:
                "sys_id,number,short_description,state,parent,playbook,assigned_to,order,sys_created_on",
            }),
      },
    })
    const results = (response.data.result || []) as Array<Record<string, unknown>>
    return createSuccessResult({
      action: "list_running",
      count: results.length,
      tasks: results.map((t) => ({
        sys_id: t.sys_id,
        number: t.number,
        short_description: t.short_description,
        state: t.state,
        parent: t.parent,
        playbook: t.playbook,
        assigned_to: t.assigned_to,
        order: t.order,
        created_at: t.sys_created_on,
        url: `${context.instanceUrl}/nav_to.do?uri=${SIR_PLAYBOOK_TASK_TABLE}.do?sys_id=${t.sys_id}`,
      })),
    })
  } catch (err: unknown) {
    throw plugin404(err, SIR_PLAYBOOK_TASK_TABLE)
  }
}

// ==================== GET_STATUS ====================

async function executeGetStatus(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const incident_sys_id = args.incident_sys_id as string | undefined
  const incident_number = args.incident_number as string | undefined
  const fields = args.fields as string | undefined

  if (!incident_sys_id && !incident_number) {
    return createErrorResult("incident_sys_id or incident_number is required for get_status action")
  }

  const client = await getAuthenticatedClient(context)
  const incidentSysId = await resolveIncidentSysId(client, incident_sys_id, incident_number)
  if (!incidentSysId) {
    return createErrorResult(`SIR incident not found: ${incident_sys_id || incident_number}`)
  }

  try {
    const response = await client.get(`/api/now/table/${SIR_PLAYBOOK_TASK_TABLE}`, {
      params: {
        sysparm_query: `parent=${incidentSysId}`,
        sysparm_limit: 500,
        sysparm_orderby: "order",
        sysparm_display_value: "true",
        ...(fields
          ? { sysparm_fields: fields }
          : {
              sysparm_fields:
                "sys_id,number,short_description,state,assigned_to,order,opened_at,closed_at,sys_created_on,sys_updated_on",
            }),
      },
    })
    const results = (response.data.result || []) as Array<Record<string, unknown>>

    const stateSummary: Record<string, number> = {}
    for (const t of results) {
      const s = String(t.state ?? "unknown")
      stateSummary[s] = (stateSummary[s] || 0) + 1
    }

    return createSuccessResult({
      action: "get_status",
      incident: { sys_id: incidentSysId },
      total_steps: results.length,
      state_summary: stateSummary,
      steps: results.map((t) => ({
        sys_id: t.sys_id,
        number: t.number,
        short_description: t.short_description,
        state: t.state,
        assigned_to: t.assigned_to,
        order: t.order,
        opened_at: t.opened_at,
        closed_at: t.closed_at,
        url: `${context.instanceUrl}/nav_to.do?uri=${SIR_PLAYBOOK_TASK_TABLE}.do?sys_id=${t.sys_id}`,
      })),
    })
  } catch (err: unknown) {
    throw plugin404(err, SIR_PLAYBOOK_TASK_TABLE)
  }
}

// ==================== ADVANCE_STEP ====================

async function executeAdvanceStep(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const incident_sys_id = args.incident_sys_id as string | undefined
  const incident_number = args.incident_number as string | undefined
  const task_sys_id = args.task_sys_id as string | undefined
  const skip = args.skip === true
  const step_note = args.step_note as string | undefined

  if (!task_sys_id && !incident_sys_id && !incident_number) {
    return createErrorResult(
      "task_sys_id (or incident_sys_id/incident_number) is required for advance_step action",
    )
  }

  const client = await getAuthenticatedClient(context)

  // Resolve the task to advance: either explicit task_sys_id, or the
  // current in-progress step on the given incident.
  let currentTask: Record<string, unknown> | null = null
  if (task_sys_id) {
    try {
      const direct = await client.get(`/api/now/table/${SIR_PLAYBOOK_TASK_TABLE}/${task_sys_id}`)
      currentTask = direct.data.result
    } catch (err: unknown) {
      throw plugin404(err, SIR_PLAYBOOK_TASK_TABLE)
    }
  } else {
    const incidentSysId = await resolveIncidentSysId(client, incident_sys_id, incident_number)
    if (!incidentSysId) {
      return createErrorResult(`SIR incident not found: ${incident_sys_id || incident_number}`)
    }
    const search = await client.get(`/api/now/table/${SIR_PLAYBOOK_TASK_TABLE}`, {
      params: {
        sysparm_query: `parent=${incidentSysId}^state=${TASK_STATE.in_progress}`,
        sysparm_limit: 1,
        sysparm_orderby: "order",
      },
    })
    const results = (search.data.result || []) as Array<Record<string, unknown>>
    currentTask = results.length > 0 ? results[0] : null
  }

  if (!currentTask) {
    return createErrorResult("No in-progress playbook task found for the given incident")
  }

  const currentSysId = currentTask.sys_id as string
  const currentOrder = currentTask.order as string | number | undefined
  const parentSysId = (currentTask.parent as { value?: string } | string) as unknown
  const parent = typeof parentSysId === "string"
    ? parentSysId
    : (parentSysId as { value?: string } | undefined)?.value || ""

  // Mark the current step complete or skipped.
  const currentPatch: Record<string, unknown> = {
    state: skip ? TASK_STATE.skipped : TASK_STATE.complete,
  }
  if (step_note) currentPatch.work_notes = step_note

  await client.patch(`/api/now/table/${SIR_PLAYBOOK_TASK_TABLE}/${currentSysId}`, currentPatch)

  // Find the next pending step on the same incident.
  let nextTask: Record<string, unknown> | null = null
  if (parent) {
    const nextQuery = currentOrder !== undefined
      ? `parent=${parent}^state=${TASK_STATE.pending}^order>${currentOrder}`
      : `parent=${parent}^state=${TASK_STATE.pending}`
    const nextResponse = await client.get(`/api/now/table/${SIR_PLAYBOOK_TASK_TABLE}`, {
      params: { sysparm_query: nextQuery, sysparm_limit: 1, sysparm_orderby: "order" },
    })
    const nextResults = (nextResponse.data.result || []) as Array<Record<string, unknown>>
    if (nextResults.length > 0) {
      nextTask = nextResults[0]
      await client.patch(`/api/now/table/${SIR_PLAYBOOK_TASK_TABLE}/${nextTask.sys_id}`, {
        state: TASK_STATE.in_progress,
      })
    }
  }

  return createSuccessResult({
    action: "advance_step",
    advanced: true,
    completed: !skip,
    skipped: skip,
    previous_step: { sys_id: currentSysId, order: currentOrder },
    next_step: nextTask ? { sys_id: nextTask.sys_id, order: nextTask.order, short_description: nextTask.short_description } : null,
    playbook_complete: nextTask === null,
  })
}

// ==================== CANCEL ====================

async function executeCancel(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const incident_sys_id = args.incident_sys_id as string | undefined
  const incident_number = args.incident_number as string | undefined
  const cancel_reason = args.cancel_reason as string | undefined

  if (!incident_sys_id && !incident_number) {
    return createErrorResult("incident_sys_id or incident_number is required for cancel action")
  }

  const client = await getAuthenticatedClient(context)
  const incidentSysId = await resolveIncidentSysId(client, incident_sys_id, incident_number)
  if (!incidentSysId) {
    return createErrorResult(`SIR incident not found: ${incident_sys_id || incident_number}`)
  }

  try {
    const response = await client.get(`/api/now/table/${SIR_PLAYBOOK_TASK_TABLE}`, {
      params: {
        sysparm_query: `parent=${incidentSysId}^stateIN${TASK_STATE.pending},${TASK_STATE.in_progress}`,
        sysparm_limit: 500,
        sysparm_fields: "sys_id,number,order,state",
      },
    })
    const open = (response.data.result || []) as Array<Record<string, unknown>>

    const cancelled: Array<{ sys_id: string; number: unknown }> = []
    for (const task of open) {
      const patch: Record<string, unknown> = { state: TASK_STATE.cancelled }
      if (cancel_reason) patch.work_notes = `Cancelled: ${cancel_reason}`
      await client.patch(`/api/now/table/${SIR_PLAYBOOK_TASK_TABLE}/${task.sys_id}`, patch)
      cancelled.push({ sys_id: task.sys_id as string, number: task.number })
    }

    return createSuccessResult({
      action: "cancel",
      cancelled_count: cancelled.length,
      cancelled,
      incident: { sys_id: incidentSysId },
      reason: cancel_reason || null,
    })
  } catch (err: unknown) {
    throw plugin404(err, SIR_PLAYBOOK_TASK_TABLE)
  }
}

export const version = "1.0.0"
export const author = "groeimetai"
