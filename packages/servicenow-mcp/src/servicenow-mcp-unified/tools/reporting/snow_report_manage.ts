/**
 * snow_report_manage - Unified report lifecycle management
 *
 * Manages the lifecycle of sys_report definitions beyond initial creation:
 * listing, retrieving, ad-hoc execution, scheduled delivery, sharing with
 * users or groups, and exporting result sets. Authoring of new sys_report
 * rows is handled by snow_create_report; this tool covers the operational
 * lifecycle around an existing report.
 *
 * Companion to snow_create_report (authoring) and snow_schedule_report_delivery
 * (one-shot delivery scheduling) — this tool gathers the smaller list/get/run/
 * share/export operations under a single action switch.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_report_manage",
  description: `Unified tool for ServiceNow report lifecycle beyond creation: list, get, run, schedule, share, and export. Wraps sys_report, sysauto_report, and sys_report_users_groups.

Actions:
- list — list sys_report definitions, optionally filtered by table or owner
- get — retrieve a single report (sys_id or title)
- run — execute the report ad-hoc and return rows from the configured table using the report filter
- schedule — create or update a sysauto_report row (recurrence, time, recipients)
- share — share a report with users or groups via sys_report_users_groups
- export — export the report's underlying rows as JSON or CSV (server-side rendered PDF/XLSX is out of scope; use schedule for delivery)

Use when: the agent needs to manage reports after they exist — running them on demand, scheduling delivery, or controlling who can view them. For authoring a new sys_report row, use snow_create_report instead.

Returns: report records with sys_id, title, table, type, filter; schedule rows with run_time and recipients; share rows with user_or_group references.`,
  category: "reporting",
  subcategory: "reports",
  use_cases: ["reporting", "reports", "scheduling", "sharing", "exports"],
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
        enum: ["list", "get", "run", "schedule", "share", "export"],
      },
      // Identifiers
      sys_id: {
        type: "string",
        description: "[get/run/schedule/share/export] Report sys_id",
      },
      title: {
        type: "string",
        description: "[get/run/schedule/share/export] Report title (used as identifier when sys_id is absent)",
      },
      // LIST filters
      table: {
        type: "string",
        description: "[list] Filter by source table (e.g. incident, change_request)",
      },
      owner: {
        type: "string",
        description: "[list] Filter by sys_user sys_id (report owner/user field)",
      },
      // RUN
      limit: {
        type: "number",
        description: "[run/list/export] Maximum rows to return",
        default: 100,
      },
      display_value: {
        type: "boolean",
        description: "[run/export] Return display values rather than raw references",
        default: true,
      },
      // SCHEDULE
      run_time: {
        type: "string",
        description: "[schedule] Local time of day to run, HH:MM:SS (ServiceNow stores as a glide_time)",
      },
      run_dayofmonth: {
        type: "number",
        description: "[schedule] Day of month (1-31) for monthly recurrence",
      },
      run_dayofweek: {
        type: "number",
        description: "[schedule] Day of week (1=Mon … 7=Sun) for weekly recurrence",
      },
      run_type: {
        type: "string",
        description: "[schedule] Recurrence type",
        enum: ["daily", "weekly", "monthly", "periodically", "once"],
      },
      recipients: {
        type: "array",
        items: { type: "string" },
        description: "[schedule] sys_user sys_ids or email addresses to receive the scheduled report",
      },
      schedule_sys_id: {
        type: "string",
        description: "[schedule] Existing sysauto_report sys_id to update; omit to create a new row",
      },
      schedule_active: {
        type: "boolean",
        description: "[schedule] Whether the schedule is active",
        default: true,
      },
      // SHARE
      user: {
        type: "string",
        description: "[share] sys_user sys_id to grant view access",
      },
      group: {
        type: "string",
        description: "[share] sys_user_group sys_id to grant view access (alternative to user)",
      },
      // EXPORT
      format: {
        type: "string",
        description: "[export] Export format",
        enum: ["json", "csv"],
        default: "json",
      },
      fields: {
        type: "string",
        description: "[list/get/run/export] Comma-separated list of fields to return",
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
      case "run":
        return await executeRun(args, context)
      case "schedule":
        return await executeSchedule(args, context)
      case "share":
        return await executeShare(args, context)
      case "export":
        return await executeExport(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list, get, run, schedule, share, export`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Report ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function findReport(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string | undefined,
  title: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (sysId) {
    const direct = await client.get(`/api/now/table/sys_report/${sysId}`)
    if (direct.data.result && direct.data.result.sys_id) {
      return direct.data.result
    }
  }
  if (title) {
    const search = await client.get("/api/now/table/sys_report", {
      params: {
        sysparm_query: `title=${title}`,
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
  const table = args.table as string | undefined
  const owner = args.owner as string | undefined
  const limit = (args.limit as number) || 100
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (table) queryParts.push(`table=${table}`)
  if (owner) queryParts.push(`user=${owner}`)

  const response = await client.get("/api/now/table/sys_report", {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "title",
      ...(fields ? { sysparm_fields: fields } : { sysparm_fields: "sys_id,title,table,type,filter,user,sys_updated_on" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list",
    count: results.length,
    reports: results.map((r) => ({
      sys_id: r.sys_id,
      title: r.title,
      table: r.table,
      type: r.type,
      filter: r.filter,
      owner: r.user,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=sys_report.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== GET ====================

async function executeGet(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const title = args.title as string | undefined

  if (!sys_id && !title) {
    return createErrorResult("sys_id or title is required for get action")
  }

  const client = await getAuthenticatedClient(context)
  const report = await findReport(client, sys_id, title)
  if (!report) {
    return createErrorResult(`Report not found: ${sys_id || title}`)
  }

  const reportSysId = report.sys_id as string

  // Best-effort schedule lookup
  let scheduleCount = 0
  try {
    const schedules = await client.get("/api/now/table/sysauto_report", {
      params: { sysparm_query: `report=${reportSysId}`, sysparm_fields: "sys_id", sysparm_limit: 50 },
    })
    scheduleCount = (schedules.data.result || []).length
  } catch {
    // TODO: verify sysauto_report schema on a live instance
  }

  return createSuccessResult({
    action: "get",
    sys_id: reportSysId,
    title: report.title,
    report,
    related: {
      schedule_count: scheduleCount,
    },
    url: `${context.instanceUrl}/nav_to.do?uri=sys_report.do?sys_id=${reportSysId}`,
  })
}

// ==================== RUN ====================

async function executeRun(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const title = args.title as string | undefined
  const limit = (args.limit as number) || 100
  const display_value = args.display_value !== false
  const fields = args.fields as string | undefined

  if (!sys_id && !title) {
    return createErrorResult("sys_id or title is required for run action")
  }

  const client = await getAuthenticatedClient(context)
  const report = await findReport(client, sys_id, title)
  if (!report) {
    return createErrorResult(`Report not found: ${sys_id || title}`)
  }

  const table = report.table as string
  if (!table) {
    return createErrorResult(`Report ${report.sys_id} has no source table set`)
  }
  const filter = (report.filter as string) || ""

  const response = await client.get(`/api/now/table/${table}`, {
    params: {
      sysparm_query: filter,
      sysparm_limit: limit,
      sysparm_display_value: display_value ? "true" : "false",
      ...(fields ? { sysparm_fields: fields } : {}),
    },
  })

  const rows = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "run",
    sys_id: report.sys_id,
    title: report.title,
    table,
    filter,
    count: rows.length,
    rows,
    url: `${context.instanceUrl}/nav_to.do?uri=sys_report_template.do?sysparm_report_id=${report.sys_id}`,
  })
}

// ==================== SCHEDULE ====================

async function executeSchedule(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const title = args.title as string | undefined
  const schedule_sys_id = args.schedule_sys_id as string | undefined

  if (!sys_id && !title) {
    return createErrorResult("sys_id or title is required to identify the report")
  }

  const client = await getAuthenticatedClient(context)
  const report = await findReport(client, sys_id, title)
  if (!report) {
    return createErrorResult(`Report not found: ${sys_id || title}`)
  }

  const recipients = (args.recipients as string[] | undefined) || []
  const payload: Record<string, unknown> = {
    report: report.sys_id,
    active: args.schedule_active === undefined ? true : args.schedule_active,
  }
  if (args.run_type) payload.run_type = args.run_type
  if (args.run_time) payload.run_time = args.run_time
  if (args.run_dayofmonth !== undefined) payload.run_dayofmonth = args.run_dayofmonth
  if (args.run_dayofweek !== undefined) payload.run_dayofweek = args.run_dayofweek
  // sysauto_report uses user_list (sys_user references), group_list (sys_user_group references),
  // and address_list (free-form email addresses) — not email_list. Split the recipients by shape:
  // 32-hex sys_ids go to user_list, plain addresses go to address_list.
  if (recipients.length > 0) {
    const userIds: string[] = []
    const addresses: string[] = []
    for (const r of recipients) {
      if (/^[0-9a-f]{32}$/i.test(r)) userIds.push(r)
      else addresses.push(r)
    }
    if (userIds.length > 0) payload.user_list = userIds.join(",")
    if (addresses.length > 0) payload.address_list = addresses.join(",")
  }

  let response
  let mode: "created" | "updated"
  if (schedule_sys_id) {
    response = await client.patch(`/api/now/table/sysauto_report/${schedule_sys_id}`, payload)
    mode = "updated"
  } else {
    response = await client.post("/api/now/table/sysauto_report", payload)
    mode = "created"
  }

  const result = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "schedule",
    schedule_action: mode,
    sys_id: result.sys_id,
    report: { sys_id: report.sys_id, title: report.title },
    schedule: result,
    url: `${context.instanceUrl}/nav_to.do?uri=sysauto_report.do?sys_id=${result.sys_id}`,
  })
}

// ==================== SHARE ====================

async function executeShare(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const title = args.title as string | undefined
  const user = args.user as string | undefined
  const group = args.group as string | undefined

  if (!sys_id && !title) {
    return createErrorResult("sys_id or title is required to identify the report")
  }
  if (!user && !group) {
    return createErrorResult("user or group is required for share action")
  }

  const client = await getAuthenticatedClient(context)
  const report = await findReport(client, sys_id, title)
  if (!report) {
    return createErrorResult(`Report not found: ${sys_id || title}`)
  }

  // sys_report_users_groups uses report_id (ref sys_report), user_id (ref sys_user),
  // and group_id (ref sys_user_group).
  const payload: Record<string, unknown> = {
    report_id: report.sys_id,
  }
  if (user) payload.user_id = user
  if (group) payload.group_id = group

  const response = await client.post("/api/now/table/sys_report_users_groups", payload)
  const result = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "share",
    shared: true,
    sys_id: result.sys_id,
    report: { sys_id: report.sys_id, title: report.title },
    share: result,
  })
}

// ==================== EXPORT ====================

async function executeExport(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const title = args.title as string | undefined
  const format = (args.format as string) || "json"
  const limit = (args.limit as number) || 100
  const display_value = args.display_value !== false
  const fields = args.fields as string | undefined

  if (!sys_id && !title) {
    return createErrorResult("sys_id or title is required for export action")
  }

  const client = await getAuthenticatedClient(context)
  const report = await findReport(client, sys_id, title)
  if (!report) {
    return createErrorResult(`Report not found: ${sys_id || title}`)
  }

  const table = report.table as string
  if (!table) {
    return createErrorResult(`Report ${report.sys_id} has no source table set`)
  }
  const filter = (report.filter as string) || ""

  const response = await client.get(`/api/now/table/${table}`, {
    params: {
      sysparm_query: filter,
      sysparm_limit: limit,
      sysparm_display_value: display_value ? "true" : "false",
      ...(fields ? { sysparm_fields: fields } : {}),
    },
  })

  const rows = (response.data.result || []) as Array<Record<string, unknown>>

  if (format === "csv") {
    const headers = rows.length > 0 ? Object.keys(rows[0]) : []
    const escape = (v: unknown): string => {
      const s = v === null || v === undefined ? "" : String(v)
      const needsQuote = s.includes(",") || s.includes('"') || s.includes("\n")
      return needsQuote ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [headers.join(",")]
    for (const row of rows) {
      lines.push(headers.map((h) => escape(row[h])).join(","))
    }
    return createSuccessResult({
      action: "export",
      sys_id: report.sys_id,
      title: report.title,
      table,
      format,
      count: rows.length,
      csv: lines.join("\n"),
    })
  }

  return createSuccessResult({
    action: "export",
    sys_id: report.sys_id,
    title: report.title,
    table,
    format,
    count: rows.length,
    rows,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
