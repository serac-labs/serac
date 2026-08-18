/**
 * snow_app_repo_manage
 *
 * Publishes a scoped application to the Application Repository and installs a
 * published version onto the instance, through ServiceNow's CI/CD API.
 *
 * Endpoint paths, parameter names, the "scope or sys_id" rule, the required
 * role and the numeric progress statuses used below are all taken from
 * ServiceNow's CI/CD API reference:
 * https://www.servicenow.com/docs/bundle/xanadu-api-reference/page/integrate/inbound-rest/concept/cicd-api.html
 * The same page in the Yokohama bundle carries identical parameter and status
 * tables; the HTTP status hints in execute() quote that table and nothing else.
 *
 * Both app_repo endpoints are asynchronous. Their 200 means "the job is
 * queued", not "the app is published/installed": the body carries a progress
 * record whose status starts at Pending. So nothing here calls a publish or an
 * install done unless a progress record said Successful. A Failed or Canceled
 * job comes back as an error carrying ServiceNow's own message, and a job that
 * is still running when the wait budget runs out comes back as an error too —
 * with the progress_id, because "I don't know yet" is the truthful answer.
 *
 * There is no pipeline and no cross-instance target in this API: every endpoint
 * acts on the instance the call authenticated to ("installs the specified
 * application from the application repository onto the instance making the
 * endpoint call"). Publishing from dev and installing on test are therefore two
 * calls over two different connections, not one deployment.
 */

import type { AxiosInstance } from "axios"
import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

const PUBLISH_PATH = "/api/sn_cicd/app_repo/publish"
const INSTALL_PATH = "/api/sn_cicd/app_repo/install"
const PROGRESS_PATH = "/api/sn_cicd/progress"

// The progress status codes the CI/CD API documents.
const STATE_BY_STATUS: Record<string, string> = {
  "0": "pending",
  "1": "running",
  "2": "successful",
  "3": "failed",
  "4": "canceled",
}
// Derived from the table above rather than kept as a second list of codes: two
// lists drift, and the one that drifts silently is the one that decides whether
// a caller is told a job finished. An unrecognised code is never final, so the
// caller polls instead of being handed a result the API did not give.
function isFinal(status: unknown) {
  return ["successful", "failed", "canceled"].includes(STATE_BY_STATUS[String(status)] ?? "")
}

const POLL_INTERVAL_MS = 5000
// Deliberately short. A blocking tool call that outlives the MCP client's own
// timeout loses the progress_id with it, which is worse than returning early
// and telling the caller to poll.
const DEFAULT_TIMEOUT_MS = 120000

