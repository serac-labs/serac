/**
 * Governance client
 *
 * Thin fetch wrapper around three enterprise portal endpoints that back the
 * TUI/MCP governance hooks. All three are best-effort; failures never throw
 * because governance must not block the developer when the portal is
 * unreachable — only policy `allowed=false` should block.
 *
 *   evaluatePolicy  → POST /api/governance/policies/evaluate
 *   recordAudit     → POST /api/governance/ai-audit/record
 *   recordEdge      → POST /api/governance/dependency-intelligence/edges
 *
 * Base URL comes from env `SERAC_ENTERPRISE_URL` (or legacy
 * `SNOW_FLOW_ENTERPRISE_URL`, default `https://portal.serac.build`). The JWT
 * comes from env `SERAC_ENTERPRISE_TOKEN` (or legacy
 * `SNOW_FLOW_ENTERPRISE_TOKEN`). Without a token, every function silently
 * no-ops — keeps the OS build fully functional without enterprise auth.
 */

import { Log } from "@/util/log"

export namespace Governance {
  const log = Log.create({ service: "governance.client" })

  const DEFAULT_BASE = "https://portal.serac.build"

  function baseUrl(): string {
    return (process.env["SERAC_ENTERPRISE_URL"] || process.env["SNOW_FLOW_ENTERPRISE_URL"])?.trim() || DEFAULT_BASE
  }

  function token(): string | undefined {
    const t = (process.env["SERAC_ENTERPRISE_TOKEN"] || process.env["SNOW_FLOW_ENTERPRISE_TOKEN"])?.trim()
    return t && t.length > 0 ? t : undefined
  }

  export type PolicyDecision = {
    allowed: boolean
    blockers: Array<{ policyId: number; slug: string; name: string; reason: string }>
    warnings: Array<{ policyId: number; slug: string; name: string; reason: string }>
    info: Array<{ policyId: number; slug: string; name: string; reason: string }>
  }

  const ALLOWED_FALLBACK: PolicyDecision = {
    allowed: true,
    blockers: [],
    warnings: [],
    info: [],
  }

