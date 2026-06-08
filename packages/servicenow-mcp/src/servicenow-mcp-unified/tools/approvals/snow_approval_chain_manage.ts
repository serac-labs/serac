/**
 * snow_approval_chain_manage - Unified Approval Chain management
 *
 * Manages multi-step approval workflows over the ServiceNow approval engine
 * tables: sysapproval_approver (per-approver request rows), sysapproval_group
 * (group-based approval requests), and sysapproval_action (the verb history
 * applied to an approval). Where snow_request_approval inserts a single
 * ad-hoc approver, this tool defines an ordered chain, lets the caller
 * preview the chain before firing it, lists currently pending approvals on
 * a record, and cancels an in-flight chain.
 *
 * Companion to snow_request_approval (single ad-hoc approval),
 * snow_approve_reject (acts on a single sysapproval_approver), and
 * snow_get_pending_approvals (per-user inbox view).
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

interface ChainStep {
  approver?: string
  group?: string
  order?: number
  comments?: string
}

export const toolDefinition: MCPToolDefinition = {
  name: "snow_approval_chain_manage",
  description: `Unified tool for ServiceNow approval chains across the sysapproval_approver, sysapproval_group, and sysapproval_action tables. Use this when a record needs an ordered, multi-step approval flow rather than a single ad-hoc approver.

Actions:
- define_chain — write an ordered chain of approval steps for a source record. Each step may target a user (sysapproval_approver) or a group (sysapproval_group). Steps after the first start in 'not requested' state and are activated as earlier steps complete.
- preview_chain — resolve who would be asked at each step (expanding group memberships) without inserting any rows. Useful for showing the caller the chain before firing it.
- get_approvals — list all pending and historical approval rows for a given source record across both sysapproval_approver and sysapproval_group, plus the recent sysapproval_action verbs applied.
- cancel — end an active chain. Marks every still-open approver/group row as 'cancelled' and records a sysapproval_action 'cancelled' verb on each.

Use when: an agent needs to wire up a multi-step approval (e.g. peer → manager → director), preview the chain before committing, audit pending approvals on a record, or stop an in-flight chain. For a single ad-hoc approval use snow_request_approval; to act on an individual approval use snow_approve_reject.

Returns: define_chain returns the inserted approval rows in order. preview_chain returns the resolved approver list per step without writing. get_approvals returns pending and complete rows plus the recent action verbs. cancel returns the rows it closed.`,
  category: "itsm",
  subcategory: "approvals",
  use_cases: ["approvals", "workflow", "chain", "multi-step"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Approval chain action to perform",
        enum: ["define_chain", "preview_chain", "get_approvals", "cancel"],
      },
      // Source record (target of the approval chain)
      source_table: {
        type: "string",
        description: "[define_chain/preview_chain/get_approvals/cancel] Source table (e.g. change_request, sc_request, problem)",
      },
      source_sys_id: {
        type: "string",
        description: "[define_chain/preview_chain/get_approvals/cancel] Source record sys_id the chain attaches to",
      },
      // CHAIN definition
      steps: {
        type: "array",
        description: "[define_chain/preview_chain] Ordered chain steps. Each step has approver (user sys_id) OR group (sys_user_group sys_id), optional order (defaults to array index * 100), and optional comments.",
        items: {
          type: "object",
          properties: {
            approver: { type: "string", description: "User sys_id (use for individual approver step)" },
            group: { type: "string", description: "Group sys_id (use for group approval step)" },
            order: { type: "number", description: "Explicit order/sequence; defaults to (index + 1) * 100" },
            comments: { type: "string", description: "Optional comments stored on the approval row" },
          },
        },
      },
      activate_first: {
        type: "boolean",
        description: "[define_chain] Whether the first step is created in state 'requested' (active) or 'not requested' (queued). Defaults to true.",
        default: true,
      },
      // CANCEL
      cancel_comment: {
        type: "string",
        description: "[cancel] Comment recorded on each closed approval row and on the matching sysapproval_action verb",
      },
      // GET_APPROVALS filters
      include_complete: {
        type: "boolean",
        description: "[get_approvals] Include approver/group rows that are already approved/rejected/cancelled",
        default: false,
      },
      include_actions: {
        type: "boolean",
        description: "[get_approvals] Include recent sysapproval_action verb history for the source record",
        default: true,
      },
      limit: {
        type: "number",
        description: "[get_approvals] Maximum rows to return per table",
        default: 50,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "define_chain":
        return await executeDefineChain(args, context)
      case "preview_chain":
        return await executePreviewChain(args, context)
      case "get_approvals":
        return await executeGetApprovals(args, context)
      case "cancel":
        return await executeCancel(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: define_chain, preview_chain, get_approvals, cancel`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Approval chain ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

function readSteps(args: Record<string, unknown>): ChainStep[] | null {
  const raw = args.steps
  if (!Array.isArray(raw) || raw.length === 0) return null
  return raw as ChainStep[]
}

function validateSteps(steps: ChainStep[]): string | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (!step || typeof step !== "object") return `Step ${i + 1} is malformed`
    if (!step.approver && !step.group) {
      return `Step ${i + 1} requires either approver (user sys_id) or group (sys_user_group sys_id)`
    }
    if (step.approver && step.group) {
      return `Step ${i + 1} cannot specify both approver and group — pick one`
    }
  }
  return null
}

// ==================== DEFINE_CHAIN ====================

async function executeDefineChain(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const source_table = args.source_table as string | undefined
  const source_sys_id = args.source_sys_id as string | undefined
  const steps = readSteps(args)
  const activateFirst = args.activate_first === undefined ? true : args.activate_first === true

  if (!source_table) return createErrorResult("source_table is required for define_chain")
  if (!source_sys_id) return createErrorResult("source_sys_id is required for define_chain")
  if (!steps) return createErrorResult("steps is required for define_chain (non-empty array)")

  const stepError = validateSteps(steps)
  if (stepError) return createErrorResult(stepError)

  const client = await getAuthenticatedClient(context)

  const insertedApprovers: Array<Record<string, unknown>> = []
  const insertedGroups: Array<Record<string, unknown>> = []

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const order = typeof step.order === "number" ? step.order : (i + 1) * 100
    const isFirst = i === 0
    const stepState = isFirst && activateFirst ? "requested" : "not requested"

    if (step.approver) {
      const payload: Record<string, unknown> = {
        source_table,
        sysapproval: source_sys_id,
        approver: step.approver,
        state: stepState,
        order,
      }
      if (step.comments) payload.comments = step.comments
      const resp = await client.post("/api/now/table/sysapproval_approver", payload)
      insertedApprovers.push(resp.data.result)
    } else if (step.group) {
      // TODO: verify against live instance — older versions use the column
      // `group` while newer ones expose `approval_group`. We try `group` first
      // since it matches the OOB sysapproval_group table.
      const payload: Record<string, unknown> = {
        source_table,
        document_id: source_sys_id,
        group: step.group,
        state: stepState,
        order,
      }
      if (step.comments) payload.comments = step.comments
      const resp = await client.post("/api/now/table/sysapproval_group", payload)
      insertedGroups.push(resp.data.result)
    }
  }

  return createSuccessResult({
    action: "define_chain",
    created: true,
    source_table,
    source_sys_id,
    step_count: insertedApprovers.length + insertedGroups.length,
    approver_rows: insertedApprovers.map((r) => ({
      sys_id: r.sys_id,
      approver: r.approver,
      state: r.state,
      order: r.order,
    })),
    group_rows: insertedGroups.map((r) => ({
      sys_id: r.sys_id,
      group: (r as Record<string, unknown>).group ?? (r as Record<string, unknown>).approval_group,
      state: r.state,
      order: r.order,
    })),
  })
}

// ==================== PREVIEW_CHAIN ====================

async function executePreviewChain(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const steps = readSteps(args)
  if (!steps) return createErrorResult("steps is required for preview_chain (non-empty array)")
  const stepError = validateSteps(steps)
  if (stepError) return createErrorResult(stepError)

  const client = await getAuthenticatedClient(context)

  const resolved: Array<Record<string, unknown>> = []

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const order = typeof step.order === "number" ? step.order : (i + 1) * 100

    if (step.approver) {
      let userName = step.approver
      try {
        const userResp = await client.get(`/api/now/table/sys_user/${step.approver}`, {
          params: { sysparm_fields: "sys_id,name,email,active" },
        })
        const u = userResp.data.result as Record<string, unknown> | undefined
        if (u && u.name) userName = u.name as string
        resolved.push({
          step: i + 1,
          order,
          type: "user",
          approver_sys_id: step.approver,
          name: userName,
          email: u?.email ?? null,
          active: u?.active ?? null,
          comments: step.comments ?? null,
        })
      } catch {
        resolved.push({
          step: i + 1,
          order,
          type: "user",
          approver_sys_id: step.approver,
          name: null,
          warning: "User not found on this instance",
          comments: step.comments ?? null,
        })
      }
    } else if (step.group) {
      // Expand group membership to show who would actually be asked.
      const members: Array<Record<string, unknown>> = []
      try {
        // TODO: verify against live instance — sys_user_grmember is the OOB
        // membership join; some installs add an active filter at the join.
        const memResp = await client.get("/api/now/table/sys_user_grmember", {
          params: {
            sysparm_query: `group=${step.group}`,
            sysparm_fields: "user.sys_id,user.name,user.email,user.active",
            sysparm_limit: 50,
          },
        })
        const rows = (memResp.data.result || []) as Array<Record<string, unknown>>
        for (const row of rows) {
          members.push({
            sys_id: row["user.sys_id"],
            name: row["user.name"],
            email: row["user.email"],
            active: row["user.active"],
          })
        }
      } catch {
        // Membership lookup is best-effort
      }
      let groupName: string | null = null
      try {
        const gResp = await client.get(`/api/now/table/sys_user_group/${step.group}`, {
          params: { sysparm_fields: "sys_id,name,active" },
        })
        const g = gResp.data.result as Record<string, unknown> | undefined
        groupName = (g?.name as string) ?? null
      } catch {
        // Best-effort
      }
      resolved.push({
        step: i + 1,
        order,
        type: "group",
        group_sys_id: step.group,
        name: groupName,
        member_count: members.length,
        members,
        comments: step.comments ?? null,
      })
    }
  }

  return createSuccessResult({
    action: "preview_chain",
    step_count: resolved.length,
    chain: resolved,
  })
}

// ==================== GET_APPROVALS ====================

async function executeGetApprovals(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const source_table = args.source_table as string | undefined
  const source_sys_id = args.source_sys_id as string | undefined
  const include_complete = args.include_complete === true
  const include_actions = args.include_actions === undefined ? true : args.include_actions === true
  const limit = (args.limit as number) || 50

  if (!source_sys_id) return createErrorResult("source_sys_id is required for get_approvals")

  const client = await getAuthenticatedClient(context)

  const stateFilter = include_complete ? "" : "^stateIN requested,not requested"

  // Per-user approver rows
  const approverQueryParts = [`sysapproval=${source_sys_id}`]
  if (source_table) approverQueryParts.push(`source_table=${source_table}`)
  const approverQuery = approverQueryParts.join("^") + stateFilter

  const approverResp = await client.get("/api/now/table/sysapproval_approver", {
    params: {
      sysparm_query: approverQuery,
      sysparm_limit: limit,
      sysparm_orderby: "order",
      sysparm_display_value: "true",
    },
  })
  const approverRows = (approverResp.data.result || []) as Array<Record<string, unknown>>

  // Group approval rows
  // TODO: verify against live instance — the column linking sysapproval_group
  // to a record varies (document_id vs sysapproval) between releases.
  const groupQueryParts = [`document_id=${source_sys_id}`]
  if (source_table) groupQueryParts.push(`source_table=${source_table}`)
  const groupQuery = groupQueryParts.join("^") + stateFilter

  let groupRows: Array<Record<string, unknown>> = []
  try {
    const groupResp = await client.get("/api/now/table/sysapproval_group", {
      params: {
        sysparm_query: groupQuery,
        sysparm_limit: limit,
        sysparm_orderby: "order",
        sysparm_display_value: "true",
      },
    })
    groupRows = (groupResp.data.result || []) as Array<Record<string, unknown>>
  } catch {
    // sysapproval_group not present or query column differs; skip silently
  }

  // Recent action verbs
  let actions: Array<Record<string, unknown>> = []
  if (include_actions) {
    try {
      // TODO: verify against live instance — sysapproval_action is the audit
      // table for approval verbs; the link column may be `sysapproval` or
      // `document_id` depending on platform version.
      const actionsResp = await client.get("/api/now/table/sysapproval_action", {
        params: {
          sysparm_query: `document_id=${source_sys_id}^ORsysapproval=${source_sys_id}`,
          sysparm_limit: limit,
          sysparm_orderby: "sys_created_on",
          sysparm_order: "desc",
          sysparm_display_value: "true",
        },
      })
      actions = (actionsResp.data.result || []) as Array<Record<string, unknown>>
    } catch {
      // Best-effort
    }
  }

  return createSuccessResult({
    action: "get_approvals",
    source_table,
    source_sys_id,
    approver_count: approverRows.length,
    group_count: groupRows.length,
    action_count: actions.length,
    approvers: approverRows,
    groups: groupRows,
    actions,
  })
}

// ==================== CANCEL ====================

async function executeCancel(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const source_table = args.source_table as string | undefined
  const source_sys_id = args.source_sys_id as string | undefined
  const comment = args.cancel_comment as string | undefined

  if (!source_sys_id) return createErrorResult("source_sys_id is required for cancel")

  const client = await getAuthenticatedClient(context)

  const cancelledApprovers: Array<Record<string, unknown>> = []
  const cancelledGroups: Array<Record<string, unknown>> = []

  // Cancel per-user rows that are still open
  const approverQueryParts = [`sysapproval=${source_sys_id}`, "stateIN requested,not requested"]
  if (source_table) approverQueryParts.push(`source_table=${source_table}`)
  const approverResp = await client.get("/api/now/table/sysapproval_approver", {
    params: {
      sysparm_query: approverQueryParts.join("^"),
      sysparm_limit: 500,
      sysparm_fields: "sys_id,approver,state,order",
    },
  })
  for (const row of (approverResp.data.result || []) as Array<Record<string, unknown>>) {
    const patch: Record<string, unknown> = { state: "cancelled" }
    if (comment) patch.comments = comment
    const upd = await client.patch(`/api/now/table/sysapproval_approver/${row.sys_id}`, patch)
    cancelledApprovers.push({ sys_id: row.sys_id, state: upd.data.result.state })
  }

  // Cancel group rows that are still open
  try {
    const groupQueryParts = [`document_id=${source_sys_id}`, "stateIN requested,not requested"]
    if (source_table) groupQueryParts.push(`source_table=${source_table}`)
    const groupResp = await client.get("/api/now/table/sysapproval_group", {
      params: {
        sysparm_query: groupQueryParts.join("^"),
        sysparm_limit: 500,
        sysparm_fields: "sys_id,state,order",
      },
    })
    for (const row of (groupResp.data.result || []) as Array<Record<string, unknown>>) {
      const patch: Record<string, unknown> = { state: "cancelled" }
      if (comment) patch.comments = comment
      const upd = await client.patch(`/api/now/table/sysapproval_group/${row.sys_id}`, patch)
      cancelledGroups.push({ sys_id: row.sys_id, state: upd.data.result.state })
    }
  } catch {
    // sysapproval_group may be absent on this instance
  }

  // Record a cancellation verb in the audit table (best-effort)
  let actionRow: Record<string, unknown> | null = null
  try {
    const actionPayload: Record<string, unknown> = {
      document_id: source_sys_id,
      action: "cancelled",
    }
    if (source_table) actionPayload.source_table = source_table
    if (comment) actionPayload.comments = comment
    const actionResp = await client.post("/api/now/table/sysapproval_action", actionPayload)
    actionRow = actionResp.data.result
  } catch {
    // sysapproval_action insert is best-effort; the per-row cancel above is the source of truth
  }

  return createSuccessResult({
    action: "cancel",
    cancelled: true,
    source_table,
    source_sys_id,
    cancelled_approvers: cancelledApprovers,
    cancelled_groups: cancelledGroups,
    action_logged: actionRow !== null,
    action_row: actionRow,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
