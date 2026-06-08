/**
 * snow_fsm_work_order_manage - Unified Field Service Management work order
 * lifecycle tool.
 *
 * Wraps the wm_order (Work Order), wm_task (Work Task), and
 * wm_order_history tables that the Field Service Management plugin
 * (com.snc.work_management) installs. Covers the lifecycle from
 * creation through assignment, scheduling and status updates, plus
 * read-only access to the dependent work tasks.
 *
 * Greenfield: this is the first FSM coverage in the repo. Every
 * column referenced below is best-effort against the documented FSM
 * data model — fields and state names should be verified against a
 * live instance with the plugin activated before this tool is
 * trusted for write operations.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

const WORK_ORDER_TABLE = "wm_order"
const WORK_TASK_TABLE = "wm_task"
const WORK_ORDER_HISTORY_TABLE = "wm_order_history"
const FSM_PLUGIN = "com.snc.work_management"

// Work Order state names as used in FSM. ServiceNow stores these as
// numeric state codes whose meaning is configured per instance, so we
// accept the human-readable name and resolve via sys_choice at runtime.
// TODO: verify exact state catalog (Draft, Scheduled, Dispatched, En Route,
// Onsite, Work in Progress, Closed Complete, Closed Incomplete, Cancelled,
// Pending Dispatch) against a live instance — greenfield FSM tool, no
// in-repo reference.
const WORK_ORDER_STATES = [
  "Draft",
  "Pending Dispatch",
  "Scheduled",
  "Dispatched",
  "En Route",
  "Onsite",
  "Work in Progress",
  "Closed Complete",
  "Closed Incomplete",
  "Cancelled",
] as const

export const toolDefinition: MCPToolDefinition = {
  name: "snow_fsm_work_order_manage",
  description: `Unified tool for ServiceNow Field Service Management work orders. Wraps the wm_order, wm_task and wm_order_history tables installed by the Field Service Management plugin (com.snc.work_management).

Actions:
- list — list work orders, optionally filtered by state, assignment_group, assigned_to, or location
- get — retrieve a single work order by sys_id or number (includes related task and history counts)
- create — create a new work order with short_description, location, contact, priority, and optional scheduling window
- assign — assign the work order to a technician (assigned_to) and/or dispatch group (assignment_group)
- schedule — set the scheduled work_start and work_end on the work order
- update_status — transition the state field by human-readable state name (Draft, Scheduled, En Route, Onsite, Closed Complete, ...)
- list_tasks — list the wm_task rows linked to a parent work order

Use when: the agent needs to create, dispatch, schedule, or report on field-service work orders. Requires the Field Service Management plugin (com.snc.work_management) on the target instance — every action surfaces a clear PLUGIN_MISSING error if wm_order is absent.

Returns: work order records with sys_id, number, short_description, state, priority, assignment_group, assigned_to, location, contact, work_start, work_end. For list_tasks returns wm_task rows with sys_id, number, short_description and state.`,
  category: "itsm",
  subcategory: "field-service",
  use_cases: ["field-service", "work-order", "dispatch", "scheduling", "fsm"],
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
        enum: ["list", "get", "create", "assign", "schedule", "update_status", "list_tasks"],
      },
      // Identifiers
      sys_id: {
        type: "string",
        description: "[get/assign/schedule/update_status/list_tasks] Work order sys_id",
      },
      number: {
        type: "string",
        description: "[get/assign/schedule/update_status/list_tasks] Work order number (e.g. WO0001234) — used when sys_id is absent",
      },
      // CREATE fields
      short_description: {
        type: "string",
        description: "[create] One-line summary of the work to be performed",
      },
      description: {
        type: "string",
        description: "[create] Long description / instructions for the technician",
      },
      priority: {
        type: "number",
        description: "[create] Priority (1 = Critical, 2 = High, 3 = Moderate, 4 = Low, 5 = Planning)",
        enum: [1, 2, 3, 4, 5],
      },
      location: {
        type: "string",
        description: "[create] cmn_location sys_id or name where the work is performed",
      },
      contact: {
        type: "string",
        description: "[create] sys_user sys_id of the on-site contact for the work order",
      },
      company: {
        type: "string",
        description: "[create] core_company sys_id of the customer / account",
      },
      // ASSIGN fields
      assignment_group: {
        type: "string",
        description: "[create/assign] sys_user_group sys_id or name of the dispatch group",
      },
      assigned_to: {
        type: "string",
        description: "[create/assign] sys_user sys_id or user_name of the technician",
      },
      // SCHEDULE fields
      work_start: {
        type: "string",
        description: "[create/schedule] Scheduled start datetime (YYYY-MM-DD HH:MM:SS in instance TZ)",
      },
      work_end: {
        type: "string",
        description: "[create/schedule] Scheduled end datetime (YYYY-MM-DD HH:MM:SS in instance TZ)",
      },
      // STATE
      state: {
        type: "string",
        description: "[update_status] New state name. Resolved against the wm_order state choice list on the target instance.",
        enum: [...WORK_ORDER_STATES],
      },
      close_notes: {
        type: "string",
        description: "[update_status] Close notes (recorded when state is set to Closed Complete or Closed Incomplete)",
      },
      // FILTERS for list / list_tasks
      filter_state: {
        type: "string",
        description: "[list] Filter by state name (matches the same choice list as update_status)",
      },
      filter_assigned_to: {
        type: "string",
        description: "[list] Filter by assigned_to (sys_user sys_id or user_name)",
      },
      filter_assignment_group: {
        type: "string",
        description: "[list] Filter by assignment_group (sys_user_group sys_id or name)",
      },
      filter_location: {
        type: "string",
        description: "[list] Filter by location (cmn_location sys_id or name)",
      },
      limit: {
        type: "number",
        description: "[list/list_tasks] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list/get/list_tasks] Comma-separated list of fields to return (defaults to a curated set)",
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
      case "assign":
        return await executeAssign(args, context)
      case "schedule":
        return await executeSchedule(args, context)
      case "update_status":
        return await executeUpdateStatus(args, context)
      case "list_tasks":
        return await executeListTasks(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list, get, create, assign, schedule, update_status, list_tasks`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    const wrapped = wrapFsmError(err, action)
    return createErrorResult(wrapped)
  }
}

// ==================== HELPERS ====================

function wrapFsmError(err: Error, action: string): SnowFlowError {
  const msg = err.message || ""
  // ServiceNow returns "Invalid table" / 404 when a plugin-gated table
  // is missing. Surface a clear remediation message instead of the raw
  // ServiceNow error.
  if (msg.indexOf("Invalid table") !== -1 || msg.indexOf("404") !== -1) {
    return new SnowFlowError(
      ErrorType.PLUGIN_MISSING,
      `Field Service Management tables are not available on this instance. Activate the Field Service Management plugin (${FSM_PLUGIN}) and retry.`,
      { details: { plugin: FSM_PLUGIN, originalMessage: msg } },
    )
  }
  if (err instanceof SnowFlowError) return err
  return new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `FSM work_order ${action} failed: ${msg}`, {
    originalError: err,
  })
}

async function findWorkOrder(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string | undefined,
  number: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (sysId) {
    const direct = await client.get(`/api/now/table/${WORK_ORDER_TABLE}/${sysId}`)
    if (direct.data.result && (direct.data.result as Record<string, unknown>).sys_id) {
      return direct.data.result as Record<string, unknown>
    }
  }
  if (number) {
    const search = await client.get(`/api/now/table/${WORK_ORDER_TABLE}`, {
      params: {
        sysparm_query: `number=${number}`,
        sysparm_limit: 1,
      },
    })
    const results = (search.data.result || []) as Array<Record<string, unknown>>
    if (results.length > 0) return results[0]
  }
  return null
}

async function resolveStateValue(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  stateName: string,
): Promise<string | null> {
  // wm_order.state is a choice field — the stored value is numeric.
  // Look up the value for the given label on the wm_order table.
  // TODO: verify the state choice list table name and label format on
  // a live instance — sys_choice rows for FSM are added by the
  // com.snc.work_management plugin.
  const response = await client.get("/api/now/table/sys_choice", {
    params: {
      sysparm_query: `name=${WORK_ORDER_TABLE}^element=state^label=${stateName}`,
      sysparm_fields: "value,label",
      sysparm_limit: 1,
    },
  })
  const rows = (response.data.result || []) as Array<Record<string, unknown>>
  if (rows.length === 0) return null
  const value = rows[0].value
  return typeof value === "string" ? value : null
}

const DEFAULT_LIST_FIELDS =
  "sys_id,number,short_description,state,priority,assignment_group,assigned_to,location,contact,work_start,work_end,sys_updated_on"

// ==================== LIST ====================

async function executeList(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const filter_state = args.filter_state as string | undefined
  const filter_assigned_to = args.filter_assigned_to as string | undefined
  const filter_assignment_group = args.filter_assignment_group as string | undefined
  const filter_location = args.filter_location as string | undefined
  const limit = (args.limit as number) || 50
  const fields = (args.fields as string) || DEFAULT_LIST_FIELDS

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (filter_state) {
    const stateValue = await resolveStateValue(client, filter_state)
    if (stateValue !== null) queryParts.push(`state=${stateValue}`)
    else queryParts.push(`stateLABEL=${filter_state}`)
  }
  if (filter_assigned_to) queryParts.push(`assigned_to=${filter_assigned_to}`)
  if (filter_assignment_group) queryParts.push(`assignment_group=${filter_assignment_group}`)
  if (filter_location) queryParts.push(`location=${filter_location}`)

  const response = await client.get(`/api/now/table/${WORK_ORDER_TABLE}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "sys_updated_on",
      sysparm_order: "desc",
      sysparm_fields: fields,
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list",
    count: results.length,
    work_orders: results.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      short_description: r.short_description,
      state: r.state,
      priority: r.priority,
      assignment_group: r.assignment_group,
      assigned_to: r.assigned_to,
      location: r.location,
      contact: r.contact,
      work_start: r.work_start,
      work_end: r.work_end,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${WORK_ORDER_TABLE}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== GET ====================

async function executeGet(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const number = args.number as string | undefined

  if (!sys_id && !number) {
    return createErrorResult("sys_id or number is required for get action")
  }

  const client = await getAuthenticatedClient(context)
  const workOrder = await findWorkOrder(client, sys_id, number)
  if (!workOrder) {
    return createErrorResult(`Work order not found: ${sys_id || number}`)
  }

  const workOrderSysId = workOrder.sys_id as string

  // Best-effort counts of dependent tasks and history rows.
  let taskCount = 0
  let historyCount = 0
  try {
    const tasks = await client.get(`/api/now/table/${WORK_TASK_TABLE}`, {
      params: { sysparm_query: `work_order=${workOrderSysId}`, sysparm_fields: "sys_id", sysparm_limit: 500 },
    })
    taskCount = ((tasks.data.result || []) as Array<unknown>).length
  } catch {
    // wm_task may not be present on every instance variant. Swallow.
  }
  try {
    const history = await client.get(`/api/now/table/${WORK_ORDER_HISTORY_TABLE}`, {
      params: { sysparm_query: `work_order=${workOrderSysId}`, sysparm_fields: "sys_id", sysparm_limit: 500 },
    })
    historyCount = ((history.data.result || []) as Array<unknown>).length
  } catch {
    // wm_order_history is optional — not present on every FSM install.
  }

  return createSuccessResult({
    action: "get",
    sys_id: workOrderSysId,
    number: workOrder.number,
    work_order: workOrder,
    related: {
      task_count: taskCount,
      history_count: historyCount,
    },
    url: `${context.instanceUrl}/nav_to.do?uri=${WORK_ORDER_TABLE}.do?sys_id=${workOrderSysId}`,
  })
}

// ==================== CREATE ====================

async function executeCreate(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const short_description = args.short_description as string | undefined
  if (!short_description) {
    return createErrorResult("short_description is required for create action")
  }

  const client = await getAuthenticatedClient(context)

  const payload: Record<string, unknown> = { short_description }
  if (args.description) payload.description = args.description
  if (args.priority !== undefined) payload.priority = args.priority
  if (args.location) payload.location = args.location
  if (args.contact) payload.contact = args.contact
  if (args.company) payload.company = args.company
  if (args.assignment_group) payload.assignment_group = args.assignment_group
  if (args.assigned_to) payload.assigned_to = args.assigned_to
  if (args.work_start) payload.work_start = args.work_start
  if (args.work_end) payload.work_end = args.work_end

  const response = await client.post(`/api/now/table/${WORK_ORDER_TABLE}`, payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "create",
    created: true,
    sys_id: created.sys_id,
    number: created.number,
    work_order: created,
    url: `${context.instanceUrl}/nav_to.do?uri=${WORK_ORDER_TABLE}.do?sys_id=${created.sys_id}`,
  })
}

// ==================== ASSIGN ====================

async function executeAssign(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const number = args.number as string | undefined
  const assigned_to = args.assigned_to as string | undefined
  const assignment_group = args.assignment_group as string | undefined

  if (!sys_id && !number) {
    return createErrorResult("sys_id or number is required for assign action")
  }
  if (!assigned_to && !assignment_group) {
    return createErrorResult("Provide at least one of assigned_to or assignment_group for assign action")
  }

  const client = await getAuthenticatedClient(context)
  const workOrder = await findWorkOrder(client, sys_id, number)
  if (!workOrder) {
    return createErrorResult(`Work order not found: ${sys_id || number}`)
  }

  const targetSysId = workOrder.sys_id as string
  const patch: Record<string, unknown> = {}
  if (assigned_to) patch.assigned_to = assigned_to
  if (assignment_group) patch.assignment_group = assignment_group

  const response = await client.patch(`/api/now/table/${WORK_ORDER_TABLE}/${targetSysId}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "assign",
    assigned: true,
    sys_id: targetSysId,
    number: updated.number,
    assigned_to: updated.assigned_to,
    assignment_group: updated.assignment_group,
    work_order: updated,
    url: `${context.instanceUrl}/nav_to.do?uri=${WORK_ORDER_TABLE}.do?sys_id=${targetSysId}`,
  })
}

// ==================== SCHEDULE ====================

async function executeSchedule(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const number = args.number as string | undefined
  const work_start = args.work_start as string | undefined
  const work_end = args.work_end as string | undefined

  if (!sys_id && !number) {
    return createErrorResult("sys_id or number is required for schedule action")
  }
  if (!work_start && !work_end) {
    return createErrorResult("Provide at least one of work_start or work_end for schedule action")
  }

  const client = await getAuthenticatedClient(context)
  const workOrder = await findWorkOrder(client, sys_id, number)
  if (!workOrder) {
    return createErrorResult(`Work order not found: ${sys_id || number}`)
  }

  const targetSysId = workOrder.sys_id as string
  const patch: Record<string, unknown> = {}
  if (work_start) patch.work_start = work_start
  if (work_end) patch.work_end = work_end

  const response = await client.patch(`/api/now/table/${WORK_ORDER_TABLE}/${targetSysId}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "schedule",
    scheduled: true,
    sys_id: targetSysId,
    number: updated.number,
    work_start: updated.work_start,
    work_end: updated.work_end,
    work_order: updated,
    url: `${context.instanceUrl}/nav_to.do?uri=${WORK_ORDER_TABLE}.do?sys_id=${targetSysId}`,
  })
}

// ==================== UPDATE_STATUS ====================

async function executeUpdateStatus(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const number = args.number as string | undefined
  const state = args.state as string | undefined
  const close_notes = args.close_notes as string | undefined

  if (!sys_id && !number) {
    return createErrorResult("sys_id or number is required for update_status action")
  }
  if (!state) {
    return createErrorResult("state is required for update_status action")
  }

  const client = await getAuthenticatedClient(context)
  const workOrder = await findWorkOrder(client, sys_id, number)
  if (!workOrder) {
    return createErrorResult(`Work order not found: ${sys_id || number}`)
  }

  const stateValue = await resolveStateValue(client, state)
  if (stateValue === null) {
    return createErrorResult(
      `State "${state}" is not configured on this instance for ${WORK_ORDER_TABLE}. Verify the state choice list — FSM state labels can be customised per instance.`,
    )
  }

  const targetSysId = workOrder.sys_id as string
  const patch: Record<string, unknown> = { state: stateValue }
  if (close_notes) patch.close_notes = close_notes

  const response = await client.patch(`/api/now/table/${WORK_ORDER_TABLE}/${targetSysId}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "update_status",
    updated: true,
    sys_id: targetSysId,
    number: updated.number,
    new_state_value: stateValue,
    new_state_label: state,
    work_order: updated,
    url: `${context.instanceUrl}/nav_to.do?uri=${WORK_ORDER_TABLE}.do?sys_id=${targetSysId}`,
  })
}

// ==================== LIST_TASKS ====================

async function executeListTasks(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const number = args.number as string | undefined
  const limit = (args.limit as number) || 50
  const fields = (args.fields as string) || "sys_id,number,short_description,state,assigned_to,work_order,sys_updated_on"

  if (!sys_id && !number) {
    return createErrorResult("sys_id or number is required for list_tasks action")
  }

  const client = await getAuthenticatedClient(context)
  const workOrder = await findWorkOrder(client, sys_id, number)
  if (!workOrder) {
    return createErrorResult(`Work order not found: ${sys_id || number}`)
  }

  const workOrderSysId = workOrder.sys_id as string
  // wm_task has a direct `work_order` reference column to wm_order — preferred over inherited task.parent.
  const response = await client.get(`/api/now/table/${WORK_TASK_TABLE}`, {
    params: {
      sysparm_query: `work_order=${workOrderSysId}`,
      sysparm_limit: limit,
      sysparm_orderby: "sys_created_on",
      sysparm_fields: fields,
    },
  })

  const tasks = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_tasks",
    work_order: { sys_id: workOrderSysId, number: workOrder.number },
    count: tasks.length,
    tasks: tasks.map((t) => ({
      sys_id: t.sys_id,
      number: t.number,
      short_description: t.short_description,
      state: t.state,
      assigned_to: t.assigned_to,
      updated_at: t.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${WORK_TASK_TABLE}.do?sys_id=${t.sys_id}`,
    })),
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
