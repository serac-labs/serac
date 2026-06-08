import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"

const log = Log.create({ service: "plugin.servicenow" })

// Read the creds stored by the auth method above (an "api" auth record with a
// metadata string-map) straight from auth.json — the config hook runs early, so
// we avoid the Effect-based Auth service and read the file directly.
function readStoredServiceNowCreds():
  | { instance?: string; clientId?: string; clientSecret?: string; username?: string; password?: string }
  | undefined {
  try {
    const raw =
      process.env["OPENCODE_AUTH_CONTENT"] ?? fs.readFileSync(path.join(Global.Path.data, "auth.json"), "utf8")
    const data = JSON.parse(raw) as Record<string, { type?: string; key?: string; metadata?: Record<string, string> }>
    const entry = data["servicenow"]
    if (!entry || entry.type !== "api" || !entry.metadata) return undefined
    const m = entry.metadata
    if (m["authType"] === "basic" && entry.key) {
      const [username, password] = Buffer.from(entry.key, "base64").toString("utf8").split(":")
      return { instance: m["instance"], username, password }
    }
    return { instance: m["instance"], clientId: m["clientId"], clientSecret: m["clientSecret"] }
  } catch {
    return undefined
  }
}

// ServiceNow auth as a bundled AuthHook plugin. Ported from the previous fork's
// servicenow-oauth.ts (PKCE + oauth_auth.do/oauth_token.do) and dialog-auth.tsx
// (instance + OAuth/Basic prompts), re-expressed for upstream 1.16's declarative
// AuthHook so the generic dialog-provider renders it — the 1655-line dialog-auth
// and the custom "servicenow-oauth" Zod auth type are dropped.
//
// ServiceNow is NOT an LLM provider, so this plugin only COLLECTS + STORES creds
// (instance + tokens or basic key) under the "servicenow" provider. Token use +
// refresh happen downstream in the env-driven servicenow-mcp server / the
// servicenow-llm provider, which read the stored creds. Hence no `loader`.
//
// NEEDS RUNTIME VERIFICATION: (1) the OAuth redirect_uri must be registered on
// the instance's OAuth app; (2) PKCE support varies by ServiceNow version;
// (3) password prompt is unmasked (AuthHook prompts only expose text/select);
// (4) confirm the custom "servicenow" provider surfaces in the auth picker.

interface PkceCodes {
  verifier: string
  challenge: string
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function generatePKCE(): Promise<PkceCodes> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)))
    .map((b) => chars[b % chars.length])
    .join("")
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function normalizeInstance(raw: string): string {
  let v = (raw ?? "").trim().replace(/\/+$/, "")
  if (!v) return v
  if (!/^https?:\/\//i.test(v)) {
    // Accept a full host (dev12345.service-now.com) or the short instance name.
    v = v.includes(".") ? `https://${v}` : `https://${v}.service-now.com`
  }
  return v
}

function requireInstance(value: string): string | undefined {
  return value && value.trim() ? undefined : "ServiceNow instance is required"
}

interface ServiceNowTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

