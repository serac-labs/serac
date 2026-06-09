import path from "path"
import fs from "fs"
import os from "os"
import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"

const log = Log.create({ service: "plugin.serac" })

// The Serac dashboard — the PRIMARY enterprise auth surface. The user logs into
// dashboard.serac.build via device authorization, receives a JWT, and that JWT
// drives the enterprise-proxy MCP server through which the platform brokers
// ServiceNow + ALL integrations.
const PORTAL_URL = "https://dashboard.serac.build"

// How long to wait on the dashboard when fetching the user's LLM providers in
// the config hook. The hook runs on the startup path, so a stuck request must
// not block the TUI — on timeout we silently fall back to local config.
const LLM_FETCH_TIMEOUT = 10000

// True when running as a bun-compiled single-file binary (execPath is the serac
// binary, not the bun/node runtime). Same probe as the servicenow plugin — used
// to pick how the bundled enterprise-proxy MCP server is launched.
function isCompiledBinary(): boolean {
  const base = path.basename(process.execPath)
  return base !== "bun" && base !== "node"
}

// Read the JWT stored by the device-auth method below (an "api" auth record:
// key = JWT, metadata = portal/user info) straight from auth.json. The config
// hook runs early, so we avoid the Effect-based Auth service and read the file
// directly — exactly how the servicenow plugin reads its own creds.
function readStoredSeracAuth(): { token: string; portalUrl: string } | undefined {
  try {
    const raw =
      process.env["OPENCODE_AUTH_CONTENT"] ?? fs.readFileSync(path.join(Global.Path.data, "auth.json"), "utf8")
    const data = JSON.parse(raw) as Record<string, { type?: string; key?: string; metadata?: Record<string, string> }>
    const entry = data["serac"]
    if (!entry || entry.type !== "api" || !entry.key) return undefined
    return { token: entry.key, portalUrl: entry.metadata?.["portalUrl"] || PORTAL_URL }
  } catch {
    return undefined
  }
}

// One BYOK AI provider as the dashboard exposes it to a CLI. Mirrors the platform
// route GET /api/chat/providers/for-cli (portal/backend/src/routes/chat.ts): the
// decrypted api key, the optional custom endpoint, whether the user marked it the
// default, and a free-form config blob whose `defaultModel` holds the exact model
// id the user picked in the dashboard's provider settings.
interface DashboardLlmProvider {
  providerType: string
  apiKey: string
  endpointUrl?: string | null
  isDefault?: boolean
  config?: Record<string, unknown> | null
}

// Pull the user's BYOK AI providers + selected model from the dashboard, keyed by
// the stored enterprise JWT. This is the SAME endpoint the previous fork hit from
// provider/provider.ts (PortalSync.fetchAiProvidersFromPortal) — re-expressed here
// so the config hook can prefill the model right after the dashboard device-auth.
// Returns providers ordered is_default-first (the platform sorts that way), so the
// first isDefault entry is the user's chosen model. Network/HTTP failures are
// swallowed: local config keeps working and the user can still pick a model.
async function fetchDashboardLlmProviders(
  portalUrl: string,
  token: string,
): Promise<DashboardLlmProvider[]> {
  try {
    const parsed = new URL(portalUrl)
    // SECURITY: only ship the JWT over HTTPS (localhost excepted for dev).
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      log.warn("refusing to fetch dashboard LLM providers over non-HTTPS", { portalUrl })
      return []
    }
    const response = await fetch(`${portalUrl}/api/chat/providers/for-cli`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(LLM_FETCH_TIMEOUT),
    })
    if (!response.ok) {
      log.warn("dashboard LLM providers fetch failed", { status: response.status })
      return []
    }
    const data = (await response.json()) as { providers?: DashboardLlmProvider[] }
    return data.providers ?? []
  } catch (error) {
    log.warn("dashboard LLM providers fetch error", { error: String(error) })
    return []
  }
}

// The dashboard stores the user's chosen model id under config.defaultModel (set
// by the frontend's LLMProviderSettings save). Read it defensively — config is a
// free-form blob.
function modelIdFromConfig(config: DashboardLlmProvider["config"]): string | undefined {
  if (!config || typeof config !== "object") return undefined
  const model = (config as Record<string, unknown>)["defaultModel"]
  return typeof model === "string" && model.trim() ? model.trim() : undefined
}

// Mirror of the home-dir resolution the enterprise-proxy uses (servicenow-mcp's
// serac-home): the JWT cache lives at ~/.serac/enterprise.json (legacy installs
// kept it at ~/.snow-code/enterprise.json — the proxy reads both, newest first).
// We always write the new location so fresh installs land there.
function writeEnterpriseTokenCache(token: string): void {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
    const dir = path.join(home, ".serac")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "enterprise.json"),
      JSON.stringify({ subdomain: "dashboard", token }, null, 2),
      "utf8",
    )
  } catch (error) {
    // The env var (SNOW_LICENSE_KEY) is the primary token path for the proxy;
    // this file is only a freshness cache, so a write failure is non-fatal.
    log.warn("failed to write ~/.serac/enterprise.json token cache", { error })
  }
}

