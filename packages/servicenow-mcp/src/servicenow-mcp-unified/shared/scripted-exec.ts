/**
 * Shared server-side script execution.
 *
 * Runs ES5 JavaScript on ServiceNow via a Scripted REST endpoint that we
 * deploy on first use. Falls back to a sysauto_script job if the endpoint
 * can't be reached. Used by snow_execute_script (user-facing) and by
 * write tools that need to bypass Table-API limitations — notably
 * sys_ui_policy_action, where the ui_policy reference field is silently
 * dropped by the Table API but accepts writes through GlideRecord.
 */

import { randomBytes } from "crypto"
import type { AxiosInstance } from "axios"
import type { ServiceNowContext } from "./types.js"
import { getAuthenticatedClient } from "./auth.js"

const ENDPOINT_SERVICE_ID = "snow_flow_exec"
const ENDPOINT_PATH = "/execute"

/**
 * Endpoint URL cache. Key is composed of the tenant ID and the normalized
 * instance URL (same pattern as `shared/auth.ts`). This prevents one tenant's
 * endpoint-URL invalidation from wiping another tenant's cached URL when the
 * two happen to share a ServiceNow instance (cross-tenant DoS vector).
 */
const endpointCache = new Map<string, { url: string }>()

const getEndpointCacheKey = (context: ServiceNowContext): string => {
  const rawTenant = context.tenantId ?? "stdio"
  const tenant = rawTenant.replace(/[\x00:]/g, "_")
  return `${tenant}\x00${context.instanceUrl}`
}

/**
 * Bumped whenever OPERATION_SCRIPT changes in a way that matters for security.
 * `ensureEndpointDiagnosed` greps the deployed script for this marker and
 * rewrites the operation when it is absent, so an instance that received an
 * older endpoint is repaired the next time any tool touches it.
 */
export const OPERATION_SCRIPT_MARKER = "SERAC_EXEC_GUARD_V1"

/**
 * The endpoint evaluates arbitrary server-side script, and
 * `GlideEvaluator.evaluateString` runs without ACL enforcement — so whoever can
 * reach this operation is effectively admin. ServiceNow authenticates the
 * caller but, without an ACL on the operation, authorises every authenticated
 * user: an ESS account or a phished itil user could grant itself roles.
 *
 * The role check below is deliberately IN THE SCRIPT rather than only in the
 * operation's ACL settings. It travels with the artefact, applies on instances
 * where the ACL was never attached, and cannot be undone by editing a record
 * elsewhere. Requiring `admin` costs Serac nothing: creating a scripted REST
 * resource already requires admin, so any integration user able to install this
 * endpoint necessarily passes the check.
 */
export const OPERATION_SCRIPT = `(function process(request, response) {
  // ${OPERATION_SCRIPT_MARKER}
  if (!gs.hasRole('admin')) {
    gs.warn('[serac] scripted-exec refused for non-admin user ' + gs.getUserName());
    response.setStatus(403);
    response.setBody({ success: false, error: 'Forbidden: this endpoint requires the admin role.' });
    return;
  }

  var body = request.body.data;
  var script = body.script;
  var id = body.execution_id || gs.generateGUID();

  if (!script) {
    response.setStatus(400);
    response.setBody({ success: false, error: 'No script provided' });
    return;
  }

  var output = [];
  var result = null;
  var error = null;
  var startTime = new GlideDateTime();

  var origPrint = gs.print;
  var origInfo = gs.info;
  var origWarn = gs.warn;
  var origError = gs.error;

  gs.print = function(msg) {
    var m = String(msg);
    output.push({ level: 'print', message: m });
    origPrint.call(gs, m);
  };
  gs.info = function(msg) {
    var m = String(msg);
    output.push({ level: 'info', message: m });
    origInfo.call(gs, m);
  };
  gs.warn = function(msg) {
    var m = String(msg);
    output.push({ level: 'warn', message: m });
    origWarn.call(gs, m);
  };
  gs.error = function(msg) {
    var m = String(msg);
    output.push({ level: 'error', message: m });
    origError.call(gs, m);
  };

  try {
    result = GlideEvaluator.evaluateString(script);
  } catch (e) {
    error = e.toString();
    if (e.stack) error = error + '\\nStack: ' + e.stack;
  }

  gs.print = origPrint;
  gs.info = origInfo;
  gs.warn = origWarn;
  gs.error = origError;

  var endTime = new GlideDateTime();
  var execMs = Math.abs(GlideDateTime.subtract(startTime, endTime).getNumericValue());

  response.setStatus(error ? 500 : 200);
  response.setBody({
    execution_id: id,
    success: error === null,
    result: result,
    error: error,
    output: output,
    execution_time_ms: execMs
  });
})(request, response);`

