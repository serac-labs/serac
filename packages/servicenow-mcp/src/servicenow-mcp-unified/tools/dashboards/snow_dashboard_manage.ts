/**
 * snow_dashboard_manage - Unified dashboard lifecycle management
 *
 * Manages the lifecycle of sys_dashboard records beyond initial creation:
 * listing, retrieving, sharing through sys_dashboard_admin, generating
 * embed snippets, and managing pa_tabs rows (the Performance Analytics
 * dashboard tabs that group widgets within a dashboard).
 *
 * Companion to snow_create_dashboard (creates the sys_dashboard record)
 * and snow_add_dashboard_widget (attaches widgets). This tool covers
 * everything around an existing dashboard.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_dashboard_manage",
  description: `Unified tool for ServiceNow dashboard lifecycle beyond creation: list, get, share, embed, tab_create, tab_list. Wraps sys_dashboard, sys_dashboard_admin, and pa_tabs.

Actions:
- list — list sys_dashboard rows, optionally filtered by owner or active flag
- get — retrieve a dashboard by sys_id or title (includes tab and widget counts)
- share — share a dashboard with a user or group through sys_dashboard_admin
- embed — produce an embed URL and iframe snippet for a dashboard (no write to ServiceNow)
- tab_create — create a pa_tabs row attached to a dashboard
- tab_list — list pa_tabs rows attached to a dashboard

Use when: the agent needs to manage dashboards after they exist — sharing them, embedding them in a portal page, or organising their tab layout. For authoring a new dashboard, use snow_create_dashboard; for attaching widgets to it, use snow_add_dashboard_widget.

Returns: dashboard records with sys_id, title, columns, active; share rows with user_or_group references; tab rows with order and title.`,
  category: "reporting",
  subcategory: "dashboards",
  use_cases: ["dashboards", "reporting", "sharing", "embedding", "tabs"],
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
        enum: ["list", "get", "share", "embed", "tab_create", "tab_list"],
      },
      // Identifiers
      sys_id: {
        type: "string",
        description: "[get/share/embed/tab_create/tab_list] Dashboard sys_id",
      },
      title: {
        type: "string",
        description: "[get/share/embed/tab_create/tab_list] Dashboard title (used as identifier when sys_id is absent)",
      },
      // LIST
      owner: {
        type: "string",
        description: "[list] Filter by sys_user sys_id (dashboard owner)",
      },
      active_only: {
        type: "boolean",
        description: "[list] Only return active dashboards",
        default: false,
      },
      limit: {
        type: "number",
        description: "[list/tab_list] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list/get/tab_list] Comma-separated list of fields to return",
      },
      // SHARE
      user: {
        type: "string",
        description: "[share] sys_user sys_id to grant view/edit access",
      },
      group: {
        type: "string",
        description: "[share] sys_user_group sys_id to grant view/edit access (alternative to user)",
      },
      share_role: {
        type: "string",
        description: "[share] Access level granted",
        enum: ["read", "write"],
        default: "read",
      },
      // EMBED
      embed_height: {
        type: "number",
        description: "[embed] Iframe height in pixels",
        default: 800,
      },
      embed_width: {
        type: "string",
        description: "[embed] Iframe width (px or %)",
        default: "100%",
      },
      // TAB_CREATE
      tab_title: {
        type: "string",
        description: "[tab_create] Tab title shown on the dashboard",
      },
      tab_order: {
        type: "number",
        description: "[tab_create] Tab display order (lower = first)",
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
      case "share":
        return await executeShare(args, context)
      case "embed":
        return await executeEmbed(args, context)
      case "tab_create":
        return await executeTabCreate(args, context)
      case "tab_list":
        return await executeTabList(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list, get, share, embed, tab_create, tab_list`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Dashboard ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function findDashboard(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string | undefined,
  title: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (sysId) {
    const direct = await client.get(`/api/now/table/sys_dashboard/${sysId}`)
    if (direct.data.result && direct.data.result.sys_id) {
      return direct.data.result
    }
  }
  if (title) {
    // sys_dashboard exposes the display label as `name` (no `title` column).
    const search = await client.get("/api/now/table/sys_dashboard", {
      params: {
        sysparm_query: `name=${title}`,
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
  const owner = args.owner as string | undefined
  const active_only = args.active_only === true
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  // sys_dashboard has no owner or description columns — only name, columns, rows,
  // cell_height, cell_width, roles, active. Drop the owner filter (left in args for
  // forward-compat) and project just the real fields.
  const queryParts: string[] = []
  if (active_only) queryParts.push("active=true")
  if (owner) {
    // Best-effort: sys_dashboard_admin holds dashboard ownership/sharing on most releases.
    try {
      const adminResp = await client.get("/api/now/table/sys_dashboard_admin", {
        params: { sysparm_query: `user=${owner}`, sysparm_fields: "dashboard", sysparm_limit: 200 },
      })
      const dashIds = ((adminResp.data.result || []) as Array<Record<string, unknown>>)
        .map((r) => {
          const ref = r.dashboard
          if (typeof ref === "string") return ref
          if (ref && typeof ref === "object" && "value" in ref) return (ref as { value: string }).value
          return null
        })
        .filter((v): v is string => typeof v === "string" && v.length > 0)
      if (dashIds.length > 0) queryParts.push(`sys_idIN${dashIds.join(",")}`)
    } catch {
      // sys_dashboard_admin may not be queryable on every release — drop the owner filter.
    }
  }

  const response = await client.get("/api/now/table/sys_dashboard", {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "name",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,name,roles,active,columns,rows,sys_updated_on" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list",
    count: results.length,
    dashboards: results.map((r) => ({
      sys_id: r.sys_id,
      name: r.name,
      roles: r.roles,
      active: r.active,
      columns: r.columns,
      rows: r.rows,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/$pa_dashboard.do?sysparm_dashboard=${r.sys_id}`,
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
  const dashboard = await findDashboard(client, sys_id, title)
  if (!dashboard) {
    return createErrorResult(`Dashboard not found: ${sys_id || title}`)
  }

  const dashboardSysId = dashboard.sys_id as string

  // Best-effort tab and widget counts
  let tabCount = 0
  let widgetCount = 0
  try {
    const tabs = await client.get("/api/now/table/pa_tabs", {
      params: { sysparm_query: `dashboard=${dashboardSysId}`, sysparm_fields: "sys_id", sysparm_limit: 200 },
    })
    tabCount = (tabs.data.result || []).length
  } catch {
    // TODO: verify pa_tabs.dashboard column name on a live instance
  }
  try {
    const widgets = await client.get("/api/now/table/sys_dashboard_widget", {
      params: { sysparm_query: `dashboard=${dashboardSysId}`, sysparm_fields: "sys_id", sysparm_limit: 500 },
    })
    widgetCount = (widgets.data.result || []).length
  } catch {
    // sys_dashboard_widget may carry the dashboard reference on a different column on older instances
  }

  return createSuccessResult({
    action: "get",
    sys_id: dashboardSysId,
    title: dashboard.title || dashboard.name,
    dashboard,
    related: {
      tab_count: tabCount,
      widget_count: widgetCount,
    },
    url: `${context.instanceUrl}/$pa_dashboard.do?sysparm_dashboard=${dashboardSysId}`,
  })
}

// ==================== SHARE ====================

async function executeShare(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const title = args.title as string | undefined
  const user = args.user as string | undefined
  const group = args.group as string | undefined
  const share_role = (args.share_role as string) || "read"

  if (!sys_id && !title) {
    return createErrorResult("sys_id or title is required to identify the dashboard")
  }
  if (!user && !group) {
    return createErrorResult("user or group is required for share action")
  }

  const client = await getAuthenticatedClient(context)
  const dashboard = await findDashboard(client, sys_id, title)
  if (!dashboard) {
    return createErrorResult(`Dashboard not found: ${sys_id || title}`)
  }

  // TODO: verify sys_dashboard_admin column names on a live instance
  const payload: Record<string, unknown> = {
    dashboard: dashboard.sys_id,
    can_write: share_role === "write",
  }
  if (user) payload.user = user
  if (group) payload.group = group

  const response = await client.post("/api/now/table/sys_dashboard_admin", payload)
  const result = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "share",
    shared: true,
    sys_id: result.sys_id,
    dashboard: { sys_id: dashboard.sys_id, title: dashboard.title || dashboard.name },
    share: result,
    role: share_role,
  })
}

// ==================== EMBED ====================

async function executeEmbed(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const title = args.title as string | undefined
  const height = (args.embed_height as number) || 800
  const width = (args.embed_width as string) || "100%"

  if (!sys_id && !title) {
    return createErrorResult("sys_id or title is required for embed action")
  }

  const client = await getAuthenticatedClient(context)
  const dashboard = await findDashboard(client, sys_id, title)
  if (!dashboard) {
    return createErrorResult(`Dashboard not found: ${sys_id || title}`)
  }

  const dashboardSysId = dashboard.sys_id as string
  const embedUrl = `${context.instanceUrl}/$pa_dashboard.do?sysparm_dashboard=${dashboardSysId}&sysparm_embed=true`
  const iframe = `<iframe src="${embedUrl}" width="${width}" height="${height}" frameborder="0"></iframe>`

  return createSuccessResult({
    action: "embed",
    sys_id: dashboardSysId,
    title: dashboard.title || dashboard.name,
    embed_url: embedUrl,
    iframe,
    width,
    height,
  })
}

// ==================== TAB_CREATE ====================

async function executeTabCreate(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const title = args.title as string | undefined
  const tab_title = args.tab_title as string | undefined
  const tab_order = args.tab_order as number | undefined

  if (!sys_id && !title) {
    return createErrorResult("sys_id or title is required to identify the dashboard")
  }
  if (!tab_title) {
    return createErrorResult("tab_title is required for tab_create action")
  }

  const client = await getAuthenticatedClient(context)
  const dashboard = await findDashboard(client, sys_id, title)
  if (!dashboard) {
    return createErrorResult(`Dashboard not found: ${sys_id || title}`)
  }

  // TODO: verify pa_tabs field set on a live instance
  const payload: Record<string, unknown> = {
    dashboard: dashboard.sys_id,
    title: tab_title,
  }
  if (tab_order !== undefined) payload.order = tab_order

  const response = await client.post("/api/now/table/pa_tabs", payload)
  const result = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "tab_create",
    created: true,
    sys_id: result.sys_id,
    dashboard: { sys_id: dashboard.sys_id, title: dashboard.title || dashboard.name },
    tab: result,
  })
}

// ==================== TAB_LIST ====================

async function executeTabList(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const title = args.title as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  if (!sys_id && !title) {
    return createErrorResult("sys_id or title is required for tab_list action")
  }

  const client = await getAuthenticatedClient(context)
  const dashboard = await findDashboard(client, sys_id, title)
  if (!dashboard) {
    return createErrorResult(`Dashboard not found: ${sys_id || title}`)
  }

  // TODO: verify pa_tabs.dashboard column name on a live instance
  const response = await client.get("/api/now/table/pa_tabs", {
    params: {
      sysparm_query: `dashboard=${dashboard.sys_id}`,
      sysparm_limit: limit,
      sysparm_orderby: "order",
      ...(fields ? { sysparm_fields: fields } : { sysparm_fields: "sys_id,title,order,dashboard,active" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "tab_list",
    dashboard: { sys_id: dashboard.sys_id, title: dashboard.title || dashboard.name },
    count: results.length,
    tabs: results,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