export const toolDefinition: MCPToolDefinition = {
  name: "snow_app_repo_manage",
  description: `Publish a scoped application to the Application Repository and install a published version, via ServiceNow's CI/CD API (/api/sn_cicd/app_repo). Requires the sn_cicd.sys_ci_automation or admin role.

Actions:
- publish — POST /api/sn_cicd/app_repo/publish. Stores the application and its artifacts in the Application Repository under a version. Identify the app by scope or app_sys_id. Without an explicit version the publish uses the app's current local version and fails if that version is already in the repository.
- install — POST /api/sn_cicd/app_repo/install. Installs a repository version onto the instance this call is authenticated to.
- progress — GET /api/sn_cicd/progress/{progress_id}. Reports the real state of a job started earlier.

This API has no pipeline and no target-instance parameter: both endpoints act on the instance you are connected to. To move an app from dev to test you publish while connected to dev, then install while connected to test.

Publish and install are asynchronous — they return a queued progress record, not a finished deployment. By default this tool polls that record until it is final and reports what it says: Successful returns success; Failed or Canceled returns an error with ServiceNow's own message; a job still running when timeout_ms elapses returns an error saying the outcome is unknown, with the progress_id. Pass wait=false to get the progress_id back immediately and poll it yourself with action=progress. Returns progress_id, state, status_label, percent_complete and ServiceNow's status/error text.

Examples:
- { action: "publish", scope: "x_acme_myapp", version: "1.2.0", dev_notes: "sprint 14" }
- { action: "install", scope: "x_acme_myapp", version: "1.2.0", timeout_ms: 600000 }
- { action: "install", app_sys_id: "b7e...", version: "1.2.0", wait: false }
- { action: "progress", progress_id: "d174f8e11bd800103d374087bc4bcbd9" }`,
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "applications",
  use_cases: ["app-repo", "deployment", "cicd", "devops", "scoped-apps"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE — publish stores an application version on the
  // instance, install changes what is installed on it.
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Operation to perform",
        enum: ["publish", "install", "progress"],
      },
      scope: {
        type: "string",
        description:
          '[publish/install] Application scope, e.g. "x_acme_myapp". Found in the scope field of Custom Application [sys_app]; for install it may also come from Store Application [sys_store_app]. Pass this or app_sys_id.',
      },
      app_sys_id: {
        type: "string",
        description:
          "[publish/install] sys_id of the application, from Custom Application [sys_app] (install also accepts a Store Application [sys_store_app] sys_id). Sent as the API's sys_id parameter. Takes precedence over scope — the API wants one identifier, not both.",
      },
      version: {
        type: "string",
        description:
          '[publish] Version to store the application under, e.g. "1.2.0"; the local application version is updated to match. Omit and the publish uses the app\'s current version, failing if that version is already in the repository. [install] Version to install; omitting it lets ServiceNow pick per its auto_upgrade_base_app / base_app_version rules.',
      },
      dev_notes: {
        type: "string",
        description: "[publish] Developer notes stored with the published version.",
      },
      auto_upgrade_base_app: {
        type: "boolean",
        description:
          "[install] Only relevant when installing customizations of a base application: whether the associated base application may be upgraded to a later version. Left to ServiceNow's default (false) when omitted.",
      },
      base_app_version: {
        type: "string",
        description:
          "[install] Version of the base application (a third-party Store application) to install. When set, only the base application is installed.",
      },
      progress_id: {
        type: "string",
        description: "[progress] Progress record id returned by an earlier publish or install.",
      },
      wait: {
        type: "boolean",
        description:
          "[publish/install] Poll the progress record until it is final (default true). false returns the progress_id straight away, before the job has done anything — the app is not published or installed at that point.",
        default: true,
      },
      timeout_ms: {
        type: "number",
        description:
          "[publish/install when wait=true] How long to keep polling, in milliseconds. Default 120000 (2 min); installs of large applications routinely need more. Running out returns an error with the progress_id, not a success — recover with action=progress on that id. Do not re-issue the publish/install with a larger timeout_ms: the first job is still running and a second one would be a duplicate.",
        default: DEFAULT_TIMEOUT_MS,
      },
    },
    required: ["action"],
  },
}

