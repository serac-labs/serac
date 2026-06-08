/**
 * snow_sir_incident_manage - Unified Security Incident Response (SIR) incident lifecycle
 *
 * Manages the lifecycle of Security Incident Response incidents on the
 * sn_si_incident table and their associated tasks on sn_si_task. SIR
 * incidents are a distinct artifact from the standard `incident` table —
 * they ship with the Security Incident Response application and follow
 * the NIST IR phases (triage, contain, eradicate, recover, close).
 *
 * Companion to snow_create_security_incident (which only creates an initial
 * record) and snow_automate_threat_response (which fires automated response
 * actions). This tool extends those by managing the full phase progression
 * and exposing the per-incident task queue.
 *
 * Requires the Security Incident Response plugin (com.snc.security_incident)
 * on the target instance. A 404 on the primary table is surfaced as a
 * clear missing-plugin error.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

const SIR_PLUGIN = "com.snc.security_incident"
const SIR_INCIDENT_TABLE = "sn_si_incident"
const SIR_TASK_TABLE = "sn_si_task"

// SIR phase / state map. ServiceNow ships SIR with a numeric state field
// on sn_si_incident; the exact codes can vary by release, so values are
// written as strings the platform will coerce.
// TODO: verify state code values against a live SIR-enabled instance.
const SIR_PHASE_STATE: Record<string, string> = {
  triage: "16", // Analysis / triage
  contain: "18", // Contain
  eradicate: "19", // Eradicate
  recover: "20", // Recover
  close: "3", // Closed
}

export const toolDefinition: MCPToolDefinition = {
  name: "snow_sir_incident_manage",
  description: `Unified tool for ServiceNow Security Incident Response (SIR) incident lifecycle on sn_si_incident and sn_si_task. Walks an incident through the NIST IR phases: triage, contain, eradicate, recover, close.

Actions:
- list — list SIR incidents, optionally filtered by state, priority, or assignment_group
- get — retrieve a single SIR incident by sys_id or number, with its related task summary
- create — open a new SIR incident (short_description and category required)
- triage — move an incident into the triage phase, optionally assigning analyst
- contain — move an incident into the contain phase with a containment note
- eradicate — move an incident into the eradicate phase with an eradication note
- recover — move an incident into the recover phase with a recovery note
- close — close an incident with a close code and resolution notes
- list_tasks — list sn_si_task rows linked to the incident

Use when: the agent needs to drive a security incident through the SIR phase model rather than just record one. Companion tools: snow_create_security_incident (initial record only), snow_automate_threat_response (run automated actions), snow_sir_playbook_orchestrate (run a multi-step playbook), snow_sir_evidence_manage (attach forensic evidence).

Plugin gating: requires com.snc.security_incident. A 404 on sn_si_incident is surfaced with the required plugin name so the caller can install it.

Returns: SIR incident records with sys_id, number, state, phase, priority, category, assigned_to, and the configured workflow phase. Task listings include sys_id, number, short_description, state, and assigned_to.`,
  category: "security",
  subcategory: "incidents",
  use_cases: ["sir", "security", "incident-response", "soar", "nist-ir"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Management action to perform",
        enum: ["list", "get", "create", "triage", "contain", "eradicate", "recover", "close", "list_tasks"],
      },
      // Identifiers
      sys_id: {
        type: "string",
        description: "[get/triage/contain/eradicate/recover/close/list_tasks] SIR incident sys_id",
      },
      number: {
        type: "string",
        description: "[get/triage/contain/eradicate/recover/close/list_tasks] SIR incident number (e.g. SIR0010001), alternative to sys_id",
      },
      // LIST filters
      state: {
        type: "string",
        description: "[list] Filter by state code (numeric) or display value",
      },
      priority: {
        type: "string",
        description: "[list] Filter by priority (1-5)",
      },
      assignment_group: {
        type: "string",
        description: "[list] Filter by assignment_group sys_id",
      },
      limit: {
        type: "number",
        description: "[list/list_tasks] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list/get/list_tasks] Comma-separated list of fields to return",
      },
      // CREATE
      short_description: {
        type: "string",
        description: "[create] Short description of the incident",
      },
      description: {
        type: "string",
        description: "[create] Long description / initial observations",
      },
      category: {
        type: "string",
        description: "[create] SIR category (malware, phishing, unauthorized_access, etc.)",
      },
      subcategory: {
        type: "string",
        description: "[create] SIR subcategory",
      },
      priority_value: {
        type: "string",
        description: "[create] Priority (1=Critical, 2=High, 3=Moderate, 4=Low, 5=Planning)",
        enum: ["1", "2", "3", "4", "5"],
      },
      caller: {
        type: "string",
        description: "[create] sys_user sys_id of the caller / reporter",
      },
      assigned_to: {
        type: "string",
        description: "[create/triage] sys_user sys_id of the analyst the incident is assigned to",
      },
      assignment_group_sys_id: {
        type: "string",
        description: "[create/triage] assignment_group sys_id",
      },
      // PHASE notes
      triage_note: {
        type: "string",
        description: "[triage] Triage work note",
      },
      contain_note: {
        type: "string",
        description: "[contain] Containment work note describing isolation / blocking actions taken",
      },
      eradicate_note: {
        type: "string",
        description: "[eradicate] Eradication work note describing root-cause removal",
      },
      recover_note: {
        type: "string",
        description: "[recover] Recovery work note describing service restoration",
      },
      // CLOSE
      close_code: {
        type: "string",
        description: "[close] Close code",
        enum: ["resolved", "not_a_security_incident", "false_positive", "duplicate", "no_resolution"],
      },
      close_notes: {
        type: "string",
        description: "[close] Resolution notes",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list":
        return await executeList(args, context)
      case "get":
        return await executeGet(args, context)
      case "create":
        return await executeCreate(args, context)
      case "triage":
        return await executePhase(args, context, "triage")
      case "contain":
        return await executePhase(args, context, "contain")
      case "eradicate":
        return await executePhase(args, context, "eradicate")
      case "recover":
        return await executePhase(args, context, "recover")
      case "close":
        return await executeClose(args, context)
      case "list_tasks":
        return await executeListTasks(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list, get, create, triage, contain, eradicate, recover, close, list_tasks`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `SIR incident ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

function plugin404(err: unknown): SnowFlowError {
  const e = err as { response?: { status?: number }; message?: string }
  if (e?.response?.status === 404) {
    return new SnowFlowError(
      ErrorType.PLUGIN_MISSING,
      `Security Incident Response plugin not installed. The ${SIR_INCIDENT_TABLE} table was not found on this instance. Activate the plugin (${SIR_PLUGIN}) under System Definition > Plugins.`,
      { details: { plugin: SIR_PLUGIN, table: SIR_INCIDENT_TABLE } },
    )
  }
  return new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, e?.message || "SIR API call failed", { originalError: err as Error })
}

async function findIncident(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string | undefined,
  number: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (sysId) {
    try {
      const direct = await client.get(`/api/now/table/${SIR_INCIDENT_TABLE}/${sysId}`)
      if (direct.data.result && direct.data.result.sys_id) return direct.data.result
    } catch (err: unknown) {
      const e = err as { response?: { status?: number } }
      if (e?.response?.status === 404) {
        // Could mean: missing plugin OR missing record. Probe the table.
        const probe = await client.get(`/api/now/table/${SIR_INCIDENT_TABLE}`, { params: { sysparm_limit: 1 } })
        if (!probe.data.result) throw plugin404(err)
        return null
      }
      throw plugin404(err)
    }
  }
  if (number) {
    const search = await client.get(`/api/now/table/${SIR_INCIDENT_TABLE}`, {
      params: { sysparm_query: `number=${number}`, sysparm_limit: 1 },
    })
    const results = search.data.result || []
    if (results.length > 0) return results[0]
  }
  return null
}

// ==================== LIST ====================

async function executeList(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const state = args.state as string | undefined
  const priority = args.priority as string | undefined
  const assignment_group = args.assignment_group as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (state) queryParts.push(`state=${state}`)
  if (priority) queryParts.push(`priority=${priority}`)
  if (assignment_group) queryParts.push(`assignment_group=${assignment_group}`)

  try {
    const response = await client.get(`/api/now/table/${SIR_INCIDENT_TABLE}`, {
      params: {
        sysparm_query: queryParts.join("^"),
        sysparm_limit: limit,
        sysparm_orderby: "sys_created_on",
        sysparm_display_value: "true",
        ...(fields
          ? { sysparm_fields: fields }
          : {
              sysparm_fields:
                "sys_id,number,short_description,state,priority,category,assigned_to,assignment_group,sys_created_on,sys_updated_on",
            }),
      },
    })

    const results = (response.data.result || []) as Array<Record<string, unknown>>
    return createSuccessResult({
      action: "list",
      count: results.length,
      incidents: results.map((r) => ({
        sys_id: r.sys_id,
        number: r.number,
        short_description: r.short_description,
        state: r.state,
        priority: r.priority,
        category: r.category,
        assigned_to: r.assigned_to,
        assignment_group: r.assignment_group,
        created_at: r.sys_created_on,
        updated_at: r.sys_updated_on,
        url: `${context.instanceUrl}/nav_to.do?uri=${SIR_INCIDENT_TABLE}.do?sys_id=${r.sys_id}`,
      })),
    })
  } catch (err: unknown) {
    throw plugin404(err)
  }
}

// ==================== GET ====================

async function executeGet(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const number = args.number as string | undefined
  if (!sys_id && !number) {
    return createErrorResult("sys_id or number is required for get action")
  }

  const client = await getAuthenticatedClient(context)
  const incident = await findIncident(client, sys_id, number)
  if (!incident) {
    return createErrorResult(`SIR incident not found: ${sys_id || number}`)
  }

  const incidentSysId = incident.sys_id as string

  // Count related SIR tasks (best-effort)
  let taskCount = 0
  try {
    const tasks = await client.get(`/api/now/table/${SIR_TASK_TABLE}`, {
      params: { sysparm_query: `parent=${incidentSysId}`, sysparm_fields: "sys_id", sysparm_limit: 500 },
    })
    taskCount = (tasks.data.result || []).length
  } catch {
    // SIR task table may not be reachable on stripped-down instances
  }

  return createSuccessResult({
    action: "get",
    sys_id: incidentSysId,
    number: incident.number,
    incident,
    related: { task_count: taskCount },
    url: `${context.instanceUrl}/nav_to.do?uri=${SIR_INCIDENT_TABLE}.do?sys_id=${incidentSysId}`,
  })
}

// ==================== CREATE ====================

async function executeCreate(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const short_description = args.short_description as string | undefined
  const description = args.description as string | undefined
  const category = args.category as string | undefined
  const subcategory = args.subcategory as string | undefined
  const priority_value = args.priority_value as string | undefined
  const caller = args.caller as string | undefined
  const assigned_to = args.assigned_to as string | undefined
  const assignment_group_sys_id = args.assignment_group_sys_id as string | undefined

  if (!short_description) return createErrorResult("short_description is required for create action")
  if (!category) return createErrorResult("category is required for create action")

  const client = await getAuthenticatedClient(context)

  const payload: Record<string, unknown> = {
    short_description,
    category,
  }
  if (description) payload.description = description
  if (subcategory) payload.subcategory = subcategory
  if (priority_value) payload.priority = priority_value
  if (caller) payload.caller = caller
  if (assigned_to) payload.assigned_to = assigned_to
  if (assignment_group_sys_id) payload.assignment_group = assignment_group_sys_id

  try {
    const response = await client.post(`/api/now/table/${SIR_INCIDENT_TABLE}`, payload)
    const created = response.data.result as Record<string, unknown>
    return createSuccessResult({
      action: "create",
      created: true,
      sys_id: created.sys_id,
      number: created.number,
      incident: created,
      url: `${context.instanceUrl}/nav_to.do?uri=${SIR_INCIDENT_TABLE}.do?sys_id=${created.sys_id}`,
    })
  } catch (err: unknown) {
    throw plugin404(err)
  }
}

// ==================== PHASE TRANSITIONS ====================

async function executePhase(
  args: Record<string, unknown>,
  context: ServiceNowContext,
  phase: "triage" | "contain" | "eradicate" | "recover",
): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const number = args.number as string | undefined

  if (!sys_id && !number) {
    return createErrorResult(`sys_id or number is required for ${phase} action`)
  }

  const client = await getAuthenticatedClient(context)
  const incident = await findIncident(client, sys_id, number)
  if (!incident) {
    return createErrorResult(`SIR incident not found: ${sys_id || number}`)
  }

  const targetSysId = incident.sys_id as string
  const stateCode = SIR_PHASE_STATE[phase]

  const noteFieldByPhase: Record<string, string | undefined> = {
    triage: args.triage_note as string | undefined,
    contain: args.contain_note as string | undefined,
    eradicate: args.eradicate_note as string | undefined,
    recover: args.recover_note as string | undefined,
  }
  const work_notes = noteFieldByPhase[phase]

  const patch: Record<string, unknown> = { state: stateCode }
  if (work_notes) patch.work_notes = work_notes

  // Triage may also re-assign the incident.
  if (phase === "triage") {
    const assigned_to = args.assigned_to as string | undefined
    const assignment_group_sys_id = args.assignment_group_sys_id as string | undefined
    if (assigned_to) patch.assigned_to = assigned_to
    if (assignment_group_sys_id) patch.assignment_group = assignment_group_sys_id
  }

  const response = await client.patch(`/api/now/table/${SIR_INCIDENT_TABLE}/${targetSysId}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: phase,
    updated: true,
    phase,
    sys_id: targetSysId,
    number: updated.number,
    state: updated.state,
    incident: updated,
    url: `${context.instanceUrl}/nav_to.do?uri=${SIR_INCIDENT_TABLE}.do?sys_id=${targetSysId}`,
  })
}

// ==================== CLOSE ====================

async function executeClose(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const number = args.number as string | undefined
  const close_code = args.close_code as string | undefined
  const close_notes = args.close_notes as string | undefined

  if (!sys_id && !number) {
    return createErrorResult("sys_id or number is required for close action")
  }
  if (!close_notes) {
    return createErrorResult("close_notes is required for close action")
  }

  const client = await getAuthenticatedClient(context)
  const incident = await findIncident(client, sys_id, number)
  if (!incident) {
    return createErrorResult(`SIR incident not found: ${sys_id || number}`)
  }

  const targetSysId = incident.sys_id as string

  const patch: Record<string, unknown> = {
    state: SIR_PHASE_STATE.close,
    close_notes,
  }
  if (close_code) patch.close_code = close_code

  const response = await client.patch(`/api/now/table/${SIR_INCIDENT_TABLE}/${targetSysId}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "close",
    closed: true,
    sys_id: targetSysId,
    number: updated.number,
    state: updated.state,
    close_code: updated.close_code,
    incident: updated,
    url: `${context.instanceUrl}/nav_to.do?uri=${SIR_INCIDENT_TABLE}.do?sys_id=${targetSysId}`,
  })
}

// ==================== LIST_TASKS ====================

async function executeListTasks(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const number = args.number as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  if (!sys_id && !number) {
    return createErrorResult("sys_id or number is required for list_tasks action")
  }

  const client = await getAuthenticatedClient(context)
  const incident = await findIncident(client, sys_id, number)
  if (!incident) {
    return createErrorResult(`SIR incident not found: ${sys_id || number}`)
  }

  const incidentSysId = incident.sys_id as string

  // TODO: verify the parent linkage column on sn_si_task — the SIR plugin
  // has historically used `parent`, but some releases shipped a dedicated
  // `incident` reference column instead.
  try {
    const response = await client.get(`/api/now/table/${SIR_TASK_TABLE}`, {
      params: {
        sysparm_query: `parent=${incidentSysId}`,
        sysparm_limit: limit,
        sysparm_orderby: "sys_created_on",
        sysparm_display_value: "true",
        ...(fields
          ? { sysparm_fields: fields }
          : {
              sysparm_fields:
                "sys_id,number,short_description,state,assigned_to,assignment_group,sys_created_on",
            }),
      },
    })
    const results = (response.data.result || []) as Array<Record<string, unknown>>
    return createSuccessResult({
      action: "list_tasks",
      incident: { sys_id: incidentSysId, number: incident.number },
      count: results.length,
      tasks: results.map((t) => ({
        sys_id: t.sys_id,
        number: t.number,
        short_description: t.short_description,
        state: t.state,
        assigned_to: t.assigned_to,
        assignment_group: t.assignment_group,
        created_at: t.sys_created_on,
        url: `${context.instanceUrl}/nav_to.do?uri=${SIR_TASK_TABLE}.do?sys_id=${t.sys_id}`,
      })),
    })
  } catch (err: unknown) {
    throw plugin404(err)
  }
}

export const version = "1.0.0"
export const author = "groeimetai"