export interface ScriptExecutionResult {
  success: boolean
  result?: unknown
  error?: string
  output?: Array<{ level: string; message: string }>
  executionTimeMs?: number
  method: "sync_rest_api" | "sysauto_script_with_trigger" | "scheduled_job_pending"
  executionId: string
  scheduledJobSysId?: string
  actionRequired?: string
  manualUrl?: string
  fallbackWarning?: string
}

function getEndpointUrl(context: ServiceNowContext): string {
  const cached = endpointCache.get(getEndpointCacheKey(context))
  if (cached) return cached.url
  return `/api/${ENDPOINT_SERVICE_ID}${ENDPOINT_PATH}`
}

/**
 * Clear the in-memory endpoint cache for a specific tenant+instance. Useful
 * when callers suspect the scripted REST endpoint was deleted or renamed on
 * the server — forces the next `ensureEndpoint()` to re-verify and re-deploy.
 *
 * Pass a `ServiceNowContext` to invalidate just that tenant's entry; omit it
 * to clear the entire cache (intended only for stdio teardown).
 */
export function resetEndpointCache(context?: ServiceNowContext): void {
  if (context) endpointCache.delete(getEndpointCacheKey(context))
  else endpointCache.clear()
}

export interface EndpointDeployResult {
  ok: boolean
  url?: string
  diagnostics: string[]
}

async function pingEndpoint(client: AxiosInstance, url: string): Promise<boolean> {
  const ping = await client
    .post(url, { script: "'pong'", execution_id: "deploy_verify" })
    .catch(() => null)
  return ping?.data?.result?.success === true
}

async function tryPingWithRetries(
  client: AxiosInstance,
  url: string,
  attempts: number,
  delayMs: number,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await pingEndpoint(client, url)) return true
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return false
}

function buildCandidateUrls(
  operationUri: string | undefined,
  baseUri: string | undefined,
  namespace: string | undefined,
): string[] {
  const seen = new Set<string>()
  const urls: string[] = []
  const push = (u: string | undefined) => {
    if (!u) return
    const normalized = u.startsWith("/") ? u : "/" + u
    if (seen.has(normalized)) return
    seen.add(normalized)
    urls.push(normalized)
  }

  // Most authoritative: the operation's own URI from sys_ws_operation.
  push(operationUri)

  // Next: the definition's base_uri with our relative path appended.
  if (baseUri) push(baseUri.replace(/\/+$/, "") + ENDPOINT_PATH)

  // Then: namespace-prefixed and unprefixed variants.
  if (namespace) push(`/api/${namespace}/${ENDPOINT_SERVICE_ID}${ENDPOINT_PATH}`)
  push(`/api/${ENDPOINT_SERVICE_ID}${ENDPOINT_PATH}`)

  // Last-resort guesses for common global/now namespaces.
  push(`/api/global/${ENDPOINT_SERVICE_ID}${ENDPOINT_PATH}`)
  push(`/api/now/${ENDPOINT_SERVICE_ID}${ENDPOINT_PATH}`)

  return urls
}

