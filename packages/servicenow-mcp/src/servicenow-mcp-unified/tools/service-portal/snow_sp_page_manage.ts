/**
 * snow_sp_page_manage - Unified Service Portal page lifecycle management
 *
 * Manages sp_page records beyond initial creation: listing, updating, deleting,
 * cloning, and placing widget instances onto a page via sp_instance.
 *
 * Companion to snow_create_sp_page (authoring) and snow_create_sp_widget
 * (widget authoring). This tool covers everything around an existing page.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_sp_page_manage",
  description: `Unified tool for ServiceNow Service Portal page lifecycle beyond creation: list, update, delete, clone, add_widget_instance. Wraps sp_page and sp_instance.

Actions:
- list — list sp_page rows, optionally filtered by portal id, public flag, or title fragment
- update — patch sp_page fields (title, public, draft, css, internal)
- delete — delete an sp_page row (does not cascade widget instances)
- clone — duplicate an sp_page with a new id and title (optionally copying widget instances)
- add_widget_instance — place an sp_widget on the page by creating an sp_instance row

Use when: the agent needs to maintain Service Portal pages — renaming, retiring, duplicating layouts, or wiring widgets onto a page. For authoring a new sp_page, use snow_create_sp_page; for authoring a new sp_widget, use snow_create_sp_widget.

Returns: sp_page rows with sys_id, id, title, public, draft; widget instance rows with sys_id, sp_widget reference, and column placement.`,
  category: "ui-frameworks",
  subcategory: "service-portal",
  use_cases: ["service-portal", "portal-pages", "widget-instances", "page-management"],
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
        enum: ["list", "update", "delete", "clone", "add_widget_instance"],
      },
      // Identifiers
      sys_id: {
        type: "string",
        description: "[update/delete/clone/add_widget_instance] Page sys_id",
      },
      id: {
        type: "string",
        description: "[update/delete/clone/add_widget_instance] Page stable id (used as identifier when sys_id is absent)",
      },
      // LIST filters
      title_like: {
        type: "string",
        description: "[list] Filter by title substring",
      },
      public_only: {
        type: "boolean",
        description: "[list] Only return pages with public=true",
        default: false,
      },
      include_drafts: {
        type: "boolean",
        description: "[list] Include pages with draft=true",
        default: true,
      },
      limit: {
        type: "number",
        description: "[list] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list] Comma-separated list of fields to return",
      },
      // UPDATE fields
      title: {
        type: "string",
        description: "[update/clone] Page display title",
      },
      public: {
        type: "boolean",
        description: "[update] Whether the page is accessible without login",
      },
      draft: {
        type: "boolean",
        description: "[update] Whether the page is a draft",
      },
      css: {
        type: "string",
        description: "[update] Page-level CSS",
      },
      internal: {
        type: "boolean",
        description: "[update] Whether the page is internal (not surfaced in the portal nav)",
      },
      // CLONE
      new_id: {
        type: "string",
        description: "[clone] Stable id for the cloned page (required)",
      },
      copy_widget_instances: {
        type: "boolean",
        description: "[clone] Also copy sp_instance rows attached to the source page",
        default: true,
      },
      // ADD_WIDGET_INSTANCE
      widget_id: {
        type: "string",
        description: "[add_widget_instance] sp_widget sys_id or stable id to place on the page",
      },
      column_sys_id: {
        type: "string",
        description: "[add_widget_instance] sp_column sys_id to attach the instance to (preferred). Omit to attach to the page directly.",
      },
      instance_title: {
        type: "string",
        description: "[add_widget_instance] Optional title override for the widget instance",
      },
      order: {
        type: "number",
        description: "[add_widget_instance] Display order within the column",
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
      case "delete":
        return await executeDelete(args, context)
      case "clone":
        return await executeClone(args, context)
      case "add_widget_instance":
        return await executeAddWidgetInstance(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list, update, delete, clone, add_widget_instance`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Service Portal page ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function findPage(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string | undefined,
  id: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (sysId) {
    const direct = await client.get(`/api/now/table/sp_page/${sysId}`)
    if (direct.data.result && direct.data.result.sys_id) {
      return direct.data.result
    }
  }
  if (id) {
    const search = await client.get("/api/now/table/sp_page", {
      params: {
        sysparm_query: `id=${id}`,
        sysparm_limit: 1,
      },
    })
    const results = search.data.result || []
    if (results.length > 0) return results[0]
  }
  return null
}

async function findWidget(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  ref: string,
): Promise<Record<string, unknown> | null> {
  // ref may be a sys_id or a stable id
  const search = await client.get("/api/now/table/sp_widget", {
    params: {
      sysparm_query: `sys_id=${ref}^ORid=${ref}`,
      sysparm_limit: 1,
      sysparm_fields: "sys_id,id,name",
    },
  })
  const results = search.data.result || []
  if (results.length > 0) return results[0]
  return null
}

// ==================== LIST ====================

async function executeList(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const title_like = args.title_like as string | undefined
  const public_only = args.public_only === true
  const include_drafts = args.include_drafts !== false
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (title_like) queryParts.push(`titleLIKE${title_like}`)
  if (public_only) queryParts.push("public=true")
  if (!include_drafts) queryParts.push("draft=false")

  const response = await client.get("/api/now/table/sp_page", {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "title",
      ...(fields ? { sysparm_fields: fields } : { sysparm_fields: "sys_id,id,title,public,draft,internal,sys_updated_on" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list",
    count: results.length,
    pages: results.map((r) => ({
      sys_id: r.sys_id,
      id: r.id,
      title: r.title,
      public: r.public,
      draft: r.draft,
      internal: r.internal,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/sp?id=${r.id}`,
    })),
  })
}

// ==================== UPDATE ====================

async function executeUpdate(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const id = args.id as string | undefined

  if (!sys_id && !id) {
    return createErrorResult("sys_id or id is required for update action")
  }

  const client = await getAuthenticatedClient(context)
  const page = await findPage(client, sys_id, id)
  if (!page) {
    return createErrorResult(`Service Portal page not found: ${sys_id || id}`)
  }

  const updatableFields = ["title", "public", "draft", "css", "internal"]
  const patch: Record<string, unknown> = {}
  for (const key of updatableFields) {
    if (args[key] !== undefined) patch[key] = args[key]
  }

  if (Object.keys(patch).length === 0) {
    return createErrorResult("No update fields provided")
  }

  const targetSysId = page.sys_id as string
  const response = await client.patch(`/api/now/table/sp_page/${targetSysId}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "update",
    updated: true,
    sys_id: targetSysId,
    id: updated.id,
    updated_fields: Object.keys(patch),
    page: updated,
    url: `${context.instanceUrl}/sp?id=${updated.id}`,
  })
}

// ==================== DELETE ====================

async function executeDelete(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const id = args.id as string | undefined

  if (!sys_id && !id) {
    return createErrorResult("sys_id or id is required for delete action")
  }

  const client = await getAuthenticatedClient(context)
  const page = await findPage(client, sys_id, id)
  if (!page) {
    return createErrorResult(`Service Portal page not found: ${sys_id || id}`)
  }

  const targetSysId = page.sys_id as string
  await client.delete(`/api/now/table/sp_page/${targetSysId}`)

  return createSuccessResult({
    action: "delete",
    deleted: true,
    sys_id: targetSysId,
    id: page.id,
  })
}

// ==================== CLONE ====================

async function executeClone(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const id = args.id as string | undefined
  const new_id = args.new_id as string | undefined
  const new_title = args.title as string | undefined
  const copy_widget_instances = args.copy_widget_instances !== false

  if (!sys_id && !id) {
    return createErrorResult("sys_id or id is required to identify the source page")
  }
  if (!new_id) {
    return createErrorResult("new_id is required for clone action")
  }

  const client = await getAuthenticatedClient(context)
  const page = await findPage(client, sys_id, id)
  if (!page) {
    return createErrorResult(`Service Portal page not found: ${sys_id || id}`)
  }

  // Reject duplicate target id
  const existing = await client.get("/api/now/table/sp_page", {
    params: { sysparm_query: `id=${new_id}`, sysparm_limit: 1, sysparm_fields: "sys_id" },
  })
  if ((existing.data.result || []).length > 0) {
    return createErrorResult(`Service Portal page '${new_id}' already exists`)
  }

  const sourceSysId = page.sys_id as string
  const payload: Record<string, unknown> = {
    id: new_id,
    title: new_title || `${page.title} (copy)`,
    public: page.public,
    draft: true,
    internal: page.internal,
    css: page.css,
  }

  const createResponse = await client.post("/api/now/table/sp_page", payload)
  const cloned = createResponse.data.result as Record<string, unknown>
  const clonedSysId = cloned.sys_id as string

  const copiedInstances: string[] = []
  if (copy_widget_instances) {
    // sp_instance has no sp_page reference — instances belong to sp_column rows
    // which in turn belong to sp_row → sp_page. Walk the layout tree and clone
    // rows + columns + instances under the new page.
    try {
      const sourceRows = await client.get("/api/now/table/sp_row", {
        params: { sysparm_query: `sp_page=${sourceSysId}`, sysparm_limit: 200 },
      })
      for (const row of (sourceRows.data.result || []) as Array<Record<string, unknown>>) {
        const rowCopy: Record<string, unknown> = { ...row }
        delete rowCopy.sys_id
        delete rowCopy.sys_created_on
        delete rowCopy.sys_created_by
        delete rowCopy.sys_updated_on
        delete rowCopy.sys_updated_by
        delete rowCopy.sys_mod_count
        rowCopy.sp_page = clonedSysId
        const newRow = await client.post("/api/now/table/sp_row", rowCopy)
        const newRowSysId = newRow.data.result.sys_id as string

        const cols = await client.get("/api/now/table/sp_column", {
          params: { sysparm_query: `sp_row=${row.sys_id}`, sysparm_limit: 50 },
        })
        for (const col of (cols.data.result || []) as Array<Record<string, unknown>>) {
          const colCopy: Record<string, unknown> = { ...col }
          delete colCopy.sys_id
          delete colCopy.sys_created_on
          delete colCopy.sys_created_by
          delete colCopy.sys_updated_on
          delete colCopy.sys_updated_by
          delete colCopy.sys_mod_count
          colCopy.sp_row = newRowSysId
          const newCol = await client.post("/api/now/table/sp_column", colCopy)
          const newColSysId = newCol.data.result.sys_id as string

          const instances = await client.get("/api/now/table/sp_instance", {
            params: { sysparm_query: `sp_column=${col.sys_id}`, sysparm_limit: 50 },
          })
          for (const inst of (instances.data.result || []) as Array<Record<string, unknown>>) {
            const instCopy: Record<string, unknown> = { ...inst }
            delete instCopy.sys_id
            delete instCopy.sys_created_on
            delete instCopy.sys_created_by
            delete instCopy.sys_updated_on
            delete instCopy.sys_updated_by
            delete instCopy.sys_mod_count
            instCopy.sp_column = newColSysId
            const created = await client.post("/api/now/table/sp_instance", instCopy)
            copiedInstances.push(created.data.result.sys_id)
          }
        }
      }
    } catch {
      // Best-effort — fall through. Caller still gets the cloned page.
    }
  }

  return createSuccessResult({
    action: "clone",
    cloned: true,
    sys_id: clonedSysId,
    id: cloned.id,
    source: { sys_id: sourceSysId, id: page.id },
    page: cloned,
    widget_instances_copied: copiedInstances.length,
    url: `${context.instanceUrl}/sp?id=${cloned.id}`,
  })
}

// ==================== ADD_WIDGET_INSTANCE ====================

async function executeAddWidgetInstance(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const id = args.id as string | undefined
  const widget_id = args.widget_id as string | undefined
  const column_sys_id = args.column_sys_id as string | undefined
  const instance_title = args.instance_title as string | undefined
  const order = args.order as number | undefined

  if (!sys_id && !id) {
    return createErrorResult("sys_id or id is required to identify the page")
  }
  if (!widget_id) {
    return createErrorResult("widget_id is required for add_widget_instance action")
  }

  const client = await getAuthenticatedClient(context)
  const page = await findPage(client, sys_id, id)
  if (!page) {
    return createErrorResult(`Service Portal page not found: ${sys_id || id}`)
  }

  const widget = await findWidget(client, widget_id)
  if (!widget) {
    return createErrorResult(`sp_widget not found: ${widget_id}`)
  }

  // sp_instance has no sp_page column — widget instances are placed on a
  // sp_column (which belongs to a sp_row, which belongs to the sp_page).
  // column_sys_id is therefore required to attach the instance correctly.
  if (!column_sys_id) {
    return createErrorResult(
      "column_sys_id is required for add_widget_instance — widget instances live on sp_column rows, not directly on sp_page",
    )
  }
  const payload: Record<string, unknown> = {
    sp_widget: widget.sys_id,
    sp_column: column_sys_id,
  }
  if (instance_title) payload.title = instance_title
  if (order !== undefined) payload.order = order

  const response = await client.post("/api/now/table/sp_instance", payload)
  const result = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "add_widget_instance",
    created: true,
    sys_id: result.sys_id,
    page: { sys_id: page.sys_id, id: page.id },
    widget: { sys_id: widget.sys_id, id: widget.id },
    instance: result,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
