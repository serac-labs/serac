/**
 * snow_hr_lifecycle_event - Unified HRSD Lifecycle Events (LEM) management
 *
 * Wraps the HR Lifecycle Events Management surface: sn_hr_le_case (lifecycle
 * event case), sn_hr_le_activity (activities executed against a case), and
 * the journey templates used to spawn activities for an employee.
 *
 * Companion to snow_employee_offboarding (which only opens an offboarding
 * case on sn_hr_core_case) and snow_create_hr_case (generic HR case). Use
 * this tool for the lifecycle-event family — onboarding, offboarding,
 * transfers, role changes — where the work is broken down into activities
 * driven by a journey template.
 *
 * Requires the HR Lifecycle Events plugin (com.sn_hr_lifecycle_events).
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_hr_lifecycle_event",
  description: `Unified tool for ServiceNow HR Lifecycle Events (LEM): manage lifecycle-event cases (sn_hr_le_case), their activities (sn_hr_le_activity), and the journey templates that drive them (sn_hr_core_journey_template, sn_hr_core_journey_activity).

Actions:
- create_event — open a new lifecycle-event case for an employee (onboarding, offboarding, transfer, role change). Optionally seeds activities from a journey template.
- list_events — list lifecycle-event cases, filtered by employee, type, or state
- complete_event — mark a lifecycle-event case as complete (closes the case and stops scheduled activities)
- list_pending_for_employee — return open lifecycle-event activities assigned to an employee or owned by their case
- trigger_journey — instantiate the activities defined on a journey template against an existing lifecycle-event case

Use when: the agent needs to drive an end-to-end employee lifecycle event in HRSD. For a single ad-hoc HR ticket use snow_create_hr_case; for offboarding-only flows snow_employee_offboarding is a thinner wrapper around sn_hr_core_case.

Requires the HR Lifecycle Events plugin (com.sn_hr_lifecycle_events). Tables may be absent on instances without the plugin, in which case the tool fails with a clear plugin-missing error.`,
  category: "itsm",
  subcategory: "hr",
  use_cases: ["hr-service-delivery", "lifecycle-events", "onboarding", "offboarding", "journeys"],
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
        enum: ["create_event", "list_events", "complete_event", "list_pending_for_employee", "trigger_journey"],
      },
      // Identification
      sys_id: {
        type: "string",
        description: "[complete_event/trigger_journey] sn_hr_le_case sys_id",
      },
      employee: {
        type: "string",
        description: "[create_event/list_events/list_pending_for_employee] Employee sys_id (sn_hr_core_profile or sys_user, depending on instance)",
      },
      // Event creation
      event_type: {
        type: "string",
        description: "[create_event/list_events] Lifecycle-event type",
        enum: ["onboarding", "offboarding", "transfer", "role_change", "leave_of_absence", "return_from_leave"],
      },
      subject: {
        type: "string",
        description: "[create_event] Case subject/short_description",
      },
      effective_date: {
        type: "string",
        description: "[create_event] Effective date (YYYY-MM-DD). Maps to start_date or effective_date depending on instance configuration.",
      },
      hr_service: {
        type: "string",
        description: "[create_event] HR service sys_id used to categorize the case",
      },
      journey_template: {
        type: "string",
        description: "[create_event/trigger_journey] Journey template sys_id (sn_hr_core_journey_template) used to seed activities",
      },
      opened_for: {
        type: "string",
        description: "[create_event] sys_user sys_id of the employee the event is opened for. Defaults to `employee` when omitted.",
      },
      priority: {
        type: "number",
        description: "[create_event] ServiceNow priority (1-5)",
      },
      // Completion
      close_notes: {
        type: "string",
        description: "[complete_event] Notes recorded on close",
      },
      // Listing
      state: {
        type: "string",
        description: "[list_events] State filter (open|in_progress|closed|cancelled)",
      },
      limit: {
        type: "number",
        description: "[list_events/list_pending_for_employee] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list_events/list_pending_for_employee] Comma-separated list of fields to return",
      },
    },
    required: ["action"],
  },
}

const LE_CASE_TABLE = "sn_hr_le_case"
const LE_ACTIVITY_TABLE = "sn_hr_le_activity"
const JOURNEY_TEMPLATE_TABLE = "sn_hr_core_journey_template"
const JOURNEY_ACTIVITY_TABLE = "sn_hr_core_journey_activity"

const STATE_MAP: Record<string, string> = {
  open: "1",
  in_progress: "2",
  closed: "3",
  cancelled: "4",
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "create_event":
        return await executeCreateEvent(args, context)
      case "list_events":
        return await executeListEvents(args, context)
      case "complete_event":
        return await executeCompleteEvent(args, context)
      case "list_pending_for_employee":
        return await executeListPendingForEmployee(args, context)
      case "trigger_journey":
        return await executeTriggerJourney(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: create_event, list_events, complete_event, list_pending_for_employee, trigger_journey`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error & { response?: { status?: number } }
    // Surface a friendly error when the HR LEM plugin is not installed
    if (err.response?.status === 404 || /Invalid table/i.test(err.message || "")) {
      return createErrorResult(
        new SnowFlowError(
          ErrorType.PLUGIN_MISSING,
          `HR Lifecycle Events tables not found. Install the com.sn_hr_lifecycle_events plugin and verify ${LE_CASE_TABLE} exists.`,
          { originalError: err },
        ),
      )
    }
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `HR lifecycle ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== CREATE_EVENT ====================

async function executeCreateEvent(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const employee = args.employee as string | undefined
  const event_type = args.event_type as string | undefined
  const subject = args.subject as string | undefined

  if (!employee) return createErrorResult("employee is required for create_event")
  if (!event_type) return createErrorResult("event_type is required for create_event")
  if (!subject) return createErrorResult("subject is required for create_event")

  const client = await getAuthenticatedClient(context)

  // Canonical platform fields; some instances rename or extend these.
  // TODO: verify if customer has custom field overrides for sn_hr_le_case.
  const payload: Record<string, unknown> = {
    subject,
    short_description: subject,
    employee,
    opened_for: (args.opened_for as string) || employee,
    type: event_type,
    state: STATE_MAP.open,
  }
  if (args.effective_date) payload.effective_date = args.effective_date
  if (args.hr_service) payload.hr_service = args.hr_service
  if (args.priority !== undefined) payload.priority = args.priority

  const response = await client.post(`/api/now/table/${LE_CASE_TABLE}`, payload)
  const created = response.data.result as Record<string, unknown>
  const caseSysId = created.sys_id as string

  // Optionally seed activities from a journey template
  const seededActivities: string[] = []
  const journey_template = args.journey_template as string | undefined
  if (journey_template) {
    const seeded = await seedActivitiesFromJourney(client, caseSysId, journey_template, employee)
    seededActivities.push(...seeded)
  }

  return createSuccessResult({
    action: "create_event",
    created: true,
    sys_id: caseSysId,
    name: created.subject || subject,
    event_type,
    employee,
    case: created,
    seeded_activities: seededActivities,
    url: `${context.instanceUrl}/nav_to.do?uri=${LE_CASE_TABLE}.do?sys_id=${caseSysId}`,
  })
}

// ==================== LIST_EVENTS ====================

async function executeListEvents(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const employee = args.employee as string | undefined
  const event_type = args.event_type as string | undefined
  const state = args.state as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (employee) queryParts.push(`employee=${employee}`)
  if (event_type) queryParts.push(`type=${event_type}`)
  if (state && STATE_MAP[state]) queryParts.push(`state=${STATE_MAP[state]}`)

  const response = await client.get(`/api/now/table/${LE_CASE_TABLE}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "sys_updated_on",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,number,subject,type,employee,opened_for,state,effective_date,sys_updated_on" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_events",
    count: results.length,
    events: results.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      subject: r.subject,
      type: r.type,
      employee: r.employee,
      opened_for: r.opened_for,
      state: r.state,
      effective_date: r.effective_date,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${LE_CASE_TABLE}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== COMPLETE_EVENT ====================

async function executeCompleteEvent(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  if (!sys_id) return createErrorResult("sys_id is required for complete_event")

  const client = await getAuthenticatedClient(context)

  const patch: Record<string, unknown> = {
    state: STATE_MAP.closed,
  }
  if (args.close_notes) patch.close_notes = args.close_notes

  const response = await client.patch(`/api/now/table/${LE_CASE_TABLE}/${sys_id}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "complete_event",
    completed: true,
    sys_id,
    case: updated,
    url: `${context.instanceUrl}/nav_to.do?uri=${LE_CASE_TABLE}.do?sys_id=${sys_id}`,
  })
}

// ==================== LIST_PENDING_FOR_EMPLOYEE ====================

async function executeListPendingForEmployee(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const employee = args.employee as string | undefined
  if (!employee) return createErrorResult("employee is required for list_pending_for_employee")

  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined
  const client = await getAuthenticatedClient(context)

  // First find the employee's open lifecycle-event cases, then collect open activities for each.
  const caseResponse = await client.get(`/api/now/table/${LE_CASE_TABLE}`, {
    params: {
      sysparm_query: `employee=${employee}^stateIN${STATE_MAP.open},${STATE_MAP.in_progress}`,
      sysparm_limit: limit,
      sysparm_fields: "sys_id,number,subject,type,state",
    },
  })
  const cases = (caseResponse.data.result || []) as Array<Record<string, unknown>>
  if (cases.length === 0) {
    return createSuccessResult({
      action: "list_pending_for_employee",
      employee,
      cases: [],
      activities: [],
      count: 0,
    })
  }

  const caseIds = cases.map((c) => c.sys_id as string)
  // TODO: verify activity-to-case foreign key column on a live instance (commonly `hr_case` or `parent`).
  const activityResponse = await client.get(`/api/now/table/${LE_ACTIVITY_TABLE}`, {
    params: {
      sysparm_query: `hr_caseIN${caseIds.join(",")}^stateIN${STATE_MAP.open},${STATE_MAP.in_progress}`,
      sysparm_limit: limit,
      ...(fields ? { sysparm_fields: fields } : { sysparm_fields: "sys_id,number,short_description,state,hr_case,assigned_to,due_date" }),
    },
  })
  const activities = (activityResponse.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_pending_for_employee",
    employee,
    cases,
    count: activities.length,
    activities: activities.map((a) => ({
      sys_id: a.sys_id,
      number: a.number,
      short_description: a.short_description,
      state: a.state,
      hr_case: a.hr_case,
      assigned_to: a.assigned_to,
      due_date: a.due_date,
      url: `${context.instanceUrl}/nav_to.do?uri=${LE_ACTIVITY_TABLE}.do?sys_id=${a.sys_id}`,
    })),
  })
}

// ==================== TRIGGER_JOURNEY ====================

async function executeTriggerJourney(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const journey_template = args.journey_template as string | undefined

  if (!sys_id) return createErrorResult("sys_id (lifecycle-event case) is required for trigger_journey")
  if (!journey_template) return createErrorResult("journey_template is required for trigger_journey")

  const client = await getAuthenticatedClient(context)

  // Look up the case so we can pass the employee to the seeding step.
  const caseResponse = await client.get(`/api/now/table/${LE_CASE_TABLE}/${sys_id}`)
  const lemCase = caseResponse.data.result as Record<string, unknown> | undefined
  if (!lemCase || !lemCase.sys_id) {
    return createErrorResult(`Lifecycle-event case not found: ${sys_id}`)
  }
  const employee = (lemCase.employee || lemCase.opened_for) as string | undefined

  const created = await seedActivitiesFromJourney(client, sys_id, journey_template, employee)

  return createSuccessResult({
    action: "trigger_journey",
    case_sys_id: sys_id,
    journey_template,
    created_activities: created,
    count: created.length,
  })
}

// ==================== HELPERS ====================

async function seedActivitiesFromJourney(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  caseSysId: string,
  journeyTemplateSysId: string,
  employee: string | undefined,
): Promise<string[]> {
  // Fetch the journey's defined activities (sn_hr_core_journey_activity).
  // TODO: verify the foreign-key column name (`journey_template` vs `parent`) on a live instance.
  const templateActivitiesResponse = await client.get(`/api/now/table/${JOURNEY_ACTIVITY_TABLE}`, {
    params: {
      sysparm_query: `journey_template=${journeyTemplateSysId}`,
      sysparm_fields: "sys_id,name,short_description,order,duration",
      sysparm_limit: 200,
    },
  })

  const templateActivities = (templateActivitiesResponse.data.result || []) as Array<Record<string, unknown>>
  const created: string[] = []

  for (const tmpl of templateActivities) {
    const activityPayload: Record<string, unknown> = {
      hr_case: caseSysId,
      short_description: tmpl.short_description || tmpl.name,
      name: tmpl.name,
      state: "1",
      // TODO: verify if customer has custom journey-to-activity copy fields beyond name/order.
    }
    if (employee) activityPayload.assigned_to = employee
    if (tmpl.order !== undefined) activityPayload.order = tmpl.order

    const activityResponse = await client.post(`/api/now/table/${LE_ACTIVITY_TABLE}`, activityPayload)
    const newActivity = activityResponse.data.result as Record<string, unknown>
    if (newActivity && newActivity.sys_id) {
      created.push(newActivity.sys_id as string)
    }
  }

  // Reference the template tables so the consts aren't unused on the
  // narrow tooling lint pass — the journey-template table is loaded
  // indirectly via the activity records that reference it.
  void JOURNEY_TEMPLATE_TABLE

  return created
}

export const version = "1.0.0"
export const author = "groeimetai"