// Shapes returned by the dashboard device-auth endpoints (portal backend
// routes/auth.ts: POST /api/auth/device/{request,verify}).
interface DeviceRequestResponse {
  success?: boolean
  sessionId: string
  verificationUrl: string
  expiresIn?: number
}

interface DeviceVerifyResponse {
  success?: boolean
  status?: string
  error?: string
  message?: string
  billingUrl?: string
  token?: string
  user?: { username?: string; email?: string; name?: string; role?: string }
  features?: string[]
  subscription?: { status?: string; plan?: string; trialEndsAt?: number }
}

// Serac Dashboard auth as a bundled AuthHook plugin. Ported from the previous
// fork's dialog-auth.tsx DialogAuthEnterprise device-auth flow, re-expressed for
// upstream 1.16's declarative AuthHook so the generic dialog-provider renders it.
//
// The dashboard is NOT an LLM provider — this plugin only COLLECTS + STORES the
// JWT (+ portal/user metadata) under the "serac" provider, plus a freshness
// cache at ~/.serac/enterprise.json. The JWT is consumed downstream by the
// enterprise-proxy MCP server injected by the config hook below. Hence no
// `loader`.
//
// METHOD CHOICE: this is a `code` method, not `auto`. The dashboard's
// /api/auth/device/verify endpoint REQUIRES the authorization code the user sees
// in the browser (it 401s on mismatch) — an `auto` callback can't collect that
// code. So we surface the verification URL + instructions, take the code, and
// poll verify (retrying on HTTP 202 "pending" while the browser approval lands).
//
// NEEDS RUNTIME VERIFICATION: (1) the exact `user` shape varies (portal users:
// {id,email,name}; enterprise users: {id,username,email,role}) — we read both;
// (2) that the generic /auth dialog renders the verification URL as a clickable
// link; (3) end-to-end token exchange against the live dashboard.

export async function SeracDashboardAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "serac",
      methods: [
        {
          type: "oauth",
          label: "Serac Dashboard (dashboard.serac.build)",
          authorize: async () => {
            const machineInfo = `${os.hostname()} (${os.platform()} ${os.arch()})`

            const response = await fetch(`${PORTAL_URL}/api/auth/device/request`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ machineInfo }),
            })
            if (!response.ok) {
              const err = (await response.json().catch(() => ({}))) as { error?: string }
              throw new Error(err.error || "Failed to start Serac dashboard authorization")
            }

            const data = (await response.json()) as DeviceRequestResponse
            const sessionId = data.sessionId
            const verificationUrl = data.verificationUrl

            return {
              url: verificationUrl,
              instructions:
                "Approve this device in your browser, then enter the authorization code shown there.",
              method: "code" as const,
              callback: async (code: string) => {
                const authCode = (code ?? "").trim().toUpperCase()
                if (!authCode) return { type: "failed" as const }

                // Retry while the browser approval is still pending (the verify
                // endpoint returns HTTP 202 / {status:"pending"} until then).
                const maxAttempts = 5
                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                  const verify = await fetch(`${PORTAL_URL}/api/auth/device/verify`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ sessionId, authCode }),
                  })
                  const verifyData = (await verify.json().catch(() => ({}))) as DeviceVerifyResponse

                  const isPending =
                    verify.status === 202 || verifyData.status === "pending" || verifyData.error === "pending"
                  if (isPending && attempt < maxAttempts) {
                    await new Promise((r) => setTimeout(r, 2000))
                    continue
                  }

                  if (verify.ok && !isPending && verifyData.token) {
                    const token = verifyData.token
                    writeEnterpriseTokenCache(token)
                    return {
                      type: "success" as const,
                      key: token,
                      // metadata is the only string-map slot — stash everything
                      // the config hook / UI surfaces want. Values are stringified.
                      metadata: {
                        portalUrl: PORTAL_URL,
                        username: verifyData.user?.username || verifyData.user?.name || verifyData.user?.email || "",
                        email: verifyData.user?.email || "",
                        role: verifyData.user?.role || "",
                        features: (verifyData.features || []).join(","),
                        subscriptionStatus: verifyData.subscription?.status || "",
                        trialEndsAt:
                          verifyData.subscription?.trialEndsAt != null
                            ? String(verifyData.subscription.trialEndsAt)
                            : "",
                      },
                    }
                  }

                  // A billing block is terminal — surface nothing retryable.
                  if (verifyData.billingUrl) {
                    log.error("serac dashboard auth blocked by billing", {
                      message: verifyData.message || verifyData.error,
                    })
                    return { type: "failed" as const }
                  }

                  log.error("serac dashboard device verify failed", {
                    status: verify.status,
                    error: verifyData.error,
                  })
                  return { type: "failed" as const }
                }

                return { type: "failed" as const }
              },
            }
          },
        },
      ],
    },
    // ENTERPRISE MODE: when a dashboard JWT is stored, the config hook does two
    // independent things, each guarded on its own so neither short-circuits the
    // other:
    //
    //   (1) MCP — inject the `serac-enterprise` MCP server (the enterprise-proxy).
    //       The platform brokers ServiceNow + ALL integrations behind this single
    //       proxy, keyed by the JWT.
    //
    //   (2) MODEL PREFILL — fetch the user's BYOK AI providers + their selected
    //       model from the dashboard and inject them so the dashboard model is the
    //       active/default model. This is why, after the dashboard login, the user
    //       no longer has to pick a model manually (the TUI also skips the picker
    //       for the "serac" provider — see runProviderAuth in
    //       packages/tui/src/component/dialog-provider.tsx).
    //
    // This runs alongside (not instead of) the servicenow plugin's own config
    // hook, which injects the DIRECT servicenow MCP for the manual OAuth/Basic
    // path. Both config hooks compose against the same resolved config.
    config: async (config) => {
      const auth = readStoredSeracAuth()
      if (!auth) return

      // (1) MCP server injection.
      const mcpTarget = config as { mcp?: Record<string, unknown> }
      mcpTarget.mcp ??= {}
      if (!mcpTarget.mcp["serac-enterprise"]) {
        mcpTarget.mcp["serac-enterprise"] = {
          type: "local",
          // In a compiled binary the package's enterprise-proxy bin isn't on
          // PATH, so route through the hidden in-process subcommand (mirrors how
          // the servicenow plugin launches x-servicenow-mcp).
          command: isCompiledBinary()
            ? [process.execPath, "x-servicenow-enterprise"]
            : ["servicenow-mcp-enterprise-proxy"],
          environment: {
            SNOW_PORTAL_URL: auth.portalUrl,
            // The proxy treats a JWT here as a direct device-auth token (no
            // license-key exchange). It also re-reads ~/.serac/enterprise.json on
            // each call to pick up a fresher token after re-auth.
            SNOW_LICENSE_KEY: auth.token,
          },
          enabled: true,
        }
      }

      // (2) Model prefill from the dashboard's BYOK LLM providers.
      await injectDashboardModel(config, auth)
    },
  }
}

