/**
 * snow_fsm_dispatch_manage - Unified Field Service Management dispatch
 * lookup tool.
 *
 * Important: modern ServiceNow Field Service Management does NOT
 * surface a single "agent" or "dispatch" table. There is no wm_agent
 * row per technician — agents are simply sys_user records that hold
 * one or more wm_* roles (wm_agent, wm_dispatcher, wm_manager, ...).
 * Dispatch routing is composed from several different tables instead:
 *
 *   - sys_user filtered by an FSM role -> the pool of technicians
 *   - sys_user_group                    -> assignment groups
 *   - wm_agent_schedule_attribute_plan  -> per-user travel / overtime /
 *                                          home-base / search-radius
 *                                          policy that the dispatcher
 *                                          uses when scheduling
 *   - wm_work_order_task_potential_assignment_groups
 *                                       -> which assignment groups are
 *                                          eligible for a specific
 *                                          wm_task
 *   - wm_order.assigned_to / assignment_group (inherited from task)
 *                                       -> the actual assignment
 *
 * This tool surfaces those pieces with safe read actions and a single
 * write action (assign_to_work_order) that patches the wm_order's
 * assigned_to / assignment_group. AI dispatch / scheduling engines
 * are NOT called — the caller treats the read results as candidates,
 * not binding decisions.
 *
 * Field list for every table verified against sys_dictionary on a
 * live instance with com.snc.work_management active.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

const USER_TABLE = "sys_user"
const USER_GROUP_TABLE = "sys_user_group"
const USER_HAS_ROLE_TABLE = "sys_user_has_role"
const ROLE_TABLE = "sys_user_role"
const SCHEDULE_PLAN_TABLE = "wm_agent_schedule_attribute_plan"
const POTENTIAL_GROUPS_TABLE = "wm_work_order_task_potential_assignment_groups"
const WORK_ORDER_TABLE = "wm_order"
const WORK_TASK_TABLE = "wm_task"
const FSM_PLUGIN = "com.snc.work_management"

// Roles installed by com.snc.work_management. Used as the default
// pool for list_agents. Verified against sys_user_role on a live
// instance.
const FSM_AGENT_ROLES = [
  "wm_agent",
  "wm_dispatcher",
  "wm_manager",
  "wm_admin",
  "wm_qualifier",
  "wm_initiator",
  "wm_initiator_qualifier",
  "wm_initiator_qualifier_dispatcher",
  "wm_basic",
  "wm_read",
  "wm_approver_user",
  "wm_task_initiator",
] as const

export const toolDefinition: MCPToolDefinition = {
  name: "snow_fsm_dispatch_manage",
  description: `Unified tool for ServiceNow Field Service Management dispatch lookups. Modern ServiceNow FSM does not store dispatch in a single table — there is no wm_agent / wm_dispatch_group table. This tool composes the answer from several real tables: sys_user (filtered by wm_* role) for technicians, sys_user_group for assignment groups, wm_agent_schedule_attribute_plan for per-user schedule policy, and wm_work_order_task_potential_assignment_groups for which groups are eligible for a specific work task.

Companion tool: snow_fsm_work_order_manage handles wm_order CRUD and snow_fsm_parts_manage handles sm_part_requirement CRUD.

Actions:
- list_agents - list sys_user rows that hold any FSM role (wm_agent, wm_dispatcher, wm_manager, ...). Optional filters: role, group, location, active flag, and free-text name search
- list_groups - list sys_user_group rows. Optional filter: name LIKE search and active flag. Use for picking an assignment_group on a wm_order
- list_schedules - list wm_agent_schedule_attribute_plan rows for a given sys_user (or the full set with no filter). Returns home base, travel radius, overtime / penalty rates and the schedule window
- list_potential_groups_for_task - list wm_work_order_task_potential_assignment_groups rows for a given wm_task sys_id. Tells you which assignment groups are eligible to take that task
- assign_to_work_order - patch a wm_order with assigned_to (sys_user) and/or assignment_group (sys_user_group). Inherited from task — both fields exist on wm_order even though they aren't declared directly on wm_order in sys_dictionary

Use when: the agent needs to pick a technician or assignment group, audit FSM role membership, look up a technician's schedule policy, or do the actual assignment on a work order. Read actions hit live tables only — no AI dispatch / scheduling engine is invoked.

Returns: agents include sys_id, user_name, name, email, active, location, fsm_roles. Groups include sys_id, name, active, manager. Schedule plans include sys_id, user, default flag, from/to window, start/end location, travel radius, overtime caps and penalty rates. Potential-group rows include sys_id, work_order_task, assignment_group, active. assign_to_work_order returns the patched wm_order.`,
  category: "itsm",
  subcategory: "field-service",
  use_cases: ["field-service", "dispatch", "scheduling", "technician", "assignment", "fsm"],
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
        enum: [
          "list_agents",
          "list_groups",
          "list_schedules",
          "list_potential_groups_for_task",
          "assign_to_work_order",
        ],
      },
      // Filters for list_agents
      role: {
        type: "string",
        description: "[list_agents] Filter to a single FSM role name (e.g. wm_agent, wm_dispatcher). Default is any wm_* role",
      },
      group: {
        type: "string",
        description: "[list_agents] sys_user_group sys_id to filter agents by group membership",
      },
      location: {
        type: "string",
        description: "[list_agents] cmn_location sys_id to filter agents by location",
      },
      name_like: {
        type: "string",
        description: "[list_agents/list_groups] Free-text LIKE match against the name column",
      },
      active_only: {
        type: "boolean",
        description: "[list_agents/list_groups/list_schedules/list_potential_groups_for_task] Only return active rows",
        default: true,
      },
      // Filters for list_schedules
      user: {
        type: "string",
        description: "[list_schedules] sys_user sys_id to filter schedule attribute plans by",
      },
      // Filters for list_potential_groups_for_task
      work_order_task: {
        type: "string",
        description: "[list_potential_groups_for_task] wm_task sys_id to look up potential assignment groups for",
      },
      // ASSIGN_TO_WORK_ORDER fields
      work_order_sys_id: {
        type: "string",
        description: "[assign_to_work_order] sys_id of the wm_order to assign",
      },
      work_order_number: {
        type: "string",
        description: "[assign_to_work_order] number of the wm_order (used when work_order_sys_id is absent)",
      },
      assigned_to: {
        type: "string",
        description: "[assign_to_work_order] sys_user sys_id of the technician to assign",
      },
      assignment_group: {
        type: "string",
        description: "[assign_to_work_order] sys_user_group sys_id of the assignment group to set",
      },
      // List shaping
      limit: {
        type: "number",
        description: "[list_*] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list_*] Comma-separated list of fields to return (defaults to a curated set per action)",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list_agents":
        return await executeListAgents(args, context)
      case "list_groups":
        return await executeListGroups(args, context)
      case "list_schedules":
        return await executeListSchedules(args, context)
      case "list_potential_groups_for_task":
        return await executeListPotentialGroupsForTask(args, context)
      case "assign_to_work_order":
        return await executeAssignToWorkOrder(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list_agents, list_groups, list_schedules, list_potential_groups_for_task, assign_to_work_order`,
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
  if (msg.indexOf("Invalid table") !== -1 || msg.indexOf("404") !== -1) {
    return new SnowFlowError(
      ErrorType.PLUGIN_MISSING,
      `Field Service Management dispatch tables are not available on this instance. Activate the Field Service Management plugin (${FSM_PLUGIN}) and retry.`,
      { details: { plugin: FSM_PLUGIN, originalMessage: msg } },
    )
  }
  if (err instanceof SnowFlowError) return err
  return new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `FSM dispatch ${action} failed: ${msg}`, {
    originalError: err,
  })
}

async function resolveRoleSysId(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  roleName: string,
): Promise<string | null> {
  const response = await client.get(`/api/now/table/${ROLE_TABLE}`, {
    params: { sysparm_query: `name=${roleName}`, sysparm_fields: "sys_id", sysparm_limit: 1 },
  })
  const rows = (response.data.result || []) as Array<Record<string, unknown>>
  if (rows.length === 0) return null
  return (rows[0].sys_id as string) || null
}

async function fetchAgentSysIdsByRoles(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  roleNames: readonly string[],
): Promise<{ userSysIds: Set<string>; rolesByUser: Map<string, Set<string>> }> {
  // Resolve role names to sys_ids first so we can do a single
  // sys_user_has_role query with role IN (...).
  const roleSysIds: string[] = []
  const roleNameById = new Map<string, string>()
  for (const name of roleNames) {
    const sysId = await resolveRoleSysId(client, name)
    if (sysId) {
      roleSysIds.push(sysId)
      roleNameById.set(sysId, name)
    }
  }

  const userSysIds = new Set<string>()
  const rolesByUser = new Map<string, Set<string>>()

  if (roleSysIds.length === 0) {
    return { userSysIds, rolesByUser }
  }

  const response = await client.get(`/api/now/table/${USER_HAS_ROLE_TABLE}`, {
    params: {
      sysparm_query: `roleIN${roleSysIds.join(",")}`,
      sysparm_fields: "user,role",
      sysparm_limit: 1000,
    },
  })
  const rows = (response.data.result || []) as Array<Record<string, unknown>>
  for (const row of rows) {
    const userRef = row.user
    const roleRef = row.role
    const userSysId =
      typeof userRef === "string"
        ? userRef
        : userRef && typeof userRef === "object" && "value" in userRef
          ? (userRef as { value: string }).value
          : ""
    const roleSysId =
      typeof roleRef === "string"
        ? roleRef
        : roleRef && typeof roleRef === "object" && "value" in roleRef
          ? (roleRef as { value: string }).value
          : ""
    if (!userSysId) continue
    userSysIds.add(userSysId)
    const set = rolesByUser.get(userSysId) ?? new Set<string>()
    const roleName = roleNameById.get(roleSysId)
    if (roleName) set.add(roleName)
    rolesByUser.set(userSysId, set)
  }

  return { userSysIds, rolesByUser }
}

async function resolveWorkOrderSysId(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string | undefined,
  number: string | undefined,
): Promise<string | null> {
  if (sysId) return sysId
  if (!number) return null
  const response = await client.get(`/api/now/table/${WORK_ORDER_TABLE}`, {
    params: { sysparm_query: `number=${number}`, sysparm_fields: "sys_id", sysparm_limit: 1 },
  })
  const rows = (response.data.result || []) as Array<Record<string, unknown>>
  if (rows.length === 0) return null
  return (rows[0].sys_id as string) || null
}

// ==================== LIST_AGENTS ====================

async function executeListAgents(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const role = args.role as string | undefined
  const group = args.group as string | undefined
  const location = args.location as string | undefined
  const name_like = args.name_like as string | undefined
  const active_only = args.active_only !== false
  const limit = (args.limit as number) || 50
  const fields = (args.fields as string) || "sys_id,user_name,name,email,active,location,department"

  const client = await getAuthenticatedClient(context)

  // Resolve which roles to filter on. Either the caller supplied one
  // specific role, or we use the full set of FSM roles.
  const roleNames = role ? [role] : FSM_AGENT_ROLES
  const { userSysIds, rolesByUser } = await fetchAgentSysIdsByRoles(client, roleNames)

  if (userSysIds.size === 0) {
    return createSuccessResult({
      action: "list_agents",
      count: 0,
      agents: [],
      note: role
        ? `No users hold role ${role}. (Verify the role exists with sys_user_role table.)`
        : "No users hold any FSM role on this instance.",
    })
  }

  // Group membership filter is satisfied via sys_user_grmember.
  let groupMemberSysIds: Set<string> | null = null
  if (group) {
    const memberResponse = await client.get(`/api/now/table/sys_user_grmember`, {
      params: {
        sysparm_query: `group=${group}`,
        sysparm_fields: "user",
        sysparm_limit: 1000,
      },
    })
    const memberRows = (memberResponse.data.result || []) as Array<Record<string, unknown>>
    groupMemberSysIds = new Set<string>()
    for (const row of memberRows) {
      const ref = row.user
      const userSysId =
        typeof ref === "string"
          ? ref
          : ref && typeof ref === "object" && "value" in ref
            ? (ref as { value: string }).value
            : ""
      if (userSysId) groupMemberSysIds.add(userSysId)
    }
  }

  const finalSysIds: string[] = []
  for (const id of userSysIds) {
    if (groupMemberSysIds && !groupMemberSysIds.has(id)) continue
    finalSysIds.push(id)
  }
  if (finalSysIds.length === 0) {
    return createSuccessResult({
      action: "list_agents",
      count: 0,
      agents: [],
      note: "No FSM-roled users matched the supplied group filter.",
    })
  }

  const queryParts: string[] = [`sys_idIN${finalSysIds.join(",")}`]
  if (active_only) queryParts.push("active=true")
  if (location) queryParts.push(`location=${location}`)
  if (name_like) queryParts.push(`nameLIKE${name_like}`)

  const response = await client.get(`/api/now/table/${USER_TABLE}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "name",
      sysparm_fields: fields,
    },
  })

  const users = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_agents",
    count: users.length,
    role_filter: role || "any wm_* role",
    agents: users.map((u) => ({
      sys_id: u.sys_id,
      user_name: u.user_name,
      name: u.name,
      email: u.email,
      active: u.active,
      location: u.location,
      department: u.department,
      fsm_roles: Array.from(rolesByUser.get(u.sys_id as string) ?? []),
      url: `${context.instanceUrl}/nav_to.do?uri=${USER_TABLE}.do?sys_id=${u.sys_id}`,
    })),
  })
}

// ==================== LIST_GROUPS ====================

async function executeListGroups(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const name_like = args.name_like as string | undefined
  const active_only = args.active_only !== false
  const limit = (args.limit as number) || 50
  const fields = (args.fields as string) || "sys_id,name,description,active,manager,parent,email"

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (active_only) queryParts.push("active=true")
  if (name_like) queryParts.push(`nameLIKE${name_like}`)

  const response = await client.get(`/api/now/table/${USER_GROUP_TABLE}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "name",
      sysparm_fields: fields,
    },
  })

  const groups = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_groups",
    count: groups.length,
    groups: groups.map((g) => ({
      sys_id: g.sys_id,
      name: g.name,
      description: g.description,
      manager: g.manager,
      parent: g.parent,
      email: g.email,
      active: g.active,
      url: `${context.instanceUrl}/nav_to.do?uri=${USER_GROUP_TABLE}.do?sys_id=${g.sys_id}`,
    })),
  })
}

// ==================== LIST_SCHEDULES ====================

async function executeListSchedules(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const user = args.user as string | undefined
  const limit = (args.limit as number) || 50
  const fields =
    (args.fields as string) ||
    "sys_id,user,default,rank,from,to,start_location,end_location,maximum_travel_radius,maximum_part_search_radius,distance_unit,travel_outside_of_work_hours,post_shift_max_overtime,work_penalty_per_hour,travel_penalty_per_hour,overtime_penalty_per_hour,sys_updated_on"

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (user) queryParts.push(`user=${user}`)

  const response = await client.get(`/api/now/table/${SCHEDULE_PLAN_TABLE}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "rank",
      sysparm_fields: fields,
    },
  })

  const plans = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_schedules",
    count: plans.length,
    schedules: plans.map((p) => ({
      sys_id: p.sys_id,
      user: p.user,
      default: p.default,
      rank: p.rank,
      window: { from: p.from, to: p.to },
      start_location: p.start_location,
      end_location: p.end_location,
      maximum_travel_radius: p.maximum_travel_radius,
      maximum_part_search_radius: p.maximum_part_search_radius,
      distance_unit: p.distance_unit,
      travel_outside_of_work_hours: p.travel_outside_of_work_hours,
      post_shift_max_overtime: p.post_shift_max_overtime,
      penalties: {
        work_per_hour: p.work_penalty_per_hour,
        travel_per_hour: p.travel_penalty_per_hour,
        overtime_per_hour: p.overtime_penalty_per_hour,
      },
      updated_at: p.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${SCHEDULE_PLAN_TABLE}.do?sys_id=${p.sys_id}`,
    })),
  })
}

// ==================== LIST_POTENTIAL_GROUPS_FOR_TASK ====================

async function executeListPotentialGroupsForTask(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const work_order_task = args.work_order_task as string | undefined
  const active_only = args.active_only !== false
  const limit = (args.limit as number) || 50
  const fields =
    (args.fields as string) || "sys_id,work_order_task,assignment_group,active,sys_updated_on"

  if (!work_order_task) {
    return createErrorResult("work_order_task (wm_task sys_id) is required for list_potential_groups_for_task action")
  }

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = [`work_order_task=${work_order_task}`]
  if (active_only) queryParts.push("active=true")

  const response = await client.get(`/api/now/table/${POTENTIAL_GROUPS_TABLE}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "sys_created_on",
      sysparm_fields: fields,
    },
  })

  const rows = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_potential_groups_for_task",
    work_order_task,
    count: rows.length,
    potential_groups: rows.map((r) => ({
      sys_id: r.sys_id,
      work_order_task: r.work_order_task,
      assignment_group: r.assignment_group,
      active: r.active,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${POTENTIAL_GROUPS_TABLE}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== ASSIGN_TO_WORK_ORDER ====================

async function executeAssignToWorkOrder(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const work_order_sys_id = args.work_order_sys_id as string | undefined
  const work_order_number = args.work_order_number as string | undefined
  const assigned_to = args.assigned_to as string | undefined
  const assignment_group = args.assignment_group as string | undefined

  if (!work_order_sys_id && !work_order_number) {
    return createErrorResult("work_order_sys_id or work_order_number is required for assign_to_work_order action")
  }
  if (!assigned_to && !assignment_group) {
    return createErrorResult(
      "Provide at least one of assigned_to (sys_user) or assignment_group (sys_user_group) for assign_to_work_order action",
    )
  }

  const client = await getAuthenticatedClient(context)

  const targetSysId = await resolveWorkOrderSysId(client, work_order_sys_id, work_order_number)
  if (!targetSysId) {
    return createErrorResult(`Work order not found: ${work_order_sys_id || work_order_number}`)
  }

  const patch: Record<string, unknown> = {}
  if (assigned_to) patch.assigned_to = assigned_to
  if (assignment_group) patch.assignment_group = assignment_group

  const response = await client.patch(`/api/now/table/${WORK_ORDER_TABLE}/${targetSysId}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "assign_to_work_order",
    assigned: true,
    sys_id: targetSysId,
    number: updated.number,
    assigned_to: updated.assigned_to,
    assignment_group: updated.assignment_group,
    work_order: updated,
    url: `${context.instanceUrl}/nav_to.do?uri=${WORK_ORDER_TABLE}.do?sys_id=${targetSysId}`,
  })
}

export const version = "1.1.0"
export const author = "groeimetai"
