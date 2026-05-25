import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import { btk } from "../../shared/builder-toolkit.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_uib_page_manage",
  description: "Unified UIB page management (create via Builder Toolkit, delete, add_element, remove_element)",
  category: "ui-builder",
  subcategory: "pages",
  use_cases: ["ui-builder", "pages", "components"],
  complexity: "intermediate",
  frequency: "high",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Page management action",
        enum: ["create", "delete", "add_element", "remove_element"],
      },
      experience_id: { type: "string", description: "[create] Experience sys_id (required for create)" },
      name: { type: "string", description: "[create] Page name (internal identifier)" },
      title: { type: "string", description: "[create] Page title (display name)" },
      description: { type: "string", description: "[create] Page description" },
      route_type: { type: "string", description: '[create] Route type (default: "template-sow")' },
      template_id: { type: "string", description: "[create] Template sys_id for page layout" },
      roles: { type: "array", items: { type: "string" }, description: "[create] Required roles to access page" },
      public: { type: "boolean", description: "[create] Make page publicly accessible" },
      page_id: { type: "string", description: "[delete/add_element/remove_element] Page sys_id" },
      force: { type: "boolean", description: "[delete/remove_element] Force operation ignoring dependencies" },
      delete_dependencies: { type: "boolean", description: "[delete] Delete associated dependencies" },
      component: { type: "string", description: "[add_element] Component name or sys_id" },
      container_id: { type: "string", description: "[add_element] Parent container element ID" },
      position: { type: "number", description: "[add_element] Element position in container" },
      properties: { type: "object", description: "[add_element] Component properties" },
      data_broker: { type: "string", description: "[add_element] Data broker sys_id" },
      responsive_config: { type: "object", description: "[add_element] Responsive layout config" },
      conditional_display: { type: "string", description: "[add_element] Condition script for visibility" },
      css_classes: { type: "array", items: { type: "string" }, description: "[add_element] CSS classes to apply" },
      inline_styles: { type: "object", description: "[add_element] Inline styles config" },
      element_id: { type: "string", description: "[remove_element] Page element sys_id to remove" },
      check_dependencies: { type: "boolean", description: "[remove_element] Check for dependent elements" },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "create":
        return await executeCreate(args, context)
      case "delete":
        return await executeDelete(args, context)
      case "add_element":
        return await executeAddElement(args, context)
      case "remove_element":
        return await executeRemoveElement(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: unknown) {
    return createErrorResult(error instanceof Error ? error.message : String(error))
  }
}

async function executeCreate(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const experienceId = args.experience_id as string
  const name = args.name as string
  const routeType = (args.route_type as string) || "template-sow"
  const templateId = (args.template_id as string) || ""

  if (!experienceId) return createErrorResult("experience_id required for create action")
  if (!name) return createErrorResult("name required")

  const client = await getAuthenticatedClient(context)

  const response = await client.post(btk(`/page?experienceId=${experienceId}`), {
    screen: {
      name,
      screenType: "",
      macroponent: null,
      disableAutoReflow: false,
    },
    route: {
      name,
      routeType,
      fields: ["table", "sysId"],
      optionalParameters: ["query", "extraParams", "views", "selectedTab"],
    },
    applicabilities: [],
    templateId,
    macroponent: {},
  })

  const result = response.data?.result || response.data

  return createSuccessResult({
    action: "create",
    page: {
      name,
      experience_id: experienceId,
      macroponent: result.macroponent || result.macroponentID,
      screen: result.screen || result.screenID,
      route: result.route || result.routeID,
    },
  })
}

async function executeDelete(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const pageId = args.page_id as string
  const deleteDeps = args.delete_dependencies !== false

  if (!pageId) return createErrorResult("page_id required")

  const client = await getAuthenticatedClient(context)

  const elements: Array<Record<string, unknown>> = []
  const brokers: Array<Record<string, unknown>> = []
  const scripts: Array<Record<string, unknown>> = []
  const routes: Array<Record<string, unknown>> = []

  if (deleteDeps) {
    const [elementsRes, brokersRes, scriptsRes, routesRes] = await Promise.all([
      client.get("/api/now/table/sys_ux_page_element", { params: { sysparm_query: `page=${pageId}` } }),
      client.get("/api/now/table/sys_ux_data_broker", { params: { sysparm_query: `page=${pageId}` } }),
      client.get("/api/now/table/sys_ux_client_script", { params: { sysparm_query: `page=${pageId}` } }),
      client.get("/api/now/table/sys_ux_app_route", { params: { sysparm_query: `page=${pageId}` } }),
    ])

    elements.push(...(elementsRes.data.result || []))
    brokers.push(...(brokersRes.data.result || []))
    scripts.push(...(scriptsRes.data.result || []))
    routes.push(...(routesRes.data.result || []))

    const deletes = [
      ...elements.map((e) => client.delete(`/api/now/table/sys_ux_page_element/${e.sys_id}`)),
      ...brokers.map((e) => client.delete(`/api/now/table/sys_ux_data_broker/${e.sys_id}`)),
      ...scripts.map((e) => client.delete(`/api/now/table/sys_ux_client_script/${e.sys_id}`)),
      ...routes.map((e) => client.delete(`/api/now/table/sys_ux_app_route/${e.sys_id}`)),
    ]
    await Promise.all(deletes)
  }

  await client.delete(`/api/now/table/sys_ux_page/${pageId}`)

  return createSuccessResult({
    action: "delete",
    deleted: true,
    page_id: pageId,
    dependencies_deleted: {
      elements: elements.length,
      data_brokers: brokers.length,
      client_scripts: scripts.length,
      routes: routes.length,
    },
  })
}