// Inject the user's dashboard BYOK providers + selected model into the resolved
// config so the dashboard model becomes the active/default model with no manual
// pick. This mirrors how the previous fork merged PortalSync.fetchAiProvidersFromPortal
// results into the provider list, re-expressed as a 1.16 config() mutation:
//
//   - For each provider the dashboard returns, set cfg.provider[type].options.apiKey
//     (+ baseURL when a custom endpoint is configured). For a models.dev provider
//     (openai, anthropic, …) this merges into the existing catalog entry, so all
//     its models stay available and the BYOK key makes them usable. We do NOT
//     overwrite a provider that already has an apiKey in local config — local
//     config wins (the enterprise key is the lowest-priority fallback, same as the
//     fork).
//   - Set cfg.model = "<providerType>/<defaultModel>" from the default provider so
//     Provider.defaultModel() (which reads cfg.model first) resolves to it. We only
//     set it when the user hasn't already pinned a model in local config.
async function injectDashboardModel(
  config: Config,
  auth: { token: string; portalUrl: string },
): Promise<void> {
  const providers = await fetchDashboardLlmProviders(auth.portalUrl, auth.token)
  if (providers.length === 0) return

  const target = config as Config & { provider?: Record<string, any>; model?: string }
  target.provider ??= {}

  for (const p of providers) {
    if (!p.providerType || !p.apiKey) continue
    const existing = target.provider[p.providerType]
    // Local config wins: don't clobber an apiKey the user already configured.
    if (existing?.options?.apiKey) continue
    const options: Record<string, unknown> = { ...existing?.options, apiKey: p.apiKey }
    if (p.endpointUrl) options["baseURL"] = p.endpointUrl
    target.provider[p.providerType] = { ...existing, options }
  }

  // Respect an explicit local model pin; otherwise prefill from the dashboard's
  // default provider (the platform returns providers is_default-first, so the
  // first one carrying a model id is the user's choice).
  if (target.model) return
  const chosen =
    providers.find((p) => p.isDefault && p.providerType && modelIdFromConfig(p.config)) ??
    providers.find((p) => p.providerType && modelIdFromConfig(p.config))
  if (!chosen) return
  const modelId = modelIdFromConfig(chosen.config)
  if (!modelId) return
  target.model = `${chosen.providerType}/${modelId}`
  log.info("serac: prefilled default model from dashboard", { model: target.model })
}