export async function ensureEndpoint(context: ServiceNowContext): Promise<boolean> {
  return (await ensureEndpointDiagnosed(context)).ok
}

/**
 * Same as ensureEndpoint, but returns diagnostics describing what was tried
 * and where it failed. Used by the redeploy tool to surface actionable
 * info when auto-deploy can't recover on its own.
 */
export async function ensureEndpointDiagnosed(context: ServiceNowContext): Promise<EndpointDeployResult> {
  const diagnostics: string[] = []
  const cacheKey = getEndpointCacheKey(context)
  if (endpointCache.has(cacheKey)) {
    return { ok: true, url: endpointCache.get(cacheKey)!.url, diagnostics: ["endpoint cache hit"] }
  }

  const client = await getAuthenticatedClient(context)

  // Look up the existing definition (if any).
  const check = await client
    .get("/api/now/table/sys_ws_definition", {
      params: {
        sysparm_query: `service_id=${ENDPOINT_SERVICE_ID}`,
        sysparm_fields: "sys_id,namespace,base_uri,active",
        sysparm_limit: 1,
      },
    })
    .catch((err: { response?: { status?: number } }) => {
      diagnostics.push(`sys_ws_definition lookup failed: HTTP ${err.response?.status ?? "unknown"}`)
      return null
    })

  let existing = check?.data?.result?.[0] as
    | { sys_id?: string; namespace?: string; base_uri?: string; active?: string | boolean }
    | undefined
  let needsOperationCreate = false

  if (!existing) {
    diagnostics.push(`no existing sys_ws_definition with service_id=${ENDPOINT_SERVICE_ID}; creating`)
    const svc = await client
      .post("/api/now/table/sys_ws_definition", {
        name: "Serac Script Executor",
        service_id: ENDPOINT_SERVICE_ID,
        short_description: "Synchronous script execution endpoint for Serac",
        active: true,
      })
      .catch((err: { response?: { status?: number; data?: { error?: { message?: string } } } }) => {
        diagnostics.push(
          `sys_ws_definition create failed: HTTP ${err.response?.status ?? "unknown"} — ${err.response?.data?.error?.message ?? "no detail"}. Caller likely lacks web_service_admin or admin role.`,
        )
        return null
      })

    const newId = svc?.data?.result?.sys_id
    if (!newId) return { ok: false, diagnostics }
    existing = {
      sys_id: String(newId),
      namespace: svc.data.result.namespace,
      base_uri: svc.data.result.base_uri,
      active: svc.data.result.active,
    }
    needsOperationCreate = true
    diagnostics.push(`created sys_ws_definition sys_id=${existing.sys_id}`)
  } else {
    diagnostics.push(`found existing sys_ws_definition sys_id=${existing.sys_id}`)
    if (existing.active === "false" || existing.active === false) {
      diagnostics.push("definition is inactive; reactivating")
      await client
        .patch("/api/now/table/sys_ws_definition/" + existing.sys_id, { active: true })
        .catch(() => diagnostics.push("reactivation patch failed"))
    }
  }

  const svcId = existing.sys_id
  if (!svcId) return { ok: false, diagnostics }

  // Look up (or create) the operation record.
  let operationUri: string | undefined
  if (!needsOperationCreate) {
    const opCheck = await client
      .get("/api/now/table/sys_ws_operation", {
        params: {
          sysparm_query: `web_service_definition=${svcId}^relative_path=${ENDPOINT_PATH}`,
          sysparm_fields: "sys_id,operation_uri,active,operation_script,requires_acl_authorization",
          sysparm_limit: 1,
        },
      })
      .catch(() => null)
    const op = opCheck?.data?.result?.[0] as
      | {
          sys_id?: string
          operation_uri?: string
          active?: string
          operation_script?: string
          requires_acl_authorization?: string
        }
      | undefined
    if (!op?.sys_id) {
      diagnostics.push("existing definition has no matching sys_ws_operation; creating one")
      needsOperationCreate = true
    } else {
      operationUri = op.operation_uri
      if (op.active === "false") {
        diagnostics.push("operation record is inactive; reactivating")
        await client
          .patch("/api/now/table/sys_ws_operation/" + op.sys_id, { active: true })
          .catch(() => diagnostics.push("operation reactivation patch failed"))
      }
      // Repair endpoints installed by an older Serac. Versions before the
      // guard shipped an operation any authenticated user could call, and left
      // it on the instance permanently — so the fix cannot wait for a fresh
      // install. Anything that reaches this code path already holds the
      // credentials that planted the endpoint, so healing it here grants no
      // access that was not already present.
      const hasGuard = (op.operation_script ?? "").includes(OPERATION_SCRIPT_MARKER)
      const hasAcl = op.requires_acl_authorization === "true"
      if (!hasGuard || !hasAcl) {
        diagnostics.push(
          `existing operation predates the role guard (guard=${hasGuard}, acl=${hasAcl}); rewriting it`,
        )
        await client
          .patch("/api/now/table/sys_ws_operation/" + op.sys_id, {
            operation_script: OPERATION_SCRIPT,
            requires_authentication: true,
            requires_acl_authorization: true,
          })
          .then(() => diagnostics.push("operation hardened"))
          .catch(() => diagnostics.push("operation hardening patch FAILED — endpoint remains unguarded"))
      }
    }
  }

  if (needsOperationCreate) {
    const opCreate = await client
      .post("/api/now/table/sys_ws_operation", {
        name: "Execute Script",
        web_service_definition: svcId,
        http_method: "POST",
        relative_path: ENDPOINT_PATH,
        operation_script: OPERATION_SCRIPT,
        active: true,
        // Belt and braces alongside the in-script role check: make ServiceNow
        // authorise the call, not merely authenticate it. Left on its own this
        // is not enough — an instance whose ACLs were never configured for the
        // resource still lets any authenticated user through — which is why the
        // script checks the role itself.
        requires_authentication: true,
        requires_acl_authorization: true,
      })
      .catch((err: { response?: { status?: number; data?: { error?: { message?: string } } } }) => {
        diagnostics.push(
          `sys_ws_operation create failed: HTTP ${err.response?.status ?? "unknown"} — ${err.response?.data?.error?.message ?? "no detail"}.`,
        )
        return null
      })
    const opId = opCreate?.data?.result?.sys_id
    if (!opId) return { ok: false, diagnostics }
    operationUri = opCreate.data.result.operation_uri
    diagnostics.push(`created sys_ws_operation sys_id=${opId} operation_uri=${operationUri ?? "(unknown)"}`)
  }

  const candidates = buildCandidateUrls(operationUri, existing.base_uri, existing.namespace)
  diagnostics.push(`candidate URLs to ping: ${candidates.join(", ")}`)

  const pingAttempts = needsOperationCreate ? 5 : 3
  const pingDelay = 1500

  for (const url of candidates) {
    if (await tryPingWithRetries(client, url, pingAttempts, pingDelay)) {
      endpointCache.set(cacheKey, { url })
      diagnostics.push(`endpoint live at ${url}`)
      return { ok: true, url, diagnostics }
    }
  }

  diagnostics.push("no candidate URL responded with success=true; endpoint may not be routable yet or path is wrong")
  return { ok: false, diagnostics }
}