export async function ServiceNowAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "servicenow",
      methods: [
        {
          type: "oauth",
          label: "ServiceNow OAuth (instance OAuth app)",
          prompts: [
            {
              type: "text",
              key: "instance",
              message: "ServiceNow instance URL",
              placeholder: "https://dev12345.service-now.com",
              validate: requireInstance,
            },
            { type: "text", key: "clientId", message: "OAuth Client ID" },
            { type: "text", key: "clientSecret", message: "OAuth Client Secret" },
          ],
          authorize: async (inputs) => {
            const instance = normalizeInstance(inputs?.instance ?? "")
            const clientId = inputs?.clientId ?? ""
            const clientSecret = inputs?.clientSecret ?? ""
            const pkce = await generatePKCE()
            const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
            // ServiceNow's standard OAuth redirect; must be registered on the OAuth app.
            const redirectUri = `${instance}/oauth_redirect.do`
            const params = new URLSearchParams({
              response_type: "code",
              client_id: clientId,
              redirect_uri: redirectUri,
              state,
              code_challenge: pkce.challenge,
              code_challenge_method: "S256",
            })

            return {
              url: `${instance}/oauth_auth.do?${params.toString()}`,
              instructions:
                "Authorize in your browser, then paste the `code` value from the redirected URL.",
              method: "code" as const,
              callback: async (code: string) => {
                try {
                  const response = await fetch(`${instance}/oauth_token.do`, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({
                      grant_type: "authorization_code",
                      code,
                      redirect_uri: redirectUri,
                      client_id: clientId,
                      client_secret: clientSecret,
                      code_verifier: pkce.verifier,
                    }).toString(),
                  })
                  if (!response.ok) {
                    log.error("servicenow token exchange failed", { status: response.status })
                    return { type: "failed" as const }
                  }
                  const data = (await response.json()) as ServiceNowTokenResponse
                  return {
                    type: "success" as const,
                    key: data.access_token,
                    // Stash everything the downstream MCP server / provider needs to
                    // use and refresh the token (metadata is the only string-map slot).
                    metadata: {
                      instance,
                      clientId,
                      clientSecret,
                      authType: "oauth",
                      refresh: data.refresh_token ?? "",
                      expires: String(Date.now() + (data.expires_in ?? 1800) * 1000),
                    },
                  }
                } catch (error) {
                  log.error("servicenow token exchange error", { error })
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "ServiceNow Basic (username / password)",
          prompts: [
            {
              type: "text",
              key: "instance",
              message: "ServiceNow instance URL",
              placeholder: "https://dev12345.service-now.com",
              validate: requireInstance,
            },
            { type: "text", key: "username", message: "Username" },
            { type: "text", key: "password", message: "Password" },
          ],
          authorize: async (inputs) => {
            const instance = normalizeInstance(inputs?.instance ?? "")
            const key = Buffer.from(`${inputs?.username ?? ""}:${inputs?.password ?? ""}`).toString("base64")
            return {
              type: "success" as const,
              key,
              metadata: { instance, authType: "basic" },
            }
          },
        },
      ],
    },
    // Wire the bundled Serac customizations into the resolved config:
    //  - the 55 bundled skills (ported from the old fork) via a skills path
    //  - the servicenow-mcp stdio server, with creds collected by the auth
    //    methods above (env names match what the package reads)
    // NEEDS RUNTIME VERIFICATION: bundled-skills/stdio-bin path resolution in a
    // packaged build, and that a plugin config hook is honored by skill + MCP
    // discovery.
    config: async (config) => {
      const target = config as {
        mcp?: Record<string, unknown>
        skills?: { paths?: string[] }
      }

      const here = path.dirname(fileURLToPath(import.meta.url))
      const skillsDir = path.join(here, "..", "..", "bundled-skills")
      target.skills ??= {}
      target.skills.paths ??= []
      if (!target.skills.paths.includes(skillsDir)) target.skills.paths.push(skillsDir)

      target.mcp ??= {}
      if (!target.mcp["servicenow"]) {
        const creds = readStoredServiceNowCreds()
        const environment: Record<string, string> = {}
        if (creds?.instance) environment["SERVICENOW_INSTANCE_URL"] = creds.instance
        if (creds?.clientId) environment["SERVICENOW_CLIENT_ID"] = creds.clientId
        if (creds?.clientSecret) environment["SERVICENOW_CLIENT_SECRET"] = creds.clientSecret
        if (creds?.username) environment["SERVICENOW_USERNAME"] = creds.username
        if (creds?.password) environment["SERVICENOW_PASSWORD"] = creds.password
        target.mcp["servicenow"] = {
          type: "local",
          command: ["servicenow-mcp-stdio"],
          environment,
          enabled: true,
        }
      }
    },
  }
}