export const ACTIONS = {
  publish: publishApp,
  install: installApp,
  progress: readProgress,
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = str(args.action)
  const handler = action ? ACTIONS[action as keyof typeof ACTIONS] : undefined
  // Checked before authenticating: a typo shouldn't cost a round trip, and it
  // makes the dispatch table testable without an instance.
  if (!handler) {
    return createErrorResult(
      `Unknown action: ${action ?? "(none)"}. Valid actions: ${Object.keys(ACTIONS).join(", ")}.`,
    )
  }

  try {
    return await handler(await getAuthenticatedClient(context), args)
  } catch (error: unknown) {
    const message = messageOf(error)
    const status = statusOf(error)
    // Each branch below repeats what the CI/CD API reference assigns to that
    // code, and nothing else — a hint that sends the caller to the wrong fix is
    // worse than the bare status. 400 is documented on publish only.
    if (status === 400) {
      return createErrorResult(
        `Bad request (400) on ${action}. Original error: ${message}. ServiceNow documents 400 on app_repo/publish for two causes: the application version "isn't correct or is a downgrade" — a publish without an explicit version uses the app's current version and fails if that version is already in the repository, so pass a higher version — or "the application is connected to source control and contains uncommitted changes that must be resolved", which means committing them first.`,
      )
    }
    if (status === 401) {
      return createErrorResult(
        `Authentication failed (401) on ${action}: ServiceNow reports the user credentials are incorrect. This is about the credentials, not about roles. Original error: ${message}`,
      )
    }
    if (status === 403) {
      return createErrorResult(
        `Forbidden (403) on ${action}: the user is not an admin and does not have the sn_cicd.sys_ci_automation role. Original error: ${message}`,
      )
    }
    if (status === 404) {
      return createErrorResult(
        `Not found (404) on ${action}. ServiceNow documents this only as "the requested item wasn't found" — check that the scope/app_sys_id names an application on this instance, and for install that the version is in the Application Repository. Original error: ${message}`,
      )
    }
    if (status === 405) {
      return createErrorResult(
        `Invalid method (405) on ${action}. ServiceNow documents this as "the functionality is inactive", i.e. this instance is not serving /api/sn_cicd. Original error: ${message}`,
      )
    }
    if (status === 409) {
      return createErrorResult(
        `Conflict (409) on ${action}. ServiceNow documents this as "the requested item isn't unique". Original error: ${message}`,
      )
    }
    return createErrorResult(message)
  }
}

async function publishApp(client: AxiosInstance, args: Record<string, unknown>): Promise<ToolResult> {
  const target = identify(args)
  if (!target) return createErrorResult(MISSING_APP)

  // Documented as query parameters; the endpoint takes no request body.
  const response = await client.post(PUBLISH_PATH, undefined, {
    params: { ...target, version: str(args.version), dev_notes: str(args.dev_notes) },
  })
  return await settle(client, "publish", response.data?.result, args)
}

async function installApp(client: AxiosInstance, args: Record<string, unknown>): Promise<ToolResult> {
  const target = identify(args)
  if (!target) return createErrorResult(MISSING_APP)

  const response = await client.post(INSTALL_PATH, undefined, {
    params: {
      ...target,
      version: str(args.version),
      auto_upgrade_base_app: optionalBool(args.auto_upgrade_base_app),
      base_app_version: str(args.base_app_version),
    },
  })
  return await settle(client, "install", response.data?.result, args)
}

async function readProgress(client: AxiosInstance, args: Record<string, unknown>): Promise<ToolResult> {
  const progressId = str(args.progress_id)
  if (!progressId) {
    return createErrorResult("progress needs progress_id — the id an earlier publish or install returned.")
  }
  const progress = await fetchProgress(client, `${PROGRESS_PATH}/${encodeURIComponent(progressId)}`)
  return reportProgress(`CI/CD job ${progressId}`, "progress", progress, progressId)
}

/**
 * Turn the queued record an app_repo POST returns into an honest answer:
 * either the id the caller has to poll, or whatever the progress record ends
 * up saying once it stops moving.
 */