async function executeViaSyncApi(
  client: AxiosInstance,
  context: ServiceNowContext,
  script: string,
  executionId: string,
): Promise<ScriptExecutionResult | null> {
  const response = await client
    .post(getEndpointUrl(context), {
      script,
      execution_id: executionId,
    })
    .catch((err: { response?: { status?: number } }) => {
      if (err.response?.status === 404 || err.response?.status === 403) return null
      throw err
    })

  if (!response) return null

  const data = response.data?.result
  if (!data) return null

  return {
    success: !!data.success,
    result: data.result,
    error: data.error,
    output: data.output,
    executionTimeMs: data.execution_time_ms,
    method: "sync_rest_api",
    executionId,
  }
}

async function executeViaScheduler(
  client: AxiosInstance,
  context: ServiceNowContext,
  script: string,
  executionId: string,
  timeout: number,
  description: string,
): Promise<ScriptExecutionResult> {
  const escape = (str: string) =>
    str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r")

  const marker = `SNOW_FLOW_EXEC_${executionId}`

  const wrapped = `
var __sfOutput = [];
var __sfStartTime = new GlideDateTime();
var __sfResult = null;
var __sfError = null;

var __sfOrigPrint = gs.print;
var __sfOrigInfo = gs.info;
var __sfOrigWarn = gs.warn;
var __sfOrigError = gs.error;

gs.print = function(msg) {
  var m = String(msg);
  __sfOutput.push({level: 'print', message: m, timestamp: new GlideDateTime().getDisplayValue()});
  __sfOrigPrint(m);
};
gs.info = function(msg) {
  var m = String(msg);
  __sfOutput.push({level: 'info', message: m, timestamp: new GlideDateTime().getDisplayValue()});
  __sfOrigInfo(m);
};
gs.warn = function(msg) {
  var m = String(msg);
  __sfOutput.push({level: 'warn', message: m, timestamp: new GlideDateTime().getDisplayValue()});
  __sfOrigWarn(m);
};
gs.error = function(msg) {
  var m = String(msg);
  __sfOutput.push({level: 'error', message: m, timestamp: new GlideDateTime().getDisplayValue()});
  __sfOrigError(m);
};

try {
  gs.info('=== Serac Script Execution Started ===');
  gs.info('Description: ${escape(description)}');
  __sfResult = (function() {
    ${script}
  })();
  gs.info('=== Serac Script Execution Completed ===');
  if (__sfResult !== undefined && __sfResult !== null) {
    gs.info('Script returned: ' + (typeof __sfResult === 'object' ? JSON.stringify(__sfResult) : String(__sfResult)));
  }
} catch(e) {
  __sfError = e.toString();
  gs.error('=== Serac Script Execution Failed ===');
  gs.error('Error: ' + e.toString());
  if (e.stack) {
    gs.error('Stack: ' + e.stack);
  }
}

gs.print = __sfOrigPrint;
gs.info = __sfOrigInfo;
gs.warn = __sfOrigWarn;
gs.error = __sfOrigError;

var __sfEndTime = new GlideDateTime();
var __sfExecTimeMs = Math.abs(GlideDateTime.subtract(__sfStartTime, __sfEndTime).getNumericValue());

var __sfResultObj = {
  executionId: '${executionId}',
  success: __sfError === null,
  result: __sfResult,
  error: __sfError,
  output: __sfOutput,
  executionTimeMs: __sfExecTimeMs,
  completedAt: __sfEndTime.getDisplayValue()
};

gs.setProperty('${marker}', JSON.stringify(__sfResultObj));
gs.info('${marker}:DONE');
`

  const name = `Serac Exec - ${executionId}`

  const job = await client
    .post("/api/now/table/sysauto_script", {
      name,
      script: wrapped,
      active: true,
      run_type: "on_demand",
      conditional: false,
    })
    .catch((err: { response?: { status?: number; data?: { error?: { message?: string } } } }) => {
      const status = err.response?.status ?? "unknown"
      const detail = err.response?.data?.error?.message ?? err.response?.data?.error ?? "no detail"
      return { __error: `Scheduler fallback failed to create sysauto_script: HTTP ${status} — ${detail}` } as const
    })

  if ("__error" in job) {
    return {
      success: false,
      error: job.__error,
      method: "scheduled_job_pending",
      executionId,
      fallbackWarning:
        "Sync REST endpoint unreachable and the sysauto_script fallback was rejected. User likely lacks web_service_admin / admin rights to deploy the executor endpoint or schedule jobs.",
    }
  }

  const jobId = job.data?.result?.sys_id
  if (!jobId) {
    return {
      success: false,
      error: "Failed to create scheduled script job (no sys_id returned)",
      method: "scheduled_job_pending",
      executionId,
    }
  }

  const now = new Date()
  const trigger = new Date(now.getTime() + 2000)
  const triggerStr = trigger.toISOString().replace("T", " ").substring(0, 19)

  await client
    .post("/api/now/table/sys_trigger", {
      name,
      next_action: triggerStr,
      trigger_type: 0,
      state: 0,
      document: "sysauto_script",
      document_key: jobId,
      claimed_by: "",
      system_id: "snow-flow",
    })
    .catch(() => {})

  const start = Date.now()
  const max = Math.ceil(timeout / 2000)
  let result: Record<string, unknown> | null = null

  for (let i = 0; i < max && Date.now() - start < timeout; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000))

    const prop = await client
      .get("/api/now/table/sys_properties", {
        params: {
          sysparm_query: `name=${marker}`,
          sysparm_fields: "value,sys_id",
          sysparm_limit: 1,
        },
      })
      .catch(() => null)

    const entry = prop?.data?.result?.[0]
    if (!entry?.value) continue

    try {
      result = JSON.parse(entry.value) as Record<string, unknown>
      if (entry.sys_id) {
        await client.delete(`/api/now/table/sys_properties/${entry.sys_id}`).catch(() => {})
      }
      break
    } catch {
      continue
    }
  }

  if (result) {
    await client.delete(`/api/now/table/sysauto_script/${jobId}`).catch(() => {})

    return {
      success: !!result.success,
      result: result.result,
      error: result.error as string | undefined,
      output: result.output as Array<{ level: string; message: string }> | undefined,
      executionTimeMs: result.executionTimeMs as number | undefined,
      method: "sysauto_script_with_trigger",
      executionId,
      fallbackWarning: "Executed via scheduler fallback. The sync REST API endpoint could not be reached.",
    }
  }

  return {
    success: false,
    method: "scheduled_job_pending",
    executionId,
    scheduledJobSysId: jobId,
    actionRequired: `Navigate to System Scheduler > Scheduled Jobs and run: ${name}`,
    manualUrl: `${context.instanceUrl}/sysauto_script.do?sys_id=${jobId}`,
    fallbackWarning: "Both sync REST API and scheduler fallback failed to confirm execution.",
  }
}

