/**
 * snow_sp_theme_manage - Unified Service Portal theme management
 *
 * Manages the visual identity of ServiceNow Service Portals across the
 * sp_theme (theme definitions), sp_brand (per-portal branding records),
 * sp_css (theme stylesheets), and sp_portal (portal records that reference
 * a theme) tables. Designed for white-labeling and multi-tenant scenarios
 * where the same portal codebase needs to render differently per customer.
 *
 * Companion to snow_create_sp_widget and snow_create_sp_page (which author
 * the per-portal content) — this tool covers the look-and-feel layer.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_sp_theme_manage",
  description: `Unified tool for ServiceNow Service Portal theming. Operates over sp_theme (theme definitions), sp_brand (per-portal branding records such as logo and favicon), sp_css (theme-scoped stylesheets), and sp_portal (the portal records that reference a theme).

Actions:
- list_themes — list all sp_theme records with their name, header, footer, and CSS variable bundle
- create_theme — create a new sp_theme with name, css_variables, header, and footer
- update_branding — upsert an sp_brand row (logo, favicon, color tokens) for a given portal; existing brand rows are patched in place, otherwise a new row is inserted
- clone_theme — duplicate an existing sp_theme (and its sp_css children) under a new name so a per-tenant variant can be edited independently of the source
- apply_theme_to_portal — set sp_portal.theme to a given theme sys_id so the portal renders with the new look on the next page load

Use when: rolling out white-labeled portals per tenant, building a base theme + per-customer overlays, or migrating an existing portal onto a redesigned theme without rewriting the underlying widgets. Companion tools: snow_create_sp_widget for content, snow_create_sp_page for page composition.

Returns: action-specific structures. list_themes returns theme rows with related CSS counts. create_theme and clone_theme return the new sys_id plus the copied sp_css rows. update_branding indicates whether the row was inserted or patched. apply_theme_to_portal returns the updated sp_portal record.`,
  category: "ui-frameworks",
  subcategory: "service-portal",
  use_cases: ["service-portal", "theming", "branding", "white-label", "multi-tenant"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Theme management action to perform",
        enum: [
          "list_themes",
          "create_theme",
          "update_branding",
          "clone_theme",
          "apply_theme_to_portal",
        ],
      },
      // THEME identification
      theme_sys_id: {
        type: "string",
        description: "[clone_theme/apply_theme_to_portal] sys_id of the source or target sp_theme",
      },
      theme_name: {
        type: "string",
        description: "[clone_theme/apply_theme_to_portal] Theme name (used when theme_sys_id is not provided)",
      },
      // CREATE_THEME / CLONE_THEME
      name: {
        type: "string",
        description: "[create_theme/clone_theme] Name for the new theme",
      },
      css_variables: {
        type: "string",
        description: "[create_theme] CSS variables block (e.g. --brand-primary: #ff6600;) compiled into the theme",
      },
      header: {
        type: "string",
        description: "[create_theme] Header widget id or HTML reference (defaults to OOB stock-header)",
      },
      footer: {
        type: "string",
        description: "[create_theme] Footer widget id or HTML reference (defaults to OOB stock-footer)",
      },
      copy_css: {
        type: "boolean",
        description: "[clone_theme] Also copy the source theme's sp_css children",
        default: true,
      },
      // UPDATE_BRANDING
      portal: {
        type: "string",
        description: "[update_branding/apply_theme_to_portal] sp_portal sys_id (or unique URL suffix) to brand or to apply the theme to",
      },
      logo: {
        type: "string",
        description: "[update_branding] Logo image URL or sys_attachment sys_id",
      },
      favicon: {
        type: "string",
        description: "[update_branding] Favicon URL or sys_attachment sys_id",
      },
      primary_color: {
        type: "string",
        description: "[update_branding] Primary brand color (hex, e.g. #1f6feb)",
      },
      secondary_color: {
        type: "string",
        description: "[update_branding] Secondary brand color (hex)",
      },
      brand_name: {
        type: "string",
        description: "[update_branding] Display brand name shown in headers and tab titles",
      },
      // LIST
      limit: {
        type: "number",
        description: "[list_themes] Maximum themes to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list_themes] Comma-separated list of fields to return",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list_themes":
        return await executeListThemes(args, context)
      case "create_theme":
        return await executeCreateTheme(args, context)
      case "update_branding":
        return await executeUpdateBranding(args, context)
      case "clone_theme":
        return await executeCloneTheme(args, context)
      case "apply_theme_to_portal":
        return await executeApplyThemeToPortal(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list_themes, create_theme, update_branding, clone_theme, apply_theme_to_portal`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `SP theme ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function findTheme(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string | undefined,
  name: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (sysId) {
    try {
      const direct = await client.get(`/api/now/table/sp_theme/${sysId}`)
      if (direct.data.result && direct.data.result.sys_id) return direct.data.result
    } catch {
      // fall through to name lookup
    }
  }
  if (name) {
    const search = await client.get("/api/now/table/sp_theme", {
      params: { sysparm_query: `name=${name}`, sysparm_limit: 1 },
    })
    const rows = (search.data.result || []) as Array<Record<string, unknown>>
    if (rows.length > 0) return rows[0]
  }
  return null
}

async function findPortal(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  portal: string,
): Promise<Record<string, unknown> | null> {
  // Try by sys_id first, then by URL suffix
  try {
    const direct = await client.get(`/api/now/table/sp_portal/${portal}`)
    if (direct.data.result && direct.data.result.sys_id) return direct.data.result
  } catch {
    // fall through
  }
  const search = await client.get("/api/now/table/sp_portal", {
    params: { sysparm_query: `url_suffix=${portal}^ORtitle=${portal}`, sysparm_limit: 1 },
  })
  const rows = (search.data.result || []) as Array<Record<string, unknown>>
  return rows.length > 0 ? rows[0] : null
}

// ==================== LIST_THEMES ====================

async function executeListThemes(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const response = await client.get("/api/now/table/sp_theme", {
    params: {
      sysparm_limit: limit,
      sysparm_orderby: "name",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,name,header,footer,css_variables,sys_updated_on" }),
    },
  })

  const themes = (response.data.result || []) as Array<Record<string, unknown>>

  // Annotate each theme with its sp_css child count (best-effort).
  // sp_css has no direct theme reference; the link goes via the m2m_sp_theme_css_include table.
  const enriched: Array<Record<string, unknown>> = []
  for (const theme of themes) {
    let cssCount = 0
    try {
      const cssResp = await client.get("/api/now/table/m2m_sp_theme_css_include", {
        params: { sysparm_query: `sp_theme=${theme.sys_id}`, sysparm_fields: "sys_id", sysparm_limit: 100 },
      })
      cssCount = (cssResp.data.result || []).length
    } catch {
      // best-effort — older releases may name the m2m table or columns differently
    }
    enriched.push({
      sys_id: theme.sys_id,
      name: theme.name,
      header: theme.header,
      footer: theme.footer,
      css_variables: theme.css_variables,
      css_include_count: cssCount,
      updated_at: theme.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=sp_theme.do?sys_id=${theme.sys_id}`,
    })
  }

  return createSuccessResult({
    action: "list_themes",
    count: enriched.length,
    themes: enriched,
  })
}

// ==================== CREATE_THEME ====================

async function executeCreateTheme(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const name = args.name as string | undefined
  if (!name) return createErrorResult("name is required for create_theme")

  const client = await getAuthenticatedClient(context)

  const existing = await client.get("/api/now/table/sp_theme", {
    params: { sysparm_query: `name=${name}`, sysparm_limit: 1, sysparm_fields: "sys_id" },
  })
  if ((existing.data.result || []).length > 0) {
    return createErrorResult(`Theme '${name}' already exists. Use clone_theme for a variant.`)
  }

  const payload: Record<string, unknown> = { name }
  if (args.css_variables) payload.css_variables = args.css_variables
  if (args.header) payload.header = args.header
  if (args.footer) payload.footer = args.footer

  const response = await client.post("/api/now/table/sp_theme", payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "create_theme",
    created: true,
    sys_id: created.sys_id,
    name: created.name,
    theme: created,
    url: `${context.instanceUrl}/nav_to.do?uri=sp_theme.do?sys_id=${created.sys_id}`,
  })
}

// ==================== UPDATE_BRANDING ====================

async function executeUpdateBranding(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const portalRef = args.portal as string | undefined
  if (!portalRef) return createErrorResult("portal is required for update_branding (sp_portal sys_id or url_suffix)")

  const client = await getAuthenticatedClient(context)

  const portal = await findPortal(client, portalRef)
  if (!portal) return createErrorResult(`Portal not found: ${portalRef}`)

  const portalSysId = portal.sys_id as string

  // sp_brand is not present on most ServiceNow releases — branding fields live
  // directly on sp_portal (logo, css_variables, title, ...). Patch the portal row
  // with the supplied branding overrides.
  const portalPatch: Record<string, unknown> = {}
  if (args.logo !== undefined) portalPatch.logo = args.logo
  if (args.brand_name !== undefined) portalPatch.title = args.brand_name
  // Roll primary/secondary color hints into css_variables when supplied alongside
  // any existing tokens, so theme stylesheets can pick them up.
  const colorTokens: string[] = []
  if (args.primary_color !== undefined) colorTokens.push(`--brand-primary: ${args.primary_color};`)
  if (args.secondary_color !== undefined) colorTokens.push(`--brand-secondary: ${args.secondary_color};`)
  if (args.favicon !== undefined) colorTokens.push(`/* favicon: ${args.favicon} */`)
  if (colorTokens.length > 0) {
    const existing = (portal.css_variables as string) || ""
    portalPatch.css_variables = existing ? `${existing}\n${colorTokens.join("\n")}` : colorTokens.join("\n")
  }

  if (Object.keys(portalPatch).length === 0) {
    return createErrorResult("No branding fields supplied (logo, favicon, primary_color, secondary_color, brand_name)")
  }

  const updResp = await client.patch(`/api/now/table/sp_portal/${portalSysId}`, portalPatch)
  const updatedPortal = updResp.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "update_branding",
    mode: "patched",
    portal: { sys_id: portalSysId, title: updatedPortal.title, url_suffix: updatedPortal.url_suffix },
    sys_id: portalSysId,
    portal_record: updatedPortal,
    note: "Branding written to sp_portal (sp_brand is not a standard ServiceNow table). favicon is recorded as a comment in css_variables only.",
    url: `${context.instanceUrl}/nav_to.do?uri=sp_portal.do?sys_id=${portalSysId}`,
  })
}

// ==================== CLONE_THEME ====================

async function executeCloneTheme(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sourceSysId = args.theme_sys_id as string | undefined
  const sourceName = args.theme_name as string | undefined
  const newName = args.name as string | undefined
  const copyCss = args.copy_css === undefined ? true : args.copy_css === true

  if (!newName) return createErrorResult("name is required for clone_theme (target theme name)")
  if (!sourceSysId && !sourceName) {
    return createErrorResult("theme_sys_id or theme_name is required for clone_theme")
  }

  const client = await getAuthenticatedClient(context)

  const source = await findTheme(client, sourceSysId, sourceName)
  if (!source) return createErrorResult(`Source theme not found: ${sourceSysId || sourceName}`)

  // Reject if target name is taken
  const dup = await client.get("/api/now/table/sp_theme", {
    params: { sysparm_query: `name=${newName}`, sysparm_limit: 1, sysparm_fields: "sys_id" },
  })
  if ((dup.data.result || []).length > 0) {
    return createErrorResult(`Theme '${newName}' already exists`)
  }

  // Copy theme fields except sys_*, name
  const themePayload: Record<string, unknown> = { name: newName }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("sys_")) continue
    if (key === "name") continue
    if (value === null || value === undefined) continue
    themePayload[key] = value
  }

  const newThemeResp = await client.post("/api/now/table/sp_theme", themePayload)
  const newTheme = newThemeResp.data.result as Record<string, unknown>

  // Copy sp_css includes if requested. The link from sp_theme to sp_css is the
  // m2m_sp_theme_css_include join table — copy the join rows (pointing at the same
  // sp_css rows) instead of duplicating the CSS rows themselves.
  const copiedCss: Array<Record<string, unknown>> = []
  if (copyCss) {
    try {
      const linkResp = await client.get("/api/now/table/m2m_sp_theme_css_include", {
        params: { sysparm_query: `sp_theme=${source.sys_id}`, sysparm_limit: 200 },
      })
      const rows = (linkResp.data.result || []) as Array<Record<string, unknown>>
      for (const row of rows) {
        const payload: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(row)) {
          if (key.startsWith("sys_")) continue
          if (value === null || value === undefined) continue
          payload[key] = value
        }
        payload.sp_theme = newTheme.sys_id
        const inserted = await client.post("/api/now/table/m2m_sp_theme_css_include", payload)
        copiedCss.push({ sys_id: inserted.data.result.sys_id })
      }
    } catch {
      // m2m copy is best-effort; the new theme still exists even if includes fail
    }
  }

  return createSuccessResult({
    action: "clone_theme",
    created: true,
    sys_id: newTheme.sys_id,
    name: newTheme.name,
    source: { sys_id: source.sys_id, name: source.name },
    theme: newTheme,
    cloned_css_count: copiedCss.length,
    cloned_css: copiedCss,
    url: `${context.instanceUrl}/nav_to.do?uri=sp_theme.do?sys_id=${newTheme.sys_id}`,
  })
}

// ==================== APPLY_THEME_TO_PORTAL ====================

async function executeApplyThemeToPortal(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const portalRef = args.portal as string | undefined
  const themeSysId = args.theme_sys_id as string | undefined
  const themeName = args.theme_name as string | undefined

  if (!portalRef) return createErrorResult("portal is required for apply_theme_to_portal")
  if (!themeSysId && !themeName) {
    return createErrorResult("theme_sys_id or theme_name is required for apply_theme_to_portal")
  }

  const client = await getAuthenticatedClient(context)

  const portal = await findPortal(client, portalRef)
  if (!portal) return createErrorResult(`Portal not found: ${portalRef}`)

  const theme = await findTheme(client, themeSysId, themeName)
  if (!theme) return createErrorResult(`Theme not found: ${themeSysId || themeName}`)

  const portalSysId = portal.sys_id as string

  // sp_portal.theme is the canonical reference; some OOB releases also use
  // a denormalized theme_name column which is regenerated on save.
  const updResp = await client.patch(`/api/now/table/sp_portal/${portalSysId}`, { theme: theme.sys_id })
  const updated = updResp.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "apply_theme_to_portal",
    updated: true,
    portal: { sys_id: portalSysId, title: updated.title, url_suffix: updated.url_suffix, theme: updated.theme },
    theme: { sys_id: theme.sys_id, name: theme.name },
    url: `${context.instanceUrl}/nav_to.do?uri=sp_portal.do?sys_id=${portalSysId}`,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