async function executeAddElement(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const pageId = args.page_id as string
  const component = args.component as string
  const position = (args.position as number) || 0

  if (!pageId) return createErrorResult("page_id required")
  if (!component) return createErrorResult("component required")

  const client = await getAuthenticatedClient(context)

  const payload: Record<string, unknown> = {
    page: pageId,
    component,
    position,
  }

  if (args.container_id) payload.container = args.container_id
  const props = args.properties as Record<string, unknown> | undefined
  if (props && Object.keys(props).length > 0) payload.properties = JSON.stringify(props)
  if (args.data_broker) payload.data_broker = args.data_broker
  const responsive = args.responsive_config as Record<string, unknown> | undefined
  if (responsive) payload.responsive_config = JSON.stringify(responsive)
  if (args.conditional_display) payload.conditional_display = args.conditional_display
  const classes = args.css_classes as string[] | undefined
  if (classes && classes.length > 0) payload.css_classes = classes.join(",")
  const styles = args.inline_styles as Record<string, unknown> | undefined
  if (styles && Object.keys(styles).length > 0) payload.inline_styles = JSON.stringify(styles)

  const response = await client.post("/api/now/table/sys_ux_page_element", payload)

  return createSuccessResult({
    action: "add_element",
    element: {
      sys_id: response.data.result.sys_id,
      page_id: pageId,
      component,
      position,
    },
  })
}

async function executeRemoveElement(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const pageId = args.page_id as string
  const elementId = args.element_id as string
  const force = args.force === true
  const checkDeps = args.check_dependencies !== false

  if (!pageId) return createErrorResult("page_id required")
  if (!elementId) return createErrorResult("element_id required")

  const client = await getAuthenticatedClient(context)

  const pageRes = await client.get(`/api/now/table/sys_ux_page/${pageId}`).catch(() => null)
  if (!pageRes?.data?.result) return createErrorResult("UI Builder page not found")

  const elemRes = await client.get(`/api/now/table/sys_ux_page_element/${elementId}`).catch(() => null)
  if (!elemRes?.data?.result) return createErrorResult("Page element not found")

  if (checkDeps && !force) {
    const deps = await checkElementDependencies(client, elementId, pageId)
    if (deps.length > 0) {
      return createErrorResult(
        `Cannot remove element: ${deps.length} dependent element(s) found. Use force=true to override.`,
      )
    }
  }

  await client.delete(`/api/now/table/sys_ux_page_element/${elementId}`)

  return createSuccessResult({
    action: "remove_element",
    removed: true,
    element_id: elementId,
    page_id: pageId,
    element_name: elemRes.data.result.name,
    force_used: force,
  })
}

async function checkElementDependencies(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  elementId: string,
  pageId: string,
): Promise<unknown[]> {
  const deps: unknown[] = []

  try {
    const [elementsRes, brokersRes, eventsRes] = await Promise.all([
      client.get("/api/now/table/sys_ux_page_element", {
        params: {
          sysparm_query: `page=${pageId}^parent_element=${elementId}`,
          sysparm_fields: "sys_id,name,component",
        },
      }),
      client.get("/api/now/table/sys_ux_data_broker", {
        params: { sysparm_query: `page=${pageId}^element=${elementId}`, sysparm_fields: "sys_id,name" },
      }),
      client.get("/api/now/table/sys_ux_event", {
        params: {
          sysparm_query: `page=${pageId}^source_element=${elementId}`,
          sysparm_fields: "sys_id,name,event_type",
        },
      }),
    ])

    for (const child of elementsRes.data.result || []) deps.push({ type: "child_element", ...child })
    for (const broker of brokersRes.data.result || []) deps.push({ type: "data_broker", ...broker })
    for (const event of eventsRes.data.result || []) deps.push({ type: "event", ...event })
  } catch {
    // noop
  }

  return deps
}

export const version = "2.0.0"
export const author = "Serac Builder Toolkit Migration"