/**
 * Execute a server-side ES5 script on ServiceNow.
 *
 * Tries the Scripted REST endpoint first (deploys it on first use). Falls
 * back to a sysauto_script job if the endpoint is unavailable (e.g. caller
 * lacks permission to deploy Scripted REST APIs).
 */
export async function executeServerScript(
  context: ServiceNowContext,
  script: string,
  options: {
    timeout?: number
    executionId?: string
    description?: string
  } = {},
): Promise<ScriptExecutionResult> {
  const executionId = options.executionId || `exec_${Date.now()}_${randomBytes(6).toString("hex")}`
  const timeout = options.timeout ?? 30000
  const description = options.description || "Serac server-side execution"

  const client = await getAuthenticatedClient(context)

  const sync = await executeViaSyncApi(client, context, script, executionId).catch(() => null)
  if (sync) return sync

  const ok = await ensureEndpoint(context).catch(() => false)
  if (ok) {
    const retry = await executeViaSyncApi(client, context, script, executionId).catch(() => null)
    if (retry) return retry
  }

  return executeViaScheduler(client, context, script, executionId, timeout, description).catch(
    (err: Error): ScriptExecutionResult => ({
      success: false,
      error: `Scheduler fallback threw: ${err.message}`,
      method: "scheduled_job_pending",
      executionId,
      fallbackWarning:
        "Both sync REST endpoint and scheduler fallback failed. Check ServiceNow permissions (needs admin or web_service_admin + schedule_admin).",
    }),
  )
}
