/**
 * snow_impersonate_user - Generate a ServiceNow impersonation deep-link
 *
 * Verifies the caller has the 'admin' role, resolves the target user,
 * appends an entry to ~/.serac/audit/impersonations.jsonl, and
 * returns the impersonation URL the admin clicks in their browser
 * session to switch context.
 *
 * Note: this does NOT change our OAuth session — ServiceNow's
 * /impersonate.do endpoint requires a browser session cookie. The
 * intent is to hand the admin a safe, audited deep-link.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import { appendFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import { seracHomePath } from "../../shared/serac-home.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_impersonate_user",
  description:
    "Generate a ServiceNow impersonation deep-link for ACL / role debugging. Verifies the caller has the 'admin' role, resolves the target user (by sys_id or username), appends an audit entry to ~/.serac/audit/impersonations.jsonl, and returns an /impersonate.do URL the admin opens in the browser to actually switch session. Does NOT modify the OAuth session itself — ServiceNow's impersonation endpoint is cookie-based.",
  category: "user-admin",
  subcategory: "security",
  use_cases: ["debugging", "acl", "impersonation", "testing-permissions"],
  complexity: "intermediate",
  frequency: "low",
  permission: "admin",
  allowedRoles: ["admin"],
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "Target user: sys_id (32-char hex) or user_name. Example: '6816f79cc0a8016401c5a33be04be441' or 'abel.tuter'.",
      },
      reason: {
        type: "string",
        description: "Why the impersonation is needed — written to the audit log. Example: 'Verify ACL on incident form for end-user role'.",
      },
    },
    required: ["target"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const target = args.target as string
  const reason = (args.reason as string) || ""

  if (!target) return createErrorResult("Missing 'target' argument (sys_id or user_name)")

  const client = await getAuthenticatedClient(context)

  const callerResp = await client
    .get("/api/now/table/sys_user", {
      params: {
        sysparm_query: "sys_id=javascript:gs.getUserID()",
        sysparm_fields: "sys_id,user_name,name,email",
        sysparm_limit: 1,
      },
    })
    .catch((err: { message?: string }) => ({ __error: err.message || "caller lookup failed" }))

  if ("__error" in callerResp) {
    return createErrorResult(`Could not identify caller: ${callerResp.__error}`)
  }

  const caller = callerResp.data?.result?.[0]
  if (!caller) return createErrorResult("Could not resolve the authenticated user.")

  const rolesResp = await client
    .get("/api/now/table/sys_user_has_role", {
      params: {
        sysparm_query: "user=javascript:gs.getUserID()^role.name=admin",
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })
    .catch((err: { message?: string }) => ({ __error: err.message || "role check failed" }))

  if ("__error" in rolesResp) {
    return createErrorResult(`Could not verify admin role: ${rolesResp.__error}`)
  }

  const hasAdmin = (rolesResp.data?.result?.length ?? 0) > 0
  if (!hasAdmin) {
    return createErrorResult(
      `User '${caller.user_name}' does not hold the 'admin' role. snow_impersonate_user requires admin.`,
    )
  }

  const sysIdPattern = /^[0-9a-f]{32}$/i
  const resolvedQuery = sysIdPattern.test(target) ? `sys_id=${target}` : `user_name=${encodeURIComponent(target)}`

  const targetResp = await client
    .get("/api/now/table/sys_user", {
      params: {
        sysparm_query: resolvedQuery,
        sysparm_fields: "sys_id,user_name,name,email,active",
        sysparm_limit: 1,
      },
    })
    .catch((err: { message?: string }) => ({ __error: err.message || "target lookup failed" }))

  if ("__error" in targetResp) {
    return createErrorResult(`Target lookup failed: ${targetResp.__error}`)
  }

  const user = targetResp.data?.result?.[0]
  if (!user) return createErrorResult(`No user matches '${target}'.`)

  if (user.active !== "true") {
    return createErrorResult(`User '${user.user_name}' is inactive and cannot be impersonated.`)
  }

  const base = context.instanceUrl.replace(/\/+$/, "")
  const impersonateUrl = `${base}/impersonate.do?sys_id=${user.sys_id}`

  const entry = {
    timestamp: new Date().toISOString(),
    instance_url: context.instanceUrl,
    admin: {
      sys_id: caller.sys_id,
      user_name: caller.user_name,
      name: caller.name,
    },
    target: {
      sys_id: user.sys_id,
      user_name: user.user_name,
      name: user.name,
      email: user.email,
    },
    reason,
    impersonate_url: impersonateUrl,
  }

  const auditErr = writeAudit(entry)

  const summary = [
    `Impersonation link generated.`,
    `  Target: ${user.name} (${user.user_name})`,
    `  URL:    ${impersonateUrl}`,
    auditErr ? `  ⚠ Audit log write failed: ${auditErr}` : `  Audit: ~/.serac/audit/impersonations.jsonl`,
    ``,
    `Open the URL in the browser where you're logged in as admin to switch session. The OAuth connection itself is not altered.`,
  ].join("\n")

  return createSuccessResult(
    {
      impersonate_url: impersonateUrl,
      target: entry.target,
      admin: entry.admin,
      audit_written: !auditErr,
    },
    { audit_error: auditErr },
    summary,
  )
}

function writeAudit(entry: Record<string, unknown>): string | undefined {
  const dir = seracHomePath("audit")
  const file = join(dir, "impersonations.jsonl")

  let error: string | undefined
  attempt(() => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8")
  }, (err) => {
    error = err.message
  })
  return error
}

function attempt(fn: () => void, onError: (err: Error) => void): void {
  try {
    fn()
  } catch (err) {
    onError(err as Error)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK"
