/**
 * snow_catalog_manage - Unified Service Catalog structure management
 *
 * Manages the catalog patterns that snow_create_catalog_item does not cover:
 * order guides (sc_cat_item_guide), record producers (sc_cat_item_producer),
 * catalog categories (sc_category), and the item-to-category junction
 * (sc_cat_item_category). These are the structural pieces that group and
 * route catalog items — the items themselves are still authored by
 * snow_create_catalog_item.
 *
 * Companion to snow_create_catalog_item (sc_cat_item authoring),
 * snow_discover_catalogs (catalog topology discovery), and
 * snow_create_catalog_ui_policy / snow_create_catalog_client_script
 * (per-item variable behavior).
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_catalog_manage",
  description: `Unified tool for ServiceNow Service Catalog structure: order guides, record producers, categories, and the item-to-category junction. Wraps the sc_cat_item_guide, sc_cat_item_producer, sc_category, and sc_cat_item_category tables.

Actions:
- create_order_guide — create a new order guide (sc_cat_item_guide) that bundles related catalog items into a single guided flow
- list_order_guides — list order guides, optionally filtered by catalog
- create_record_producer — create a record producer (sc_cat_item_producer) that surfaces as a catalog item but writes to a non-request target table (incident, change_request, etc.)
- list_record_producers — list record producers, optionally filtered by target table
- list_categories — list catalog categories (sc_category), optionally filtered by catalog or parent
- create_category — create a catalog category to organize items into a navigable tree
- link_item_to_category — attach a catalog item to a category through the sc_cat_item_category junction (items can live in multiple categories)

Use when: the agent needs to organize catalog items into guides or categories, or expose a record-creation form (record producer) outside the standard requested-item flow. For the catalog items themselves use snow_create_catalog_item; for ordering an existing item use snow_order_catalog_item.

Returns: created or queried records with sys_id, name, and the relevant references (sc_catalogs, category, table_name). Junction inserts return the sc_cat_item_category link sys_id so it can be removed later.`,
  category: "itsm",
  subcategory: "service-catalog",
  use_cases: ["service-catalog", "order-guides", "record-producers", "categories"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Catalog structure action to perform",
        enum: [
          "create_order_guide",
          "list_order_guides",
          "create_record_producer",
          "list_record_producers",
          "list_categories",
          "create_category",
          "link_item_to_category",
        ],
      },
      // ORDER GUIDE / RECORD PRODUCER / CATEGORY common fields
      name: {
        type: "string",
        description: "[create_order_guide/create_record_producer/create_category] Display name",
      },
      short_description: {
        type: "string",
        description: "[create_order_guide/create_record_producer/create_category] Short description shown on the catalog tile",
      },
      description: {
        type: "string",
        description: "[create_order_guide/create_record_producer/create_category] Long description / overview",
      },
      sc_catalogs: {
        type: "string",
        description: "[create_order_guide/create_record_producer/create_category/list_*] Catalog sys_id (sc_catalog) to attach to or filter by",
      },
      category: {
        type: "string",
        description: "[create_order_guide/create_record_producer] Initial sc_category sys_id (use link_item_to_category to add more later)",
      },
      active: {
        type: "boolean",
        description: "[create_order_guide/create_record_producer/create_category] Whether the record is active",
        default: true,
      },
      // ORDER GUIDE specific
      include_items: {
        type: "boolean",
        description: "[create_order_guide] Whether items are pre-selected for the requester (sc_cat_item_guide.include_items)",
        default: true,
      },
      // RECORD PRODUCER specific
      table_name: {
        type: "string",
        description: "[create_record_producer/list_record_producers] Target table the producer writes to (e.g. incident, change_request, problem)",
      },
      script: {
        type: "string",
        description: "[create_record_producer] Server-side script that maps producer variables to the target record. ES5 only — use var, function(), and string concatenation; no const/let/arrow/template literals",
      },
      // CATEGORY specific
      parent: {
        type: "string",
        description: "[create_category/list_categories] Parent sc_category sys_id (for nested categories) or filter",
      },
      title: {
        type: "string",
        description: "[create_category] Category display title (defaults to name)",
      },
      homepage_renderer: {
        type: "string",
        description: "[create_category] sys_id of the sc_homepage_renderer used to render the category. Mandatory on sc_category — defaults to the OOB Default Renderer if omitted.",
      },
      // LINK_ITEM_TO_CATEGORY
      cat_item: {
        type: "string",
        description: "[link_item_to_category] Catalog item sys_id (sc_cat_item) to link",
      },
      category_sys_id: {
        type: "string",
        description: "[link_item_to_category] Category sys_id (sc_category) to link the item to",
      },
      // LIST common
      active_only: {
        type: "boolean",
        description: "[list_*] Only return active records",
        default: false,
      },
      limit: {
        type: "number",
        description: "[list_*] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list_*] Comma-separated list of fields to return",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "create_order_guide":
        return await executeCreateOrderGuide(args, context)
      case "list_order_guides":
        return await executeListOrderGuides(args, context)
      case "create_record_producer":
        return await executeCreateRecordProducer(args, context)
      case "list_record_producers":
        return await executeListRecordProducers(args, context)
      case "list_categories":
        return await executeListCategories(args, context)
      case "create_category":
        return await executeCreateCategory(args, context)
      case "link_item_to_category":
        return await executeLinkItemToCategory(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: create_order_guide, list_order_guides, create_record_producer, list_record_producers, list_categories, create_category, link_item_to_category`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Catalog ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== CREATE_ORDER_GUIDE ====================

async function executeCreateOrderGuide(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const name = args.name as string | undefined
  if (!name) return createErrorResult("name is required for create_order_guide")

  const client = await getAuthenticatedClient(context)

  // Reject duplicate by name within the same catalog (if a catalog is specified)
  const dedupeQuery = args.sc_catalogs
    ? `name=${name}^sc_catalogsLIKE${args.sc_catalogs}`
    : `name=${name}`
  const existing = await client.get("/api/now/table/sc_cat_item_guide", {
    params: { sysparm_query: dedupeQuery, sysparm_limit: 1, sysparm_fields: "sys_id" },
  })
  if ((existing.data.result || []).length > 0) {
    return createErrorResult(`Order guide '${name}' already exists in this catalog`)
  }

  const payload: Record<string, unknown> = {
    name,
    short_description: (args.short_description as string) || "",
    description: (args.description as string) || "",
    active: args.active === undefined ? true : args.active,
    include_items: args.include_items === undefined ? true : args.include_items,
  }
  if (args.sc_catalogs) payload.sc_catalogs = args.sc_catalogs
  if (args.category) payload.category = args.category

  const response = await client.post("/api/now/table/sc_cat_item_guide", payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "create_order_guide",
    created: true,
    sys_id: created.sys_id,
    name: created.name,
    order_guide: created,
    url: `${context.instanceUrl}/nav_to.do?uri=sc_cat_item_guide.do?sys_id=${created.sys_id}`,
  })
}

// ==================== LIST_ORDER_GUIDES ====================

async function executeListOrderGuides(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sc_catalogs = args.sc_catalogs as string | undefined
  const active_only = args.active_only === true
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (sc_catalogs) queryParts.push(`sc_catalogsLIKE${sc_catalogs}`)
  if (active_only) queryParts.push("active=true")

  const response = await client.get("/api/now/table/sc_cat_item_guide", {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "name",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,name,short_description,sc_catalogs,category,active,sys_updated_on" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_order_guides",
    count: results.length,
    order_guides: results.map((r) => ({
      sys_id: r.sys_id,
      name: r.name,
      short_description: r.short_description,
      sc_catalogs: r.sc_catalogs,
      category: r.category,
      active: r.active,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=sc_cat_item_guide.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== CREATE_RECORD_PRODUCER ====================

async function executeCreateRecordProducer(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const name = args.name as string | undefined
  const table_name = args.table_name as string | undefined

  if (!name) return createErrorResult("name is required for create_record_producer")
  if (!table_name) {
    return createErrorResult("table_name is required for create_record_producer (target table the producer writes to)")
  }

  const client = await getAuthenticatedClient(context)

  // Reject duplicate by name (record producer names are commonly unique per catalog)
  const existing = await client.get("/api/now/table/sc_cat_item_producer", {
    params: { sysparm_query: `name=${name}`, sysparm_limit: 1, sysparm_fields: "sys_id" },
  })
  if ((existing.data.result || []).length > 0) {
    return createErrorResult(`Record producer '${name}' already exists. Use snow_artifact_manage to update it.`)
  }

  const payload: Record<string, unknown> = {
    name,
    short_description: (args.short_description as string) || "",
    description: (args.description as string) || "",
    table_name,
    active: args.active === undefined ? true : args.active,
  }
  if (args.script) payload.script = args.script
  if (args.sc_catalogs) payload.sc_catalogs = args.sc_catalogs
  if (args.category) payload.category = args.category

  // TODO: verify against live instance — some platforms also require `type` or
  // `sys_class_name` to differentiate the producer from a generic sc_cat_item.
  const response = await client.post("/api/now/table/sc_cat_item_producer", payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "create_record_producer",
    created: true,
    sys_id: created.sys_id,
    name: created.name,
    table_name: created.table_name,
    record_producer: created,
    url: `${context.instanceUrl}/nav_to.do?uri=sc_cat_item_producer.do?sys_id=${created.sys_id}`,
  })
}

// ==================== LIST_RECORD_PRODUCERS ====================

async function executeListRecordProducers(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const table_name = args.table_name as string | undefined
  const sc_catalogs = args.sc_catalogs as string | undefined
  const active_only = args.active_only === true
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (table_name) queryParts.push(`table_name=${table_name}`)
  if (sc_catalogs) queryParts.push(`sc_catalogsLIKE${sc_catalogs}`)
  if (active_only) queryParts.push("active=true")

  const response = await client.get("/api/now/table/sc_cat_item_producer", {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "name",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,name,short_description,table_name,sc_catalogs,category,active,sys_updated_on" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_record_producers",
    count: results.length,
    record_producers: results.map((r) => ({
      sys_id: r.sys_id,
      name: r.name,
      short_description: r.short_description,
      table_name: r.table_name,
      sc_catalogs: r.sc_catalogs,
      category: r.category,
      active: r.active,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=sc_cat_item_producer.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== LIST_CATEGORIES ====================

async function executeListCategories(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sc_catalogs = args.sc_catalogs as string | undefined
  const parent = args.parent as string | undefined
  const active_only = args.active_only === true
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (sc_catalogs) queryParts.push(`sc_catalog=${sc_catalogs}`)
  if (parent) queryParts.push(`parent=${parent}`)
  if (active_only) queryParts.push("active=true")

  const response = await client.get("/api/now/table/sc_category", {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "title",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,title,description,sc_catalog,parent,active,sys_updated_on" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_categories",
    count: results.length,
    categories: results.map((r) => ({
      sys_id: r.sys_id,
      title: r.title,
      description: r.description,
      sc_catalog: r.sc_catalog,
      parent: r.parent,
      active: r.active,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=sc_category.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== CREATE_CATEGORY ====================

async function executeCreateCategory(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const name = args.name as string | undefined
  const title = (args.title as string | undefined) || name
  if (!name) return createErrorResult("name is required for create_category")

  const client = await getAuthenticatedClient(context)

  // Reject duplicates within the same catalog when one is specified
  const dedupeQuery = args.sc_catalogs
    ? `title=${title}^sc_catalog=${args.sc_catalogs}`
    : `title=${title}`
  const existing = await client.get("/api/now/table/sc_category", {
    params: { sysparm_query: dedupeQuery, sysparm_limit: 1, sysparm_fields: "sys_id" },
  })
  if ((existing.data.result || []).length > 0) {
    return createErrorResult(`Category '${title}' already exists in this catalog`)
  }

  const payload: Record<string, unknown> = {
    title,
    description: (args.description as string) || (args.short_description as string) || "",
    active: args.active === undefined ? true : args.active,
  }
  if (args.sc_catalogs) payload.sc_catalog = args.sc_catalogs
  if (args.parent) payload.parent = args.parent
  // sc_category.homepage_renderer is mandatory — pass through when supplied so creates don't
  // fail on a "Mandatory field" validation. The caller can pre-resolve the OOB default renderer
  // sys_id (e.g. sc_homepage_renderer where name = 'Default').
  if (args.homepage_renderer) payload.homepage_renderer = args.homepage_renderer

  const response = await client.post("/api/now/table/sc_category", payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "create_category",
    created: true,
    sys_id: created.sys_id,
    title: created.title,
    category: created,
    url: `${context.instanceUrl}/nav_to.do?uri=sc_category.do?sys_id=${created.sys_id}`,
  })
}

// ==================== LINK_ITEM_TO_CATEGORY ====================

async function executeLinkItemToCategory(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const cat_item = args.cat_item as string | undefined
  const category_sys_id = args.category_sys_id as string | undefined

  if (!cat_item) return createErrorResult("cat_item is required (sc_cat_item sys_id)")
  if (!category_sys_id) return createErrorResult("category_sys_id is required (sc_category sys_id)")

  const client = await getAuthenticatedClient(context)

  // Avoid duplicate junction rows
  const existing = await client.get("/api/now/table/sc_cat_item_category", {
    params: {
      sysparm_query: `sc_cat_item=${cat_item}^sc_category=${category_sys_id}`,
      sysparm_limit: 1,
      sysparm_fields: "sys_id",
    },
  })
  const dup = (existing.data.result || []) as Array<Record<string, unknown>>
  if (dup.length > 0) {
    return createSuccessResult({
      action: "link_item_to_category",
      created: false,
      already_linked: true,
      link_sys_id: dup[0].sys_id,
      cat_item,
      category_sys_id,
    })
  }

  // TODO: verify against live instance — on some platforms the junction
  // columns are named `sc_cat_item` and `sc_category`, on others `cat_item`
  // and `category`. We use the more common short-name pair and surface any
  // server-side error verbatim.
  const response = await client.post("/api/now/table/sc_cat_item_category", {
    sc_cat_item: cat_item,
    sc_category: category_sys_id,
  })
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "link_item_to_category",
    created: true,
    link_sys_id: created.sys_id,
    cat_item,
    category_sys_id,
    junction: created,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