async function settle(
  client: AxiosInstance,
  action: "publish" | "install",
  started: unknown,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const queued = rec(started)
  const link = rec(rec(queued.links).progress)
  const progressId = str(link.id)
  const path = progressPath(link)
  const label =
    action === "publish"
      ? `Publish of ${describeApp(args)} to the Application Repository`
      : `Install of ${describeApp(args)} onto this instance`

  // A job that has already reached a final state is reported as that state
  // whatever `wait` says — including a publish that failed on the spot, which
  // must not come back as "requested, poll it later".
  if (isFinal(queued.status)) return reportProgress(label, action, queued, progressId)

  if (!path) {
    return createErrorResult(
      `${label} was accepted by ServiceNow, but the response carried no progress link, so this tool cannot confirm what happened. Check the application's version history on the instance. Raw result: ${JSON.stringify(queued)}`,
      { progress_id: progressId },
    )
  }

  // The documented response always carries links.progress.id, but the caller
  // gets a usable instruction either way rather than the string "undefined".
  const pollHint = progressId
    ? `Poll { action: "progress", progress_id: "${progressId}" }`
    : `Follow the progress record at ${str(link.url) ?? path}`

  if (!bool(args.wait, true)) {
    return createSuccessResult(
      {
        action,
        state: STATE_BY_STATUS[String(queued.status)] ?? "pending",
        finished: false,
        progress_id: progressId,
        progress_url: str(link.url),
        status: queued.status,
        status_label: str(queued.status_label),
        // Documented on the app_repo/install response only ("if available, the
        // previously installed version") — not on publish and not on the
        // progress record, so it is read here and nowhere else on purpose.
        rollback_version: str(queued.rollback_version),
      },
      { progress_id: progressId },
      `${label} was REQUESTED and has NOT finished — ServiceNow reports "${str(queued.status_label) ?? "Pending"}". ${pollHint} until it is final before treating the application as ${action === "publish" ? "published" : "installed"}.`,
    )
  }

  const budget = num(args.timeout_ms) ?? DEFAULT_TIMEOUT_MS
  const polled = await pollUntilFinal(client, path, Date.now() + budget)
  if (!polled.final) {
    // Every poll can have failed, in which case there is no status to quote —
    // saying so beats printing the word "undefined" as a ServiceNow status.
    const seen =
      str(polled.progress.status_label) ??
      (polled.progress.status === undefined ? undefined : `status ${String(polled.progress.status)}`)
    // No "retry with a larger timeout_ms" here: re-issuing the publish or
    // install would start a second job while the first one is still running.
    // The only recovery is the progress record.
    return createErrorResult(
      `${label} had not finished after ${budget}ms — ${seen ? `ServiceNow last reported "${seen}"${percentSuffix(polled.progress)}` : "this tool never got a readable progress record for it"}${pollErrorSuffix(polled.progress)}. The job may still be running; this tool does not know the outcome. ${pollHint} — do NOT re-issue this ${action}, it is already running. Pass a larger timeout_ms on a future ${action} if this keeps happening.`,
      { progress_id: progressId, finished: false, timed_out: true, status: polled.progress.status },
    )
  }
  return reportProgress(label, action, polled.progress, progressId)
}

// Bounded by the deadline the caller paid for: every iteration is one GET, and
// the loop stops rather than starting a sleep it cannot finish in budget.
export async function pollUntilFinal(
  client: AxiosInstance,
  path: string,
  deadline: number,
  last: Record<string, unknown> = {},
): Promise<{ progress: Record<string, unknown>; final: boolean }> {
  // A poll that fails is not a job that failed. Installing an application can
  // take the node out for a moment, and auth.ts turns any 502/503 into a thrown
  // "instance is hibernating or starting up" error — letting that escape would
  // report a healthy install as a dead instance and lose the progress_id with
  // it, leaving the job unpollable. So a failed GET is carried forward and
  // retried until the deadline, with the last status this loop did read.
  // Annotated because spreading `last` widens the union away from the index
  // signature, and every reader below wants the record, not the two shapes.
  const progress: Record<string, unknown> = await fetchProgress(client, path).catch((error: unknown) => ({
    ...last,
    poll_error: messageOf(error),
  }))
  if (isFinal(progress.status)) return { progress, final: true }
  if (Date.now() + POLL_INTERVAL_MS >= deadline) return { progress, final: false }
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  return await pollUntilFinal(client, path, deadline, progress)
}

async function fetchProgress(client: AxiosInstance, path: string) {
  // The auth interceptor rewrites a body that has no `result` into `result: []`,
  // so an unreadable answer arrives here as an empty record instead of throwing.
  // Without a status there is nothing to report, and inventing one is the whole
  // failure mode this tool exists to avoid.
  const progress = rec((await client.get(path)).data?.result)
  if (progress.status === undefined) {
    throw new Error(`ServiceNow returned no readable CI/CD progress record from ${path}.`)
  }
  return progress
}

