/**
 * Minimal SN HTTP client for the probe harness.
 *
 * Only uses admin OAuth `client_credentials` grant — no test-user provisioning,
 * because the harness reads ACL definitions directly rather than empirically
 * probing as a low-role user. See `acl-resolve.ts` for the resolution strategy.
 */

import { homedir } from "os"
import { join } from "path"

export interface Env {
  url: string
  clientId: string
  clientSecret: string
}

export interface Outcome<T = unknown> {
  ok: boolean
  status: number
  data?: T
  errorBody?: string
}

const auth = { token: "", expiry: 0 }

export async function loadEnv(): Promise<Env> {
  const path = join(homedir(), ".config", "serac", "sn-probe.env")
  const text = await Bun.file(path).text()
  const parsed: Record<string, string> = {}
  for (const line of text.split("\n")) {
    if (!line || line.trim().startsWith("#")) continue
    const m = line.match(/^([A-Z_]+)\s*=\s*['"]?([^'"]*?)['"]?\s*$/)
    if (m) parsed[m[1]] = m[2]
  }
  if (!parsed.SN_INSTANCE_URL || !parsed.SN_OAUTH_CLIENT_ID || !parsed.SN_OAUTH_CLIENT_SECRET) {
    throw new Error(`Missing required vars in ${path}`)
  }
  return {
    url: parsed.SN_INSTANCE_URL.replace(/\/$/, ""),
    clientId: parsed.SN_OAUTH_CLIENT_ID,
    clientSecret: parsed.SN_OAUTH_CLIENT_SECRET,
  }
}

export async function adminToken(env: Env): Promise<string> {
  if (auth.token && Date.now() < auth.expiry) return auth.token
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.clientId,
    client_secret: env.clientSecret,
  })
  const r = await fetch(`${env.url}/oauth_token.do`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!r.ok) throw new Error(`OAuth failed: HTTP ${r.status} — ${await r.text()}`)

  // A hibernating SN developer instance answers EVERY request — /oauth_token.do
  // included — with HTTP 200 and an HTML wake-up page, so `r.ok` is true and a
  // bare `r.json()` dies with an unexplained "SyntaxError: Failed to parse
  // JSON". This manifest is regenerated rarely enough that the next person to
  // run it will almost certainly meet a sleeping instance first; say so.
  const raw = await r.text()
  if (!raw.trimStart().startsWith("{")) {
    throw new Error(
      /Instance Hibernating/i.test(raw)
        ? `${env.url} is hibernating. Wake it at https://developer.servicenow.com and re-run.`
        : `OAuth returned non-JSON (HTTP ${r.status}, ${r.headers.get("content-type") ?? "no content-type"}): ${raw.slice(0, 200)}`,
    )
  }
  const data = JSON.parse(raw) as { access_token: string; expires_in: number }
  auth.token = data.access_token
  auth.expiry = Date.now() + data.expires_in * 1000 - 60_000
  return auth.token
}

// Return type inferred: `HeadersInit` is a DOM lib type and this package
// typechecks with lib ESNext + types ["bun"] only.
export async function adminHeaders(env: Env) {
  const t = await adminToken(env)
  return { Authorization: `Bearer ${t}`, "Content-Type": "application/json", Accept: "application/json" }
}

export async function snFetch<T = unknown>(
  env: Env,
  method: string,
  path: string,
  authHeader: string,
  body?: unknown,
): Promise<Outcome<T>> {
  const init: RequestInit = {
    method,
    headers: { Authorization: authHeader, "Content-Type": "application/json", Accept: "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }
  const r = await fetch(`${env.url}${path}`, init).catch(
    (err) =>
      ({
        ok: false,
        status: 0,
        text: () => Promise.resolve(String(err)),
        json: () => Promise.reject(err),
      }) as unknown as Response,
  )
  if (!r.ok) {
    const errorBody = await r.text().catch(() => "")
    return { ok: false, status: r.status, errorBody }
  }
  const data = (await r.json().catch(() => null)) as T | null
  return { ok: true, status: r.status, data: data ?? undefined }
}

export async function detectRelease(env: Env): Promise<string> {
  const hdr = (await adminHeaders(env)) as Record<string, string>
  const r = await snFetch<{ result: { value: string }[] }>(
    env,
    "GET",
    `/api/now/table/sys_properties?sysparm_query=name=glide.war&sysparm_fields=value&sysparm_limit=1`,
    hdr.Authorization,
  )
  return r.data?.result?.[0]?.value ?? "unknown"
}
