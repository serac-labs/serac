/**
 * snow_url_doctor - Decode and construct ServiceNow URLs
 *
 * Two modes:
 *   decode - parse any ServiceNow URL and extract table, sys_id, view, sysparm_* params
 *   build  - construct a canonical URL from table + optional sys_id / filter / view
 *
 * Pure utility. No ServiceNow API calls.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_url_doctor",
  description:
    "Decode or construct ServiceNow URLs. Mode 'decode' parses an existing URL (nav_to.do, TABLE.do, workspace URLs) and extracts table, sys_id, view, and every sysparm_* parameter. Mode 'build' constructs a canonical form or list URL from table + sys_id/filter/view. Handy when agents need to hand the user a deep-link or reason about URL parameters.",
  category: "platform",
  subcategory: "utilities",
  use_cases: ["urls", "deep-links", "navigation", "debugging"],
  complexity: "beginner",
  frequency: "medium",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["decode", "build"],
        description: "'decode' parses a URL; 'build' constructs one",
      },
      url: {
        type: "string",
        description: "URL to decode (required for mode=decode)",
      },
      table: {
        type: "string",
        description: "Table name for mode=build (e.g. 'incident', 'sys_user')",
      },
      sys_id: {
        type: "string",
        description: "Record sys_id for mode=build. Use '-1' for a new-record form. Omit for list view.",
      },
      query: {
        type: "string",
        description: "sysparm_query filter for mode=build (list view). Example: 'state=1^assigned_to=javascript:gs.getUserID()'",
      },
      view: {
        type: "string",
        description: "Form/list view name for mode=build",
      },
    },
    required: ["mode"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const mode = args.mode as string

  if (mode === "decode") {
    return decode(args.url as string | undefined)
  }

  if (mode === "build") {
    return build(
      context.instanceUrl,
      args.table as string | undefined,
      args.sys_id as string | undefined,
      args.query as string | undefined,
      args.view as string | undefined,
    )
  }

  return createErrorResult(`Unknown mode '${mode}'. Use 'decode' or 'build'.`)
}

function decode(raw: string | undefined): ToolResult {
  if (!raw) return createErrorResult("Missing 'url' argument for mode=decode")

  const parsed = safeParse(raw)
  if (!parsed) return createErrorResult(`Could not parse URL: ${raw}`)

  const sysparms: Record<string, string> = {}
  const other: Record<string, string> = {}
  for (const [key, value] of parsed.searchParams.entries()) {
    if (key.startsWith("sysparm_")) {
      sysparms[key] = value
      continue
    }
    other[key] = value
  }

  const nested = extractNavTo(parsed, other)
  const path = nested.path || parsed.pathname

  const table = detectTable(path)
  const sysId = other.sys_id || sysparms.sysparm_sys_id || nested.sys_id

  const workspace = detectWorkspace(path)

  const result = {
    instance: parsed.origin,
    path,
    table,
    sys_id: sysId,
    view: sysparms.sysparm_view,
    query: sysparms.sysparm_query ? decodeURIComponent(sysparms.sysparm_query) : undefined,
    record_form: Boolean(table && sysId && sysId !== "-1"),
    new_record_form: sysId === "-1",
    list_view: Boolean(table && !sysId),
    workspace,
    sysparms,
    other_params: other,
  }

  return createSuccessResult(result, { mode: "decode" })
}

function build(
  instanceUrl: string,
  table: string | undefined,
  sysId: string | undefined,
  query: string | undefined,
  view: string | undefined,
): ToolResult {
  if (!table) return createErrorResult("Missing 'table' argument for mode=build")

  const base = instanceUrl.replace(/\/+$/, "")

  if (sysId) {
    const params = new URLSearchParams()
    params.set("sys_id", sysId)
    if (view) params.set("sysparm_view", view)
    return createSuccessResult(
      {
        url: `${base}/${table}.do?${params.toString()}`,
        kind: sysId === "-1" ? "new_record" : "record_form",
        table,
        sys_id: sysId,
      },
      { mode: "build" },
    )
  }

  const params = new URLSearchParams()
  if (query) params.set("sysparm_query", query)
  if (view) params.set("sysparm_view", view)

  const suffix = params.toString()
  const url = `${base}/${table}_list.do${suffix ? "?" + suffix : ""}`

  return createSuccessResult({ url, kind: "list_view", table, query, view }, { mode: "build" })
}

function safeParse(raw: string): URL | null {
  const tryParse = (value: string) => {
    const parsed = new URL(value)
    return parsed
  }

  const direct = tryDirect(raw, tryParse)
  if (direct) return direct

  return tryDirect(`https://${raw}`, tryParse)
}

function tryDirect(value: string, parser: (v: string) => URL): URL | null {
  let result: URL | null = null
  const attempt = () => {
    result = parser(value)
  }
  const guard = () => {
    result = null
  }
  runSafe(attempt, guard)
  return result
}

function runSafe(fn: () => void, onError: () => void): void {
  try {
    fn()
  } catch {
    onError()
  }
}

function extractNavTo(parsed: URL, other: Record<string, string>): { path?: string; sys_id?: string } {
  const uri = other.uri
  if (!uri) return {}
  const decoded = decodeURIComponent(uri)
  const [path, qs] = decoded.split("?")
  if (!qs) return { path }
  const inner = new URLSearchParams(qs)
  return { path, sys_id: inner.get("sys_id") || undefined }
}

function detectTable(path: string): string | undefined {
  const clean = path.replace(/^\/+/, "")
  const match = clean.match(/^([a-z0-9_]+)(?:_list)?\.do$/i)
  if (match) return match[1]
  return undefined
}

function detectWorkspace(path: string): string | undefined {
  const match = path.match(/\/now\/workspace\/([^\/]+)/)
  if (match) return match[1]
  return undefined
}

export const version = "1.0.0"
export const author = "Serac SDK"
