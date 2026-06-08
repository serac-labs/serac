/**
 * snow_fsm_parts_manage - Unified Field Service Management parts
 * requirement tool.
 *
 * Wraps the sm_part_requirement table that the Service Management /
 * Field Service Management plugin (com.snc.work_management) installs.
 * A part requirement says "this work order needs N of this model" and
 * tracks how much has been reserved, sourced and delivered.
 *
 * Notes:
 * - Modern ServiceNow does NOT model parts as a single pc_part catalog;
 *   the "part" is a `cmdb_model` reference (the model the technician
 *   needs to swap in). Stockroom availability lives elsewhere
 *   (alm_stockroom + alm_asset) and is intentionally out of scope here
 *   — this tool only manages the requirement record.
 * - `affected_product` on sm_part_requirement is a reference to the
 *   wm_m2m_product_to_work_order link table, not directly to a work
 *   order. To list requirements for a wm_order we resolve the link
 *   rows first.
 *
 * Field list verified against sys_dictionary on a live instance with
 * com.snc.work_management active.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

const PART_REQUIREMENT_TABLE = "sm_part_requirement"
const PRODUCT_LINK_TABLE = "wm_m2m_product_to_work_order"
const WORK_ORDER_TABLE = "wm_order"
const FSM_PLUGIN = "com.snc.work_management"

const DEFAULT_FIELDS =
  "sys_id,number,model,requested_quantity,reserved_quantity,required_quantity,requested_for,affected_product,service_order_task,required_by_date,requested,sourced,delivered,include_substitute,mandatory,creation_method,sys_updated_on"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_fsm_parts_manage",
  description: `Unified tool for ServiceNow Field Service Management part requirements. Wraps the sm_part_requirement table installed by the Field Service Management plugin (com.snc.work_management). A part requirement records "this work order needs N of this cmdb_model" and tracks reserved, sourced and delivered quantities.

Companion tool: snow_fsm_work_order_manage handles the wm_order lifecycle.

Actions:
- list_requirements - list sm_part_requirement rows, filtered by work order, requested_for, model, or status flags (requested/sourced/delivered/reserved-only)
- get - retrieve a single requirement by sys_id (or by number)
- create - create a new requirement (model + required_quantity + requested_for required; optional required_by_date, mandatory, include_substitute, requested_quantity)
- update_quantity - update requested_quantity, reserved_quantity, or required_quantity on an existing requirement
- update_status - flip the requested / sourced / delivered booleans on an existing requirement
- delete - delete a requirement by sys_id

Use when: the agent needs to plan parts for a work order, attach a required model to a work order, mark parts as reserved/sourced/delivered, or audit outstanding part requirements. Stockroom-level availability (alm_stockroom / alm_asset) is intentionally out of scope and is not modelled by sm_part_requirement.

Returns: requirement records with sys_id, number, model (cmdb_model reference), required_quantity, requested_quantity, reserved_quantity, requested_for, affected_product (wm_m2m_product_to_work_order reference), service_order_task, required_by_date, status booleans (requested, sourced, delivered, mandatory, include_substitute), and a navigation URL.`,
  category: "itsm",
  subcategory: "field-service",
  use_cases: ["field-service", "parts", "inventory", "work-order", "fsm"],
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
        enum: ["list_requirements", "get", "create", "update_quantity", "update_status", "delete"],
      },
      // Identifiers
      sys_id: {
        type: "string",
        description: "[get/update_quantity/update_status/delete] sm_part_requirement sys_id",
      },
      number: {
        type: "string",
        description: "[get] sm_part_requirement number (used when sys_id is absent)",
      },
      // Filters for list_requirements
      work_order_sys_id: {
        type: "string",
        description: "[list_requirements] sys_id of a wm_order to filter requirements by (resolved through the wm_m2m_product_to_work_order link)",
      },
      work_order_number: {
        type: "string",
        description: "[list_requirements] number of a wm_order to filter by (used when work_order_sys_id is absent)",
      },
      requested_for: {
        type: "string",
        description: "[list_requirements/create] sys_user sys_id of the technician the parts are requested for",
      },
      model_filter: {
        type: "string",
        description: "[list_requirements] cmdb_model sys_id to filter by",
      },
      service_order_task: {
        type: "string",
        description: "[list_requirements/create] sm_task sys_id this requirement belongs to",
      },
      reserved_only: {
        type: "boolean",
        description: "[list_requirements] Only return requirements that have a reserved_quantity > 0",
        default: false,
      },
      requested_only: {
        type: "boolean",
        description: "[list_requirements] Only return requirements where requested=true",
        default: false,
      },
      sourced_only: {
        type: "boolean",
        description: "[list_requirements] Only return requirements where sourced=true",
        default: false,
      },
      delivered_only: {
        type: "boolean",
        description: "[list_requirements] Only return requirements where delivered=true",
        default: false,
      },
      // CREATE fields
      model: {
        type: "string",
        description: "[create] cmdb_model sys_id of the part model required (mandatory)",
      },
      required_quantity: {
        type: "number",
        description: "[create/update_quantity] How many of the model are required for the work (mandatory on create)",
      },
      requested_quantity: {
        type: "number",
        description: "[create/update_quantity] How many have been requested from stock (defaults to required_quantity on create when omitted)",
      },
      reserved_quantity: {
        type: "number",
        description: "[update_quantity] How many have been reserved in a stockroom for this requirement",
      },
      required_by_date: {
        type: "string",
        description: "[create] Date by which the part is required (YYYY-MM-DD HH:MM:SS in instance TZ)",
      },
      mandatory: {
        type: "boolean",
        description: "[create] Mark requirement as mandatory (cannot be substituted)",
      },
      include_substitute: {
        type: "boolean",
        description: "[create] Allow substitute models to satisfy the requirement",
      },
      affected_product: {
        type: "string",
        description: "[create] wm_m2m_product_to_work_order sys_id linking this requirement to a product on a work order",
      },
      // STATUS booleans for update_status
      requested: {
        type: "boolean",
        description: "[update_status] Mark requirement as requested (or clear by passing false)",
      },
      sourced: {
        type: "boolean",
        description: "[update_status] Mark requirement as sourced",
      },
      delivered: {
        type: "boolean",
        description: "[update_status] Mark requirement as delivered",
      },
      // List shaping
      limit: {
        type: "number",
        description: "[list_requirements] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list_requirements/get] Comma-separated list of fields to return (defaults to a curated set)",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list_requirements":
        return await executeListRequirements(args, context)
      case "get":
        return await executeGet(args, context)
      case "create":
        return await executeCreate(args, context)
      case "update_quantity":
        return await executeUpdateQuantity(args, context)
      case "update_status":
        return await executeUpdateStatus(args, context)
      case "delete":
        return await executeDelete(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list_requirements, get, create, update_quantity, update_status, delete`,
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
      `Field Service Management part requirement table (${PART_REQUIREMENT_TABLE}) is not available on this instance. Activate the Field Service Management plugin (${FSM_PLUGIN}) and retry.`,
      { details: { plugin: FSM_PLUGIN, table: PART_REQUIREMENT_TABLE, originalMessage: msg } },
    )
  }
  if (err instanceof SnowFlowError) return err
  return new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `FSM parts ${action} failed: ${msg}`, {
    originalError: err,
  })
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

async function resolveProductLinkSysIdsForWorkOrder(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  workOrderSysId: string,
): Promise<string[]> {
  const response = await client.get(`/api/now/table/${PRODUCT_LINK_TABLE}`, {
    params: {
      sysparm_query: `wm_order=${workOrderSysId}`,
      sysparm_fields: "sys_id",
      sysparm_limit: 500,
    },
  })
  const rows = (response.data.result || []) as Array<Record<string, unknown>>
  return rows
    .map((r) => (typeof r.sys_id === "string" ? r.sys_id : ""))
    .filter((s) => s.length > 0)
}

function projectRequirement(r: Record<string, unknown>, instanceUrl: string): Record<string, unknown> {
  return {
    sys_id: r.sys_id,
    number: r.number,
    model: r.model,
    required_quantity: r.required_quantity,
    requested_quantity: r.requested_quantity,
    reserved_quantity: r.reserved_quantity,
    requested_for: r.requested_for,
    affected_product: r.affected_product,
    service_order_task: r.service_order_task,
    required_by_date: r.required_by_date,
    requested: r.requested,
    sourced: r.sourced,
    delivered: r.delivered,
    mandatory: r.mandatory,
    include_substitute: r.include_substitute,
    creation_method: r.creation_method,
    updated_at: r.sys_updated_on,
    url: `${instanceUrl}/nav_to.do?uri=${PART_REQUIREMENT_TABLE}.do?sys_id=${r.sys_id}`,
  }
}

// ==================== LIST_REQUIREMENTS ====================

async function executeListRequirements(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const work_order_sys_id = args.work_order_sys_id as string | undefined
  const work_order_number = args.work_order_number as string | undefined
  const requested_for = args.requested_for as string | undefined
  const model_filter = args.model_filter as string | undefined
  const service_order_task = args.service_order_task as string | undefined
  const reserved_only = args.reserved_only === true
  const requested_only = args.requested_only === true
  const sourced_only = args.sourced_only === true
  const delivered_only = args.delivered_only === true
  const limit = (args.limit as number) || 50
  const fields = (args.fields as string) || DEFAULT_FIELDS

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []

  // If a work order is supplied, scope through the product-link table.
  if (work_order_sys_id || work_order_number) {
    const workOrderSysId = await resolveWorkOrderSysId(client, work_order_sys_id, work_order_number)
    if (!workOrderSysId) {
      return createErrorResult(`Work order not found: ${work_order_sys_id || work_order_number}`)
    }
    const linkSysIds = await resolveProductLinkSysIdsForWorkOrder(client, workOrderSysId)
    if (linkSysIds.length === 0) {
      return createSuccessResult({
        action: "list_requirements",
        work_order_sys_id: workOrderSysId,
        count: 0,
        requirements: [],
        note: `No ${PRODUCT_LINK_TABLE} rows reference this work order — there are no parts attached yet.`,
      })
    }
    queryParts.push(`affected_productIN${linkSysIds.join(",")}`)
  }

  if (requested_for) queryParts.push(`requested_for=${requested_for}`)
  if (model_filter) queryParts.push(`model=${model_filter}`)
  if (service_order_task) queryParts.push(`service_order_task=${service_order_task}`)
  if (reserved_only) queryParts.push("reserved_quantity>0")
  if (requested_only) queryParts.push("requested=true")
  if (sourced_only) queryParts.push("sourced=true")
  if (delivered_only) queryParts.push("delivered=true")

  const response = await client.get(`/api/now/table/${PART_REQUIREMENT_TABLE}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "sys_created_on",
      sysparm_fields: fields,
    },
  })

  const requirements = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_requirements",
    count: requirements.length,
    requirements: requirements.map((r) => projectRequirement(r, context.instanceUrl)),
  })
}

// ==================== GET ====================

async function executeGet(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const number = args.number as string | undefined
  const fields = (args.fields as string) || DEFAULT_FIELDS

  if (!sys_id && !number) {
    return createErrorResult("sys_id or number is required for get action")
  }

  const client = await getAuthenticatedClient(context)

  if (sys_id) {
    const response = await client.get(`/api/now/table/${PART_REQUIREMENT_TABLE}/${sys_id}`, {
      params: { sysparm_fields: fields },
    })
    const row = response.data.result as Record<string, unknown> | undefined
    if (!row || !row.sys_id) {
      return createErrorResult(`Part requirement not found: ${sys_id}`)
    }
    return createSuccessResult({
      action: "get",
      requirement: projectRequirement(row, context.instanceUrl),
    })
  }

  const search = await client.get(`/api/now/table/${PART_REQUIREMENT_TABLE}`, {
    params: { sysparm_query: `number=${number}`, sysparm_fields: fields, sysparm_limit: 1 },
  })
  const rows = (search.data.result || []) as Array<Record<string, unknown>>
  if (rows.length === 0) {
    return createErrorResult(`Part requirement not found: ${number}`)
  }
  return createSuccessResult({
    action: "get",
    requirement: projectRequirement(rows[0], context.instanceUrl),
  })
}

// ==================== CREATE ====================

async function executeCreate(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const model = args.model as string | undefined
  const required_quantity = args.required_quantity as number | undefined
  const requested_for = args.requested_for as string | undefined
  const requested_quantity = args.requested_quantity as number | undefined
  const required_by_date = args.required_by_date as string | undefined
  const mandatory = args.mandatory as boolean | undefined
  const include_substitute = args.include_substitute as boolean | undefined
  const affected_product = args.affected_product as string | undefined
  const service_order_task = args.service_order_task as string | undefined

  if (!model) return createErrorResult("model (cmdb_model sys_id) is required for create action")
  if (required_quantity === undefined || required_quantity === null) {
    return createErrorResult("required_quantity is required for create action")
  }
  if (!requested_for) {
    return createErrorResult("requested_for (sys_user sys_id) is required for create action")
  }

  const client = await getAuthenticatedClient(context)

  const payload: Record<string, unknown> = {
    model,
    required_quantity,
    requested_for,
    requested_quantity: requested_quantity ?? required_quantity,
  }
  if (required_by_date) payload.required_by_date = required_by_date
  if (mandatory !== undefined) payload.mandatory = mandatory
  if (include_substitute !== undefined) payload.include_substitute = include_substitute
  if (affected_product) payload.affected_product = affected_product
  if (service_order_task) payload.service_order_task = service_order_task

  const response = await client.post(`/api/now/table/${PART_REQUIREMENT_TABLE}`, payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "create",
    created: true,
    sys_id: created.sys_id,
    number: created.number,
    requirement: projectRequirement(created, context.instanceUrl),
  })
}

// ==================== UPDATE_QUANTITY ====================

async function executeUpdateQuantity(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const required_quantity = args.required_quantity as number | undefined
  const requested_quantity = args.requested_quantity as number | undefined
  const reserved_quantity = args.reserved_quantity as number | undefined

  if (!sys_id) return createErrorResult("sys_id is required for update_quantity action")
  if (
    required_quantity === undefined &&
    requested_quantity === undefined &&
    reserved_quantity === undefined
  ) {
    return createErrorResult(
      "Provide at least one of required_quantity, requested_quantity, or reserved_quantity for update_quantity action",
    )
  }

  const client = await getAuthenticatedClient(context)

  const patch: Record<string, unknown> = {}
  if (required_quantity !== undefined) patch.required_quantity = required_quantity
  if (requested_quantity !== undefined) patch.requested_quantity = requested_quantity
  if (reserved_quantity !== undefined) patch.reserved_quantity = reserved_quantity

  const response = await client.patch(`/api/now/table/${PART_REQUIREMENT_TABLE}/${sys_id}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "update_quantity",
    updated: true,
    sys_id,
    requirement: projectRequirement(updated, context.instanceUrl),
  })
}

// ==================== UPDATE_STATUS ====================

async function executeUpdateStatus(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const requested = args.requested as boolean | undefined
  const sourced = args.sourced as boolean | undefined
  const delivered = args.delivered as boolean | undefined

  if (!sys_id) return createErrorResult("sys_id is required for update_status action")
  if (requested === undefined && sourced === undefined && delivered === undefined) {
    return createErrorResult(
      "Provide at least one of requested, sourced, or delivered (boolean) for update_status action",
    )
  }

  const client = await getAuthenticatedClient(context)

  const patch: Record<string, unknown> = {}
  if (requested !== undefined) patch.requested = requested
  if (sourced !== undefined) patch.sourced = sourced
  if (delivered !== undefined) patch.delivered = delivered

  const response = await client.patch(`/api/now/table/${PART_REQUIREMENT_TABLE}/${sys_id}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "update_status",
    updated: true,
    sys_id,
    requirement: projectRequirement(updated, context.instanceUrl),
  })
}

// ==================== DELETE ====================

async function executeDelete(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  if (!sys_id) return createErrorResult("sys_id is required for delete action")

  const client = await getAuthenticatedClient(context)
  await client.delete(`/api/now/table/${PART_REQUIREMENT_TABLE}/${sys_id}`)

  return createSuccessResult({
    action: "delete",
    deleted: true,
    sys_id,
  })
}

export const version = "1.1.0"
export const author = "groeimetai"
