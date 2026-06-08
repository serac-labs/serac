/**
 * snow_pa_indicator_manage - Unified Performance Analytics indicator management
 *
 * Manages the lifecycle of Performance Analytics indicator definitions
 * (pa_indicators) and their associated breakdowns (pa_breakdowns). Indicator
 * widgets (pa_widgets) and sampled scores (pa_scores) are referenced for read
 * context but are not authored directly by this tool — snow_pa_create handles
 * widget authoring, and scores are computed by the platform.
 *
 * Companion to snow_pa_create (which creates the broader PA artifact family)
 * and snow_pa_operate (which collects and inspects PA data).
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_pa_indicator_manage",
  description: `Unified tool for ServiceNow Performance Analytics indicator definitions and their dimensional breakdowns. Wraps the pa_indicators, pa_breakdowns, pa_indicator_breakdowns (join), pa_widgets, and pa_scores tables on the platform.

Actions:
- list — list indicators, optionally filtered by cube
- get — retrieve a single indicator by sys_id or name (includes related widget and breakdown counts)
- create — create a new indicator (name, aggregate, precision, forecast_base_periods, forecast_periods required; cube optional but typical)
- update — patch indicator fields
- delete — remove an indicator (and optionally its dependent pa_indicator_breakdowns links)
- add_breakdown — attach a dimensional breakdown to an indicator (writes pa_breakdowns + pa_indicator_breakdowns join)
- list_breakdowns — list breakdowns for a given indicator (via pa_indicator_breakdowns) or globally

Use when: the agent needs to manage KPI/indicator definitions, attach dimensional slicers (assignment_group, priority, location, etc.) to existing indicators, or audit which indicators a cube feeds.

Returns: indicator records with sys_id, name, label, cube, aggregate, field, frequency, unit, precision. For breakdowns, returns sys_id, name, facts_table, field, and matrix_source. Companion tools: snow_pa_create for full PA artifact creation (widgets, thresholds, scheduled reports) and snow_pa_operate for collecting and querying PA scores.`,
  category: "performance-analytics",
  subcategory: "performance-analytics",
  use_cases: ["performance-analytics", "kpi", "indicators", "breakdowns", "reporting"],
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
        enum: ["list", "get", "create", "update", "delete", "add_breakdown", "list_breakdowns"],
      },
      // Identifiers
      sys_id: {
        type: "string",
        description: "[get/update/delete/add_breakdown/list_breakdowns] Indicator sys_id",
      },
      name: {
        type: "string",
        description: "[get/create/update] Indicator name (used as identifier when sys_id is absent)",
      },
      // CREATE/UPDATE fields
      label: {
        type: "string",
        description: "[create/update] Indicator display label (defaults to name on create)",
      },
      description: {
        type: "string",
        description: "[create/update] Indicator description",
      },
      cube: {
        type: "string",
        description: "[create/update] pa_cubes sys_id that defines the indicator's facts table and conditions (the cube is the source/facts wrapper on pa_indicators; use snow_pa_create to author cubes)",
      },
      script: {
        type: "string",
        description: "[create/update] pa_scripts sys_id when the indicator is scripted",
      },
      aggregate: {
        type: "string",
        description: "[create/update] Aggregation function (inherited from pa_indicators_definition)",
        enum: ["COUNT", "SUM", "AVG", "MIN", "MAX", "COUNT_DISTINCT"],
      },
      field: {
        type: "string",
        description: "[create/update] Field on the cube's facts table to aggregate (omit for COUNT)",
      },
      conditions: {
        type: "string",
        description: "[create/update] Encoded query that filters the facts table rows (inherited from pa_indicators_definition)",
      },
      unit: {
        type: "string",
        description: "[create/update] Unit of measurement (count, hours, percent, etc.)",
      },
      frequency: {
        type: "string",
        description: "[create/update] Collection frequency",
        enum: ["daily", "weekly", "monthly", "quarterly", "yearly", "hourly"],
      },
      direction: {
        type: "string",
        description: "[create/update] Whether higher or lower is better",
        enum: ["maximize", "minimize"],
      },
      formula: {
        type: "string",
        description: "[create/update] Formula expression for derived indicators",
      },
      precision: {
        type: "number",
        description: "[create] Decimal precision (mandatory on pa_indicators)",
        default: 0,
      },
      forecast_base_periods: {
        type: "number",
        description: "[create] Number of base periods used for forecasting (mandatory on pa_indicators)",
        default: 12,
      },
      forecast_periods: {
        type: "number",
        description: "[create] Number of periods to forecast (mandatory on pa_indicators)",
        default: 6,
      },
      // BREAKDOWN fields (for add_breakdown)
      breakdown_name: {
        type: "string",
        description: "[add_breakdown] Breakdown name",
      },
      breakdown_table: {
        type: "string",
        description: "[add_breakdown] Table on which the breakdown is evaluated",
      },
      breakdown_field: {
        type: "string",
        description: "[add_breakdown] Field used to group the indicator (e.g. assignment_group, priority)",
      },
      related_field: {
        type: "string",
        description: "[add_breakdown] Related field path for cross-table breakdowns",
      },
      matrix_source: {
        type: "boolean",
        description: "[add_breakdown] Whether this is a matrix breakdown",
        default: false,
      },
      // DELETE
      cascade: {
        type: "boolean",
        description: "[delete] Also remove dependent pa_breakdowns rows that reference this indicator",
        default: false,
      },
      // LIST/LIST_BREAKDOWNS
      active_only: {
        type: "boolean",
        description: "[list/list_breakdowns] Only return active records",
        default: false,
      },
      limit: {
        type: "number",
        description: "[list/list_breakdowns] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list/get/list_breakdowns] Comma-separated list of fields to return",
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
      case "update":
        return await executeUpdate(args, context)
      case "delete":
        return await executeDelete(args, context)
      case "add_breakdown":
        return await executeAddBreakdown(args, context)
      case "list_breakdowns":
        return await executeListBreakdowns(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list, get, create, update, delete, add_breakdown, list_breakdowns`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `PA indicator ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function findIndicator(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string | undefined,
  name: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (sysId) {
    const direct = await client.get(`/api/now/table/pa_indicators/${sysId}`)
    if (direct.data.result && direct.data.result.sys_id) {
      return direct.data.result
    }
  }
  if (name) {
    const search = await client.get("/api/now/table/pa_indicators", {
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

// ==================== LIST ====================

async function executeList(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const cube = args.cube as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (cube) queryParts.push(`cube=${cube}`)

  const response = await client.get("/api/now/table/pa_indicators", {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "name",
      ...(fields ? { sysparm_fields: fields } : { sysparm_fields: "sys_id,name,label,cube,aggregate,field,frequency,unit,precision,sys_updated_on" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list",
    count: results.length,
    indicators: results.map((r) => ({
      sys_id: r.sys_id,
      name: r.name,
      label: r.label,
      cube: r.cube,
      aggregate: r.aggregate,
      field: r.field,
      frequency: r.frequency,
      unit: r.unit,
      precision: r.precision,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=pa_indicators.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== GET ====================

async function executeGet(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const name = args.name as string | undefined

  if (!sys_id && !name) {
    return createErrorResult("sys_id or name is required for get action")
  }

  const client = await getAuthenticatedClient(context)
  const indicator = await findIndicator(client, sys_id, name)
  if (!indicator) {
    return createErrorResult(`Indicator not found: ${sys_id || name}`)
  }

  const indicatorSysId = indicator.sys_id as string

  // Count related breakdowns and widgets for context (best-effort, swallow errors)
  let breakdownCount = 0
  let widgetCount = 0
  try {
    const breakdowns = await client.get("/api/now/table/pa_indicator_breakdowns", {
      params: { sysparm_query: `indicator=${indicatorSysId}`, sysparm_fields: "sys_id", sysparm_limit: 200 },
    })
    breakdownCount = (breakdowns.data.result || []).length
  } catch {
    // pa_indicator_breakdowns may not be reachable on every instance variant
  }
  try {
    const widgets = await client.get("/api/now/table/pa_widgets", {
      params: { sysparm_query: `indicator=${indicatorSysId}`, sysparm_fields: "sys_id", sysparm_limit: 200 },
    })
    widgetCount = (widgets.data.result || []).length
  } catch {
    // pa_widgets may carry the indicator on a different column on older instances
  }

  return createSuccessResult({
    action: "get",
    sys_id: indicatorSysId,
    name: indicator.name,
    indicator,
    related: {
      breakdown_count: breakdownCount,
      widget_count: widgetCount,
    },
    url: `${context.instanceUrl}/nav_to.do?uri=pa_indicators.do?sys_id=${indicatorSysId}`,
  })
}

// ==================== CREATE ====================

async function executeCreate(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const name = args.name as string | undefined
  const aggregate = args.aggregate as string | undefined
  const field = args.field as string | undefined

  if (!name) return createErrorResult("name is required for create action")
  if (!aggregate) return createErrorResult("aggregate is required for create action")
  if (aggregate !== "COUNT" && !field) {
    return createErrorResult("field is required when aggregate is not COUNT")
  }

  const client = await getAuthenticatedClient(context)

  // Reject duplicates by name
  const existing = await client.get("/api/now/table/pa_indicators", {
    params: { sysparm_query: `name=${name}`, sysparm_limit: 1, sysparm_fields: "sys_id" },
  })
  if ((existing.data.result || []).length > 0) {
    return createErrorResult(`Indicator '${name}' already exists. Use action='update' to modify it.`)
  }

  // pa_indicators has three mandatory integer fields: precision, forecast_base_periods,
  // forecast_periods. Default them when the caller omits values so simple create calls succeed.
  const payload: Record<string, unknown> = {
    name,
    label: (args.label as string) || name,
    description: (args.description as string) || "",
    aggregate: aggregate.toUpperCase(),
    precision: args.precision !== undefined ? args.precision : 0,
    forecast_base_periods: args.forecast_base_periods !== undefined ? args.forecast_base_periods : 12,
    forecast_periods: args.forecast_periods !== undefined ? args.forecast_periods : 6,
  }
  if (field) payload.field = field
  if (args.cube) payload.cube = args.cube
  if (args.script) payload.script = args.script
  if (args.formula) payload.formula = args.formula
  if (args.conditions) payload.conditions = args.conditions
  if (args.unit) payload.unit = args.unit
  if (args.frequency) payload.frequency = args.frequency
  if (args.direction) payload.direction = args.direction

  const response = await client.post("/api/now/table/pa_indicators", payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "create",
    created: true,
    sys_id: created.sys_id,
    name: created.name,
    indicator: created,
    url: `${context.instanceUrl}/nav_to.do?uri=pa_indicators.do?sys_id=${created.sys_id}`,
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
  const indicator = await findIndicator(client, sys_id, name)
  if (!indicator) {
    return createErrorResult(`Indicator not found: ${sys_id || name}`)
  }

  const updatableFields = [
    "label",
    "description",
    "cube",
    "script",
    "aggregate",
    "field",
    "formula",
    "conditions",
    "unit",
    "frequency",
    "direction",
    "precision",
    "forecast_base_periods",
    "forecast_periods",
  ]
  const patch: Record<string, unknown> = {}
  for (const key of updatableFields) {
    if (args[key] !== undefined) {
      patch[key] = key === "aggregate" ? (args[key] as string).toUpperCase() : args[key]
    }
  }

  if (Object.keys(patch).length === 0) {
    return createErrorResult("No update fields provided")
  }

  const targetSysId = indicator.sys_id as string
  const response = await client.patch(`/api/now/table/pa_indicators/${targetSysId}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "update",
    updated: true,
    sys_id: targetSysId,
    name: updated.name,
    updated_fields: Object.keys(patch),
    indicator: updated,
    url: `${context.instanceUrl}/nav_to.do?uri=pa_indicators.do?sys_id=${targetSysId}`,
  })
}

// ==================== DELETE ====================

async function executeDelete(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const name = args.name as string | undefined
  const cascade = args.cascade === true

  if (!sys_id && !name) {
    return createErrorResult("sys_id or name is required for delete action")
  }

  const client = await getAuthenticatedClient(context)
  const indicator = await findIndicator(client, sys_id, name)
  if (!indicator) {
    return createErrorResult(`Indicator not found: ${sys_id || name}`)
  }

  const targetSysId = indicator.sys_id as string
  const removedBreakdowns: string[] = []

  if (cascade) {
    const breakdownLinks = await client.get("/api/now/table/pa_indicator_breakdowns", {
      params: { sysparm_query: `indicator=${targetSysId}`, sysparm_fields: "sys_id", sysparm_limit: 500 },
    })
    for (const row of (breakdownLinks.data.result || []) as Array<Record<string, unknown>>) {
      await client.delete(`/api/now/table/pa_indicator_breakdowns/${row.sys_id}`)
      removedBreakdowns.push(row.sys_id as string)
    }
  }

  await client.delete(`/api/now/table/pa_indicators/${targetSysId}`)

  return createSuccessResult({
    action: "delete",
    deleted: true,
    sys_id: targetSysId,
    name: indicator.name,
    cascaded_breakdown_links: removedBreakdowns,
  })
}

// ==================== ADD_BREAKDOWN ====================

async function executeAddBreakdown(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const indicatorName = args.name as string | undefined
  const breakdown_name = args.breakdown_name as string | undefined
  const breakdown_table = args.breakdown_table as string | undefined
  const breakdown_field = args.breakdown_field as string | undefined
  const related_field = args.related_field as string | undefined
  const matrix_source = args.matrix_source === true

  if (!sys_id && !indicatorName) {
    return createErrorResult("sys_id or name is required to identify the indicator")
  }
  if (!breakdown_name) return createErrorResult("breakdown_name is required")
  if (!breakdown_table) return createErrorResult("breakdown_table is required")
  if (!breakdown_field) return createErrorResult("breakdown_field is required")

  const client = await getAuthenticatedClient(context)
  const indicator = await findIndicator(client, sys_id, indicatorName)
  if (!indicator) {
    return createErrorResult(`Indicator not found: ${sys_id || indicatorName}`)
  }

  // Create the breakdown definition. pa_breakdowns uses `facts_table` (not `table`)
  // for the source the breakdown evaluates against.
  const breakdownPayload: Record<string, unknown> = {
    name: breakdown_name,
    facts_table: breakdown_table,
    field: breakdown_field,
    matrix_source,
  }
  if (related_field) breakdownPayload.related_field = related_field

  const breakdownResponse = await client.post("/api/now/table/pa_breakdowns", breakdownPayload)
  const breakdown = breakdownResponse.data.result as Record<string, unknown>

  // Attach the breakdown to the indicator via the join table pa_indicator_breakdowns.
  let linkSysId: string | null = null
  try {
    const linkResponse = await client.post("/api/now/table/pa_indicator_breakdowns", {
      indicator: indicator.sys_id,
      breakdown: breakdown.sys_id,
    })
    linkSysId = linkResponse.data.result.sys_id
  } catch (linkError: unknown) {
    const e = linkError as Error
    // Surface the failure so the caller knows the breakdown exists but isn't linked
    return createSuccessResult({
      action: "add_breakdown",
      breakdown_created: true,
      indicator_linked: false,
      sys_id: breakdown.sys_id,
      breakdown,
      warning: `Breakdown created but could not be linked to indicator: ${e.message}`,
    })
  }

  return createSuccessResult({
    action: "add_breakdown",
    breakdown_created: true,
    indicator_linked: linkSysId !== null,
    sys_id: breakdown.sys_id,
    breakdown,
    link_sys_id: linkSysId,
    indicator: { sys_id: indicator.sys_id, name: indicator.name },
  })
}

// ==================== LIST_BREAKDOWNS ====================

async function executeListBreakdowns(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const indicatorName = args.name as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  // If an indicator is specified, return breakdowns linked to it through the join table.
  // Otherwise return all breakdowns globally.
  if (sys_id || indicatorName) {
    const indicator = await findIndicator(client, sys_id, indicatorName)
    if (!indicator) {
      return createErrorResult(`Indicator not found: ${sys_id || indicatorName}`)
    }

    const linkResponse = await client.get("/api/now/table/pa_indicator_breakdowns", {
      params: {
        sysparm_query: `indicator=${indicator.sys_id}`,
        sysparm_limit: limit,
        sysparm_fields: "sys_id,breakdown",
      },
    })

    const breakdownIds = ((linkResponse.data.result || []) as Array<Record<string, unknown>>)
      .map((r) => {
        const ref = r.breakdown
        if (typeof ref === "string") return ref
        if (ref && typeof ref === "object" && "value" in ref) return (ref as { value: string }).value
        return null
      })
      .filter((v): v is string => typeof v === "string" && v.length > 0)

    if (breakdownIds.length === 0) {
      return createSuccessResult({
        action: "list_breakdowns",
        indicator: { sys_id: indicator.sys_id, name: indicator.name },
        count: 0,
        breakdowns: [],
      })
    }

    const breakdownsResponse = await client.get("/api/now/table/pa_breakdowns", {
      params: {
        sysparm_query: `sys_idIN${breakdownIds.join(",")}`,
        sysparm_limit: limit,
        ...(fields ? { sysparm_fields: fields } : {}),
      },
    })

    const results = (breakdownsResponse.data.result || []) as Array<Record<string, unknown>>
    return createSuccessResult({
      action: "list_breakdowns",
      indicator: { sys_id: indicator.sys_id, name: indicator.name },
      count: results.length,
      breakdowns: results,
    })
  }

  // Global listing
  const response = await client.get("/api/now/table/pa_breakdowns", {
    params: {
      sysparm_limit: limit,
      sysparm_orderby: "name",
      ...(fields ? { sysparm_fields: fields } : {}),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>
  return createSuccessResult({
    action: "list_breakdowns",
    count: results.length,
    breakdowns: results,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
