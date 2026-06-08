/**
 * snow_sla_manage - Unified SLA / OLA lifecycle management
 *
 * Manages SLA and OLA records beyond the view-only snapshot returned by
 * snow_get_sla_status. Wraps contract_sla (the SLA definition table) and
 * task_sla (the runtime instance rows attached to individual records), with
 * support for OLAs which on most platforms share the contract_sla table
 * under a `type=OLA` discriminator.
 *
 * Companion to snow_create_sla (creates the contract_sla definition) and
 * snow_get_sla_status (read-only listing of task_sla rows on a task). This
 * tool covers the lifecycle in between — updating definitions, pausing or
 * resuming running task_sla rows, responding to breaches, and listing
 * breached SLAs across the platform.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_sla_manage",
  description: `Unified tool for ServiceNow SLA and OLA lifecycle beyond view-only status checks: list, update, breach_response, pause, resume, list_breaches. Wraps contract_sla (definitions, including OLAs) and task_sla (running instances).

Actions:
- list — list contract_sla definitions, optionally filtered by table or SLA type (SLA or OLA)
- update — patch contract_sla fields (duration, condition, schedule, active, retroactive flags)
- breach_response — append a work note and optional escalation to a task_sla row that has breached
- pause — pause a running task_sla row (sets stage to paused with a reason)
- resume — resume a paused task_sla row
- list_breaches — list task_sla rows where has_breached=true, optionally scoped to a table or assignment_group

Use when: the agent needs to maintain SLA definitions, react to breaches, or pause/resume in-flight SLAs on individual records. For creating a new contract_sla, use snow_create_sla; for a read-only status of one task's SLAs, use snow_get_sla_status.

Returns: contract_sla rows with sys_id, name, duration, collection, type; task_sla rows with stage, has_breached, business_percentage; breach lists scoped by table and group.`,
  category: "itsm",
  subcategory: "sla",
  use_cases: ["sla-management", "ola", "service-level", "breaches"],
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
        enum: ["list", "update", "breach_response", "pause", "resume", "list_breaches"],
      },
      // Identifiers (contract_sla)
      sys_id: {
        type: "string",
        description: "[update] contract_sla sys_id",
      },
      name: {
        type: "string",
        description: "[update] contract_sla name (used as identifier when sys_id is absent)",
      },
      // Identifier (task_sla)
      task_sla_sys_id: {
        type: "string",
        description: "[breach_response/pause/resume] task_sla sys_id",
      },
      // LIST filters
      table: {
        type: "string",
        description: "[list/list_breaches] Filter by table (e.g. incident, change_request)",
      },
      sla_type: {
        type: "string",
        description: "[list] Filter by SLA type",
        enum: ["SLA", "OLA"],
      },
      active_only: {
        type: "boolean",
        description: "[list] Only return active SLA definitions",
        default: false,
      },
      assignment_group: {
        type: "string",
        description: "[list_breaches] Filter by sys_user_group sys_id",
      },
      limit: {
        type: "number",
        description: "[list/list_breaches] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list/list_breaches] Comma-separated list of fields to return",
      },
      // UPDATE fields (contract_sla)
      duration: {
        type: "string",
        description: '[update] Duration in HH:MM:SS or human-readable form (e.g. "4 Hours")',
      },
      condition: {
        type: "string",
        description: "[update] Encoded query for when the SLA applies",
      },
      schedule: {
        type: "string",
        description: "[update] Schedule sys_id (cmn_schedule)",
      },
      pause_condition: {
        type: "string",
        description: "[update] Encoded query that pauses the SLA when true",
      },
      active: {
        type: "boolean",
        description: "[update] Whether the SLA definition is active",
      },
      retroactive: {
        type: "boolean",
        description: "[update] Whether the SLA is retroactive (apply to existing tasks)",
      },
      retroactive_pause: {
        type: "boolean",
        description: "[update] Whether retroactive pause is allowed",
      },
      // BREACH_RESPONSE / PAUSE / RESUME
      response_note: {
        type: "string",
        description: "[breach_response] Work note to append explaining the breach response",
      },
      escalate: {
        type: "boolean",
        description: "[breach_response] Also raise the parent task's escalation level by 1",
        default: false,
      },
      pause_reason: {
        type: "string",
        description: "[pause] Reason for the pause (stored in the work_notes journal on the task_sla)",
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
      case "update":
        return await executeUpdate(args, context)
      case "breach_response":
        return await executeBreachResponse(args, context)
      case "pause":
        return await executePause(args, context)
      case "resume":
        return await executeResume(args, context)
      case "list_breaches":
        return await executeListBreaches(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list, update, breach_response, pause, resume, list_breaches`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `SLA ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function findSlaDefinition(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string | undefined,
  name: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (sysId) {
    const direct = await client.get(`/api/now/table/contract_sla/${sysId}`)
    if (direct.data.result && direct.data.result.sys_id) {
      return direct.data.result
    }
  }
  if (name) {
    const search = await client.get("/api/now/table/contract_sla", {
      params: {
        sysparm_query: `name=${name}`,
        sysparm_limit: 1,
      },
    })
    const results = search.data.result || []
    if (results.length > 0) return results[0]
  }
  return null
}

async function findTaskSla(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string,
): Promise<Record<string, unknown> | null> {
  const direct = await client.get(`/api/now/table/task_sla/${sysId}`)
  if (direct.data.result && direct.data.result.sys_id) {
    return direct.data.result
  }
  return null
}

// ==================== LIST ====================

async function executeList(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const table = args.table as string | undefined
  const sla_type = args.sla_type as string | undefined
  const active_only = args.active_only === true
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (table) queryParts.push(`collection=${table}`)
  if (sla_type) queryParts.push(`type=${sla_type}`)
  if (active_only) queryParts.push("active=true")

  const response = await client.get("/api/now/table/contract_sla", {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "name",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,name,type,collection,duration,condition,schedule,active,sys_updated_on" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list",
    count: results.length,
    slas: results.map((r) => ({
      sys_id: r.sys_id,
      name: r.name,
      type: r.type,
      table: r.collection,
      duration: r.duration,
      condition: r.condition,
      schedule: r.schedule,
      active: r.active,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=contract_sla.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== UPDATE ====================

async function executeUpdate(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const name = args.name as string | undefined

  if (!sys_id && !name) {
    return createErrorResult("sys_id or name is required for update action")
  }

  const client = await getAuthenticatedClient(context)
  const sla = await findSlaDefinition(client, sys_id, name)
  if (!sla) {
    return createErrorResult(`SLA definition not found: ${sys_id || name}`)
  }

  const updatableFields = [
    "duration",
    "condition",
    "schedule",
    "pause_condition",
    "active",
    "retroactive",
    "retroactive_pause",
  ]
  const patch: Record<string, unknown> = {}
  for (const key of updatableFields) {
    if (args[key] !== undefined) patch[key] = args[key]
  }

  if (Object.keys(patch).length === 0) {
    return createErrorResult("No update fields provided")
  }

  const targetSysId = sla.sys_id as string
  const response = await client.patch(`/api/now/table/contract_sla/${targetSysId}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "update",
    updated: true,
    sys_id: targetSysId,
    name: updated.name,
    updated_fields: Object.keys(patch),
    sla: updated,
    url: `${context.instanceUrl}/nav_to.do?uri=contract_sla.do?sys_id=${targetSysId}`,
  })
}

// ==================== BREACH_RESPONSE ====================

async function executeBreachResponse(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const task_sla_sys_id = args.task_sla_sys_id as string | undefined
  const response_note = args.response_note as string | undefined
  const escalate = args.escalate === true

  if (!task_sla_sys_id) {
    return createErrorResult("task_sla_sys_id is required for breach_response action")
  }
  if (!response_note) {
    return createErrorResult("response_note is required for breach_response action")
  }

  const client = await getAuthenticatedClient(context)
  const taskSla = await findTaskSla(client, task_sla_sys_id)
  if (!taskSla) {
    return createErrorResult(`task_sla not found: ${task_sla_sys_id}`)
  }

  // Append work note to the task_sla
  await client.patch(`/api/now/table/task_sla/${task_sla_sys_id}`, {
    work_notes: response_note,
  })

  // Optionally bump the parent task's escalation
  let escalation: Record<string, unknown> | null = null
  if (escalate) {
    const taskRef = taskSla.task
    const taskSysId =
      typeof taskRef === "string"
        ? taskRef
        : taskRef && typeof taskRef === "object" && "value" in (taskRef as Record<string, unknown>)
          ? ((taskRef as Record<string, unknown>).value as string)
          : null
    if (taskSysId) {
      try {
        // task lives on a derived table; the generic task table accepts updates by sys_id
        const escResponse = await client.patch(`/api/now/table/task/${taskSysId}`, {
          escalation: "2",
        })
        escalation = escResponse.data.result as Record<string, unknown>
      } catch (e: unknown) {
        // Some tables guard against direct escalation writes; surface a warning rather than fail
        escalation = { warning: `Could not raise escalation on task ${taskSysId}: ${(e as Error).message}` }
      }
    }
  }

  return createSuccessResult({
    action: "breach_response",
    task_sla_sys_id,
    note_appended: true,
    escalation,
  })
}

// ==================== PAUSE ====================

async function executePause(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const task_sla_sys_id = args.task_sla_sys_id as string | undefined
  const pause_reason = args.pause_reason as string | undefined

  if (!task_sla_sys_id) {
    return createErrorResult("task_sla_sys_id is required for pause action")
  }

  const client = await getAuthenticatedClient(context)
  const taskSla = await findTaskSla(client, task_sla_sys_id)
  if (!taskSla) {
    return createErrorResult(`task_sla not found: ${task_sla_sys_id}`)
  }

  // TODO: verify task_sla.stage values on a live instance — most platforms
  // expose "paused" as a choice; older releases may use "on_hold".
  const patch: Record<string, unknown> = {
    stage: "paused",
  }
  if (pause_reason) patch.work_notes = pause_reason

  const response = await client.patch(`/api/now/table/task_sla/${task_sla_sys_id}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "pause",
    paused: true,
    sys_id: task_sla_sys_id,
    task_sla: updated,
  })
}

// ==================== RESUME ====================

async function executeResume(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const task_sla_sys_id = args.task_sla_sys_id as string | undefined

  if (!task_sla_sys_id) {
    return createErrorResult("task_sla_sys_id is required for resume action")
  }

  const client = await getAuthenticatedClient(context)
  const taskSla = await findTaskSla(client, task_sla_sys_id)
  if (!taskSla) {
    return createErrorResult(`task_sla not found: ${task_sla_sys_id}`)
  }

  // TODO: verify the resume stage value on a live instance — "in_progress" is
  // the documented default; some derivations use "active".
  const response = await client.patch(`/api/now/table/task_sla/${task_sla_sys_id}`, {
    stage: "in_progress",
  })
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "resume",
    resumed: true,
    sys_id: task_sla_sys_id,
    task_sla: updated,
  })
}

// ==================== LIST_BREACHES ====================

async function executeListBreaches(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const table = args.table as string | undefined
  const assignment_group = args.assignment_group as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = ["has_breached=true", "active=true"]
  if (table) queryParts.push(`task.sys_class_name=${table}`)
  if (assignment_group) queryParts.push(`task.assignment_group=${assignment_group}`)

  const response = await client.get("/api/now/table/task_sla", {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_display_value: "true",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,sla,task,stage,has_breached,business_percentage,business_time_left,planned_end_time" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_breaches",
    count: results.length,
    breaches: results,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
