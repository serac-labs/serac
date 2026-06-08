/**
 * Instance map post-hook.
 *
 * After a successful write-tool execution, report the created/updated
 * ServiceNow artifact to the enterprise portal's instance-map so the
 * per-tenant graph stays in sync without relying on the agent prompt.
 *
 * The hook is best-effort: it never throws, and it silently skips when
 * the caller is not an authenticated enterprise user or the tool did
 * not produce an artifact reference.
 */

import { ToolResult, ServiceNowContext, MCPToolDefinition } from "./types.js"
import { loadEnterpriseAuth } from "./context-loader.js"
import { mcpDebug } from "../../shared/mcp-debug.js"

export type ReportPayload = {
  instanceUrl: string
  toolName: string
  action?: string
  artifact: {
    sysId: string
    type?: string
    name?: string
    url?: string
    table?: string
  }
  updateSet?: {
    sysId?: string
    name?: string
    url?: string
  }
  metadata?: Record<string, unknown>
}

export const SKIP_ACTIONS = new Set(["get", "find", "list", "analyze", "export", "verify"])

export function isWriteTool(definition: MCPToolDefinition | undefined): boolean {
  if (!definition) return false
  // Default permission is 'write' when omitted (most tools don't declare it)
  const perm = definition.permission ?? "write"
  return perm === "write" || perm === "admin"
}

function extractUpdateSet(result: ToolResult, args: Record<string, any>): ReportPayload["updateSet"] | undefined {
  const meta = result.metadata ?? {}
  const data = (result as any).data ?? {}
  const sysId =
    (typeof meta.updateSetId === "string" && meta.updateSetId) ||
    (typeof data.update_set_id === "string" && data.update_set_id) ||
    (typeof data.updateSetSysId === "string" && data.updateSetSysId) ||
    (typeof args.update_set_id === "string" && args.update_set_id) ||
    undefined
  const name =
    (typeof data.update_set_name === "string" && data.update_set_name) ||
    (typeof data.updateSetName === "string" && data.updateSetName) ||
    undefined
  if (!sysId && !name) return undefined
  return { sysId, name }
}

export function buildPayload(
  toolName: string,
  args: Record<string, any>,
  result: ToolResult,
  context: ServiceNowContext,
): ReportPayload | null {
  if (!result.success) return null
  const artifact = result.artifact
  if (!artifact?.sys_id) return null
  if (!context.instanceUrl) return null

  const data = (result as any).data ?? {}

  // Prefer an explicit `type` from tool args (snow_artifact_manage sets this
  // to the canonical kind) over the auto-detected wrapper key, which may
  // just be "artifact" or the nested table name.
  const explicitType =
    (typeof args.type === "string" && args.type) ||
    (typeof args.artifact_type === "string" && args.artifact_type) ||
    undefined

  // Normalize the action: a hard-delete tool result may not carry
  // `args.action` but sets `data.deleted === true`. Propagate "delete"
  // so the portal removes the node + edges instead of upserting.
  const action =
    (typeof args.action === "string" && args.action) ||
    (data.deleted === true ? "delete" : undefined)

  return {
    instanceUrl: context.instanceUrl,
    toolName,
    action,
    artifact: {
      sysId: artifact.sys_id,
      type: explicitType ?? artifact.type,
      name: artifact.name,
      url: artifact.url,
      table: artifact.table,
    },
    updateSet: extractUpdateSet(result, args),
  }
}

export interface TenantHint {
  customerId?: number
  organizationId?: number
}

/**
 * Pick the best available transport for the hook call:
 *   - `internal`: portal-chat / HTTP-MCP flow — uses MCP_INTERNAL_TOKEN and
 *     tenant headers. Works inside the portal's Docker network.
 *   - `bearer`: stdio-TUI flow — uses the device-auth JWT from
 *     ~/.snow-code/enterprise.json.
 *   - `none`: no auth available, silently skip.
 */
export function pickHookTransport(
  tenant: TenantHint | undefined,
  env: NodeJS.ProcessEnv,
): { kind: "internal"; url: string; token: string; tenantType: "customer" | "organization"; tenantId: number } | { kind: "bearer" } | { kind: "none" } {
  const internalToken = env.MCP_INTERNAL_TOKEN
  const portalUrl = env.PORTAL_BACKEND_URL
  if (internalToken && portalUrl && tenant) {
    if (typeof tenant.organizationId === "number" && tenant.organizationId > 0) {
      return { kind: "internal", url: portalUrl, token: internalToken, tenantType: "organization", tenantId: tenant.organizationId }
    }
    if (typeof tenant.customerId === "number" && tenant.customerId > 0) {
      return { kind: "internal", url: portalUrl, token: internalToken, tenantType: "customer", tenantId: tenant.customerId }
    }
  }
  return loadEnterpriseAuth() ? { kind: "bearer" } : { kind: "none" }
}

/**
 * Fire-and-forget post-hook. Never throws.
 */
export function reportArtifactToInstanceMap(
  toolName: string,
  args: Record<string, any>,
  result: ToolResult,
  context: ServiceNowContext,
  toolDefinition?: MCPToolDefinition,
  tenant?: TenantHint,
): void {
  if (!isWriteTool(toolDefinition)) return
  if (args && typeof args.action === "string" && SKIP_ACTIONS.has(args.action)) return

  const payload = buildPayload(toolName, args ?? {}, result, context)
  if (!payload) return

  const transport = pickHookTransport(tenant, process.env)
  if (transport.kind === "none") return

  // Don't block the tool response on the report round-trip.
  void postReport(transport, payload).catch((err) => {
    mcpDebug(`[InstanceMap] hook failed for ${toolName}: ${err?.message || err}`)
  })
}

type Transport = ReturnType<typeof pickHookTransport>

async function postReport(transport: Transport, payload: ReportPayload): Promise<void> {
  if (transport.kind === "none") return

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    let url: string
    const headers: Record<string, string> = { "Content-Type": "application/json" }

    if (transport.kind === "internal") {
      url = `${transport.url.replace(/\/+$/, "")}/api/instance-map/report-artifact`
      headers["X-Internal-Auth"] = transport.token
      headers["X-Tenant-Type"] = transport.tenantType
      headers["X-Tenant-Id"] = String(transport.tenantId)
    } else {
      // Bearer path: re-resolve auth so the JWT is fresh (loadEnterpriseAuth
      // validates expiry and falls through for expired tokens).
      const auth = loadEnterpriseAuth()
      if (!auth) return
      url = `${auth.portalUrl.replace(/\/+$/, "")}/api/instance-map/report-artifact`
      headers.Authorization = `Bearer ${auth.jwt}`
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      mcpDebug(`[InstanceMap] portal responded ${response.status}: ${text.slice(0, 200)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}
