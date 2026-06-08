/**
 * snow_change_manage - Unified Change Management Operations
 *
 * Change management operations: create, update_state, approve, create_task, schedule_cab.
 *
 * Replaces: snow_create_change, snow_update_change_state, snow_approve_change,
 *           snow_create_change_task, snow_schedule_cab_meeting
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_change_manage",
  description: "Unified change management (create, update_state, approve, create_task, schedule_cab)",
  category: "itsm",
  subcategory: "change",
  use_cases: ["change-management", "itsm", "workflow"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Management operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Change management action",
        enum: ["create", "update_state", "approve", "create_task", "schedule_cab"],
      },
      // CREATE parameters
      short_description: { type: "string", description: "[create/create_task] Short description" },
      description: { type: "string", description: "[create/create_task] Full description" },
      type: { type: "string", description: "[create] Change type", enum: ["standard", "normal", "emergency"] },
      risk: { type: "string", description: "[create] Risk level", enum: ["high", "medium", "low"] },
      impact: { type: "number", description: "[create] Impact", enum: [1, 2, 3] },
      // UPDATE_STATE/APPROVE parameters
      sys_id: {
        type: "string",
        description: "[update_state/approve/create_task/schedule_cab] Change sys_id or number",
      },
      state: {
        type: "string",
        description: "[update_state] New state",
        enum: ["draft", "assess", "authorize", "scheduled", "implement", "review", "closed", "cancelled"],
      },
      close_notes: { type: "string", description: "[update_state] Closure notes" },
      close_code: { type: "string", description: "[update_state] Closure code" },
      // APPROVE parameters
      approval: { type: "string", description: "[approve] Approval decision", enum: ["approved", "rejected"] },
      comments: { type: "string", description: "[approve] Approval comments" },
      // CREATE_TASK parameters
      assigned_to: { type: "string", description: "[create_task] Assignee sys_id" },
      due_date: { type: "string", description: "[create_task] Due date" },
      // SCHEDULE_CAB parameters
      cab_date: { type: "string", description: "[schedule_cab] CAB meeting date" },
      cab_agenda: { type: "string", description: "[schedule_cab] CAB agenda" },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args
  try {
    switch (action) {
      case "create":
        return await executeCreate(args, context)
      case "update_state":
        return await executeUpdateState(args, context)
      case "approve":
        return await executeApprove(args, context)
      case "create_task":
        return await executeCreateTask(args, context)
      case "schedule_cab":
        return await executeScheduleCAB(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

async function executeCreate(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { short_description, description, type, risk, impact } = args
  if (!short_description) return createErrorResult("short_description required")
  if (!type) return createErrorResult("type required")

  const client = await getAuthenticatedClient(context)
  const changeData: any = { short_description, type }
  if (description) changeData.description = description
  if (risk) changeData.risk = risk
  if (impact) changeData.impact = impact

  const response = await client.post("/api/now/table/change_request", changeData)
  return createSuccessResult({ action: "create", created: true, change: response.data.result })
}

async function executeUpdateState(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, state, close_notes, close_code } = args
  if (!sys_id) return createErrorResult("sys_id required")
  if (!state) return createErrorResult("state required")

  const client = await getAuthenticatedClient(context)
  const stateMap: Record<string, string> = {
    draft: "-5",
    assess: "-4",
    authorize: "-3",
    scheduled: "-2",
    implement: "-1",
    review: "0",
    closed: "3",
    cancelled: "4",
  }

  const updateData: any = { state: stateMap[state] || state }
  if (close_notes) updateData.close_notes = close_notes
  if (close_code) updateData.close_code = close_code

  const changeQuery = sys_id.match(/^[a-f0-9]{32}$/) ? "sys_id=" + sys_id : "number=" + sys_id
  const changeResponse = await client.get("/api/now/table/change_request?sysparm_query=" + changeQuery)
  if (!changeResponse.data?.result?.[0]) return createErrorResult("Change not found")

  const changeSysId = changeResponse.data.result[0].sys_id
  const response = await client.patch("/api/now/table/change_request/" + changeSysId, updateData)
  return createSuccessResult({ action: "update_state", updated: true, change: response.data.result })
}

async function executeApprove(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, approval, comments } = args
  if (!sys_id) return createErrorResult("sys_id required")
  if (!approval) return createErrorResult("approval required")

  const client = await getAuthenticatedClient(context)
  const changeQuery = sys_id.match(/^[a-f0-9]{32}$/) ? "sys_id=" + sys_id : "number=" + sys_id
  const changeResponse = await client.get("/api/now/table/change_request?sysparm_query=" + changeQuery)
  if (!changeResponse.data?.result?.[0]) return createErrorResult("Change not found")

  const changeSysId = changeResponse.data.result[0].sys_id
  const approvalData: any = {
    document_id: changeSysId,
    state: approval === "approved" ? "approved" : "rejected",
    comments: comments || "",
  }

  const response = await client.post("/api/now/table/sysapproval_approver", approvalData)
  return createSuccessResult({ action: "approve", approved: true, approval: response.data.result })
}

async function executeCreateTask(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, short_description, description, assigned_to, due_date } = args
  if (!sys_id) return createErrorResult("sys_id required")
  if (!short_description) return createErrorResult("short_description required")

  const client = await getAuthenticatedClient(context)
  const taskData: any = { change_request: sys_id, short_description }
  if (description) taskData.description = description
  if (assigned_to) taskData.assigned_to = assigned_to
  if (due_date) taskData.due_date = due_date

  const response = await client.post("/api/now/table/change_task", taskData)
  return createSuccessResult({ action: "create_task", created: true, task: response.data.result })
}

async function executeScheduleCAB(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, cab_date, cab_agenda } = args
  if (!sys_id) return createErrorResult("sys_id required")
  if (!cab_date) return createErrorResult("cab_date required")

  const client = await getAuthenticatedClient(context)
  const updateData: any = { cab_date }
  if (cab_agenda) updateData.cab_agenda = cab_agenda

  const changeQuery = sys_id.match(/^[a-f0-9]{32}$/) ? "sys_id=" + sys_id : "number=" + sys_id
  const changeResponse = await client.get("/api/now/table/change_request?sysparm_query=" + changeQuery)
  if (!changeResponse.data?.result?.[0]) return createErrorResult("Change not found")

  const changeSysId = changeResponse.data.result[0].sys_id
  const response = await client.patch("/api/now/table/change_request/" + changeSysId, updateData)
  return createSuccessResult({ action: "schedule_cab", scheduled: true, change: response.data.result })
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging - Phase 2"
