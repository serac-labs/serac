import path from "path"
import fs from "fs"
import os from "os"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"

const log = Log.create({ service: "plugin.serac" })

// The Serac dashboard — the PRIMARY enterprise auth surface. The user logs into
// dashboard.serac.build via device authorization, receives a JWT, and that JWT
// drives the enterprise-proxy MCP server through which the platform brokers
// ServiceNow + ALL integrations.
const PORTAL_URL = "https://dashboard.serac.build"

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
    // ENTERPRISE MODE: when a dashboard JWT is stored, inject the
    // `serac-enterprise` MCP server (the enterprise-proxy). The platform brokers
    // ServiceNow + ALL integrations behind this single proxy, keyed by the JWT.
    //
    // This runs alongside (not instead of) the servicenow plugin's own config
    // hook, which injects the DIRECT servicenow MCP for the manual OAuth/Basic
    // path. Both config hooks compose against the same resolved config.
    config: async (config) => {
      const target = config as { mcp?: Record<string, unknown> }
      const auth = readStoredSeracAuth()
      if (!auth) return

      target.mcp ??= {}
      if (target.mcp["serac-enterprise"]) return

      target.mcp["serac-enterprise"] = {
        type: "local",
        // In a compiled binary the package's enterprise-proxy bin isn't on PATH,
        // so route through the hidden in-process subcommand (mirrors how the
        // servicenow plugin launches x-servicenow-mcp).
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
    },
  }
}