/**
 * One place decides what a progress record means, so a publish, an install and
 * a bare status query can never disagree about whether a job succeeded.
 */
export function reportProgress(
  label: string,
  action: string,
  progress: Record<string, unknown>,
  progressId: string | undefined,
): ToolResult {
  const status = String(progress.status)
  const statusLabel = str(progress.status_label) ?? status
  const detail = str(progress.error) ?? str(progress.status_message) ?? str(progress.status_detail)
  const data = {
    action,
    progress_id: progressId,
    state: STATE_BY_STATUS[status] ?? "unknown",
    finished: isFinal(status),
    status: progress.status,
    status_label: statusLabel,
    percent_complete: progress.percent_complete,
    error: str(progress.error),
    status_message: str(progress.status_message),
    status_detail: str(progress.status_detail),
  }

  if (status === "3" || status === "4") {
    return createErrorResult(
      `${label} finished as ${statusLabel}. ServiceNow says: ${detail ?? "(no detail returned)"}`,
      data,
    )
  }
  if (status === "2") {
    return createSuccessResult(data, {}, `${label} finished: ${statusLabel}.${detail ? ` ${detail}` : ""}`)
  }
  return createSuccessResult(
    data,
    {},
    `${label} has NOT finished — ServiceNow reports "${statusLabel}"${percentSuffix(progress)}. Poll again before acting on it.`,
  )
}

/**
 * Where to poll for a queued job.
 *
 * ServiceNow hands back an absolute progress URL and its own GitHub Actions
 * follow that link rather than rebuilding the path, so this prefers it — but
 * takes only the path and query, resolved against the authenticated client's
 * own baseURL. That client attaches the instance's Authorization header to
 * every request it makes, so following a host that arrived inside a response
 * body would be a way to post that token somewhere else.
 */
export function progressPath(link: Record<string, unknown>) {
  const url = str(link.url)
  if (url && URL.canParse(url)) {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  }
  const id = str(link.id)
  return id ? `${PROGRESS_PATH}/${encodeURIComponent(id)}` : undefined
}

const MISSING_APP =
  'Pass scope (e.g. "x_acme_myapp") or app_sys_id to say which application. Both are on the application record: the scope and Sys ID fields of Custom Application [sys_app], or Store Application [sys_store_app] for an installed store app.'

// The API accepts scope or sys_id, not both.
function identify(args: Record<string, unknown>) {
  const sys_id = str(args.app_sys_id)
  if (sys_id) return { sys_id }
  const scope = str(args.scope)
  if (scope) return { scope }
  return undefined
}

const describeApp = (args: Record<string, unknown>) =>
  `${str(args.app_sys_id) ?? str(args.scope)}${str(args.version) ? ` ${str(args.version)}` : ""}`

const percentSuffix = (progress: Record<string, unknown>) =>
  progress.percent_complete === undefined ? "" : ` at ${String(progress.percent_complete)}%`

// Set by pollUntilFinal when the last GET never landed, so the timeout message
// says "I stopped being able to look" rather than implying ServiceNow went quiet.
const pollErrorSuffix = (progress: Record<string, unknown>) =>
  str(progress.poll_error) ? `; the last progress read failed with: ${str(progress.poll_error)}` : ""

const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined)
const num = (value: unknown) => (typeof value === "number" ? value : undefined)
// Agents routinely stringify booleans, so "true"/"false" are accepted alongside
// the real thing — same reasoning as confirmationFlag() in update-set-guard.ts.
const bool = (value: unknown, fallback: boolean) => {
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  return fallback
}
// Only forwarded when the caller actually set it; axios drops undefined params,
// which leaves ServiceNow's own default in charge.
const optionalBool = (value: unknown) => {
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  return undefined
}
const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {}
const statusOf = (error: unknown) => {
  const status = rec(rec(error).response).status
  return typeof status === "number" ? status : undefined
}
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const version = "1.0.0"
export const author = "Serac"