  /**
   * Evaluate a policy against an artifact. Returns `allowed=true` when the
   * portal is unreachable or no token is present — governance is fail-open on
   * infrastructure faults, fail-closed only on explicit `block` decisions.
   */
  export async function evaluatePolicy(
    artifactType: string,
    body: string,
    opts: { artifactRef?: string; instanceId?: number } = {},
  ): Promise<PolicyDecision> {
    const t = token()
    if (!t) return ALLOWED_FALLBACK

    const url = `${baseUrl()}/api/governance/policies/evaluate`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${t}`,
      },
      body: JSON.stringify({
        artifactType,
        artifactRef: opts.artifactRef,
        body,
        instanceId: opts.instanceId,
      }),
    }).catch((err) => {
      log.warn("policy evaluate request failed", { error: String(err) })
      return undefined
    })

    if (!res) return ALLOWED_FALLBACK
    // 403 = module not enabled for this org → treat as fail-open; governance
    // is simply not turned on.
    if (res.status === 403 || res.status === 404) return ALLOWED_FALLBACK
    if (!res.ok) {
      log.warn("policy evaluate returned non-ok", { status: res.status })
      return ALLOWED_FALLBACK
    }

    const json = (await res.json().catch(() => undefined)) as PolicyDecision | undefined
    if (!json || typeof json.allowed !== "boolean") return ALLOWED_FALLBACK
    return json
  }

  export type AuditResult = "success" | "blocked" | "error" | "overridden"

  export type AuditEvent = {
    eventType: string
    modelProvider: string
    modelId: string
    prompt: string
    inputTokens?: number
    outputTokens?: number
    toolsUsed?: string[]
    artifacts?: Array<{ type: string; ref?: string; diff?: string }>
    dataScope?: Record<string, unknown>
    resultStatus: AuditResult
    sessionId?: string
    instanceId?: number
  }

  /** Record an AI audit event. Best-effort: never throws, never blocks. */
  export async function recordAudit(event: AuditEvent): Promise<void> {
    const t = token()
    if (!t) return

    const url = `${baseUrl()}/api/governance/ai-audit/record`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${t}`,
      },
      body: JSON.stringify(event),
    }).catch((err) => {
      log.warn("audit record request failed", { error: String(err) })
      return undefined
    })

    if (!res) return
    if (!res.ok && res.status !== 403 && res.status !== 404) {
      log.warn("audit record returned non-ok", { status: res.status })
    }
  }

  export type ArtifactRef = { type: string; id: string }

  /** Record a dependency edge. Best-effort: never throws, never blocks. */
  export async function recordEdge(
    from: ArtifactRef,
    to: ArtifactRef,
    relationKind: string,
    opts: { instanceId?: number; confidence?: number } = {},
  ): Promise<void> {
    const t = token()
    if (!t) return
    // The enterprise endpoint requires instanceId. Without one we cannot
    // attribute the edge, so skip silently.
    if (!opts.instanceId) return

    const url = `${baseUrl()}/api/governance/dependency-intelligence/edges`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${t}`,
      },
      body: JSON.stringify({
        instanceId: opts.instanceId,
        from,
        to,
        relationKind,
        confidence: opts.confidence,
      }),
    }).catch((err) => {
      log.warn("edge record request failed", { error: String(err) })
      return undefined
    })

    if (!res) return
    if (!res.ok && res.status !== 403 && res.status !== 404) {
      log.warn("edge record returned non-ok", { status: res.status })
    }
  }

  /**
   * Feature flag lookup on the locally-stored enterprise auth. Mirrors the
   * same shape as `registry.ts#hasFeature` so we can expand the gated
   * feature set centrally.
   */
  export async function hasFeature(feature: string): Promise<boolean> {
    const { Auth } = await import("@/auth")
    const auths = await Auth.all().catch(() => ({}))
    for (const auth of Object.values(auths)) {
      if (auth.type === "enterprise" && auth.features?.includes(feature)) return true
    }
    return false
  }

  /** Known governance feature flags. Used by the tool-execution hooks. */
  export const Feature = {
    PolicyEngine: "policy-engine",
    AiAudit: "ai-audit",
    DependencyGraph: "dependency-graph",
  } as const

  /**
   * Classify a tool for governance hooks. Returns:
   *   - `artifactType` used by policy / dependency-graph
   *   - `body`          the string to evaluate against policies
   *   - `artifactRef`   optional ref (sys_id / name) of the touched artifact
   *   - `isWrite`       whether this tool mutates an artifact
   *
   * Returns undefined when the tool is out of governance scope (e.g. read,
   * grep). The classifier is intentionally broad: for servicenow write tools
   * we stringify the args, which gives policy matchers a readable body.
   */
  export function classifyTool(toolId: string, args: any): {
    artifactType: string
    body: string
    artifactRef?: string
    isWrite: boolean
  } | undefined {
    // Built-in local file mutators. These don't map to a ServiceNow artifact,
    // but policy engine can still match on body (e.g. "no secrets in commit").
    if (toolId === "write") {
      return {
        artifactType: "file",
        body: typeof args?.content === "string" ? args.content : "",
        artifactRef: typeof args?.filePath === "string" ? args.filePath : undefined,
        isWrite: true,
      }
    }
    if (toolId === "edit") {
      return {
        artifactType: "file",
        body: typeof args?.newString === "string" ? args.newString : "",
        artifactRef: typeof args?.filePath === "string" ? args.filePath : undefined,
        isWrite: true,
      }
    }
    if (toolId === "apply_patch") {
      return {
        artifactType: "file",
        body: typeof args?.input === "string" ? args.input : JSON.stringify(args ?? {}),
        isWrite: true,
      }
    }

    // ServiceNow MCP write tools: snow_create_*, snow_update_*, snow_delete_*,
    // snow_deploy_*, snow_edit_*. Reads match `snow_get_*`, `snow_list_*`,
    // `snow_query_*`, `snow_discover_*`, `snow_search_*` and are out of scope
    // for the policy gate but still recorded for dependency-graph if enabled.
    const snowWritePrefixes = ["snow_create_", "snow_update_", "snow_delete_", "snow_deploy_", "snow_edit_"]
    const snowReadPrefixes = ["snow_get_", "snow_list_", "snow_query_", "snow_discover_", "snow_search_"]
    const isSnowWrite = snowWritePrefixes.some((p) => toolId.startsWith(p))
    const isSnowRead = snowReadPrefixes.some((p) => toolId.startsWith(p))

    if (isSnowWrite || isSnowRead) {
      // Strip snow_{create|update|...}_ prefix to get the artifact kind.
      const rest = toolId.replace(/^snow_[a-z]+_/, "")
      const artifactRef =
        typeof args?.sys_id === "string"
          ? args.sys_id
          : typeof args?.name === "string"
          ? args.name
          : typeof args?.number === "string"
          ? args.number
          : undefined
      return {
        artifactType: rest || "servicenow_artifact",
        body: JSON.stringify(args ?? {}),
        artifactRef,
        isWrite: isSnowWrite,
      }
    }

    return undefined
  }
}
