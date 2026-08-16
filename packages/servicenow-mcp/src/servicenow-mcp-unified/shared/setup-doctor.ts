/**
 * Setup diagnosis: find out why ServiceNow calls fail, before a tool call has
 * to fail to tell you.
 *
 * The quick start asks people to create an OAuth Application Registry entry on
 * their instance before they have seen anything work. When they get it wrong,
 * the first symptom is an error inside some unrelated tool — often a JSON parse
 * error, because a hibernating developer instance answers every request with an
 * HTML login page. This module walks the same chain the server walks at
 * startup and says which link is broken and what to do about it.
 *
 * Two rules shape the design:
 *
 * 1. **Classification is pure.** Every "what does this mean" decision is a
 *    function from an observed response (status, content-type, body) to a
 *    `Check`. The network part only observes: `fetch` here never throws on a
 *    4xx and never parses eagerly. That is what makes this testable against
 *    real ServiceNow payloads without mocking an HTTP client.
 * 2. **Report the chain, not just the verdict.** `context-loader.ts` resolves
 *    credentials from env vars, then auth.json, then the enterprise portal, and
 *    the loudest failure mode is the second link quietly winning: a stale
 *    auth.json from an install you forgot about, pointing at a different
 *    instance than the env vars you just edited. So the credentials check names
 *    the file or variable that supplied each value, and lists the sources that
 *    were present but not used.
 *
 * Nothing here prints. `renderReport()` returns a string; the callers decide
 * where it goes — which matters on stdio, where stdout IS the JSON-RPC channel.
 */

import { existsSync, readFileSync, statSync } from "node:fs"

import { type ServiceNowContext } from "./types.js"
import {
  ENV_VARS,
  authJsonPaths,
  envCredential,
  loadContext,
  loadEnterpriseAuth,
  loadFromEnterprisePortal,
} from "./context-loader.js"

export type CheckStatus = "ok" | "warn" | "fail" | "skip"

export type CheckStep = "credentials" | "instance-url" | "instance" | "token" | "api" | "roles"

export interface Check {
  step: CheckStep
  status: CheckStatus
  /** Stable machine-readable classification, e.g. "instance-hibernating". */
  code: string
  /** One line naming what is wrong (or right). */
  title: string
  /** What was observed — including, verbatim, what ServiceNow answered. */
  detail: string[]
  /** Ordered next actions. Empty when there is nothing to do. */
  fix: string[]
}

/** A response as observed, before anyone decided what it means. */
export interface Observed {
  status: number
  contentType?: string
  body: string
  location?: string
}

/** A request that never got a response: DNS, TCP, TLS, or a timeout. */
export interface TransportFailure {
  code?: string
  message: string
}

export interface SetupReport {
  ok: boolean
  instanceUrl?: string
  checks: Check[]
}

const PROBE_TIMEOUT_MS = 10_000

/**
 * How much of a response body to keep. It has to be big enough to PARSE, not
 * just to quote: an admin's sys_user_has_role answer runs to tens of kilobytes,
 * and a body truncated mid-JSON parses as nothing at all — which would report
 * "no roles" for exactly the accounts that hold the most. Capped so a
 * misconfigured host cannot stream something unbounded into the report.
 */
const BODY_CAP = 256_000

/**
 * How many sys_user_has_role rows to ask for. One page, no paging: the report
 * is a diagnosis, not an inventory. 500 is well above any human account, but an
 * admin on a large instance can pass it — and a silently short list makes the
 * coverage numbers wrong in the worst direction, telling the most privileged
 * account on the instance that tools are out of its reach. So when the page
 * comes back full, the report says the counts are a floor instead of asserting
 * them.
 */
const ROLE_ROWS_CAP = 500

/**
 * Run every check, in the order a request travels: which credentials the chain
 * produced, whether the URL is usable, whether the instance answers, whether
 * the token exchange succeeds, whether the API accepts the token, and what the
 * authenticated account is actually allowed to do.
 *
 * Each step is skipped — not failed — when the step before it did not produce
 * what it needs, so the report always shows where the walk stopped.
 */
export const runSetupDoctor = async (options: { context?: ServiceNowContext } = {}): Promise<SetupReport> => {
  const chain = await resolveChain(options.context)
  const url = inspectInstanceUrl(chain.context.instanceUrl)
  const checks = [chain.check, url.check]

  if (!url.baseUrl) return finish(checks, undefined)

  const reachability = await probe(`${url.baseUrl}/api/now/table/sys_properties?sysparm_limit=1`)
  const reach =
    "failure" in reachability
      ? classifyTransportFailure(reachability.failure)
      : classifyReachability(reachability.observed)
  checks.push(reach)
  if (reach.status === "fail") return finish(checks, url.baseUrl)

  const hasOAuth = !!chain.context.clientId && !!chain.context.clientSecret
  const basic =
    chain.context.username && chain.context.password
      ? `Basic ${Buffer.from(`${chain.context.username}:${chain.context.password}`).toString("base64")}`
      : undefined

  if (!hasOAuth && !basic) {
    checks.push(skipped("token", "No credentials to exchange."), skipped("api", "No credentials to authenticate with."))
    return finish(checks, url.baseUrl)
  }

  // Mirrors shared/auth.ts: a refresh token is tried first when there is one,
  // and a refused refresh falls through to the client-credentials grant rather
  // than ending the run. The doctor reports both outcomes so a stale refresh
  // token in auth.json cannot masquerade as a bad client secret.
  const refreshed =
    hasOAuth && chain.context.refreshToken
      ? await exchangeToken(url.baseUrl, chain.context, "refresh_token")
      : undefined
  const exchange =
    hasOAuth && refreshed?.token === undefined
      ? await exchangeToken(url.baseUrl, chain.context, "client_credentials")
      : refreshed
  const authorization = exchange?.token ? `Bearer ${exchange.token}` : basic

  checks.push(
    exchange
      ? withDetail(
          exchange.check,
          refreshed && refreshed !== exchange
            ? [`the refresh_token grant was refused first: ${refreshed.check.title}`]
            : [],
        )
      : skipped("token", "Basic auth configured — no OAuth token exchange happens."),
  )

  if (!authorization) {
    checks.push(skipped("api", "No usable credential — the token exchange did not produce one."))
    return finish(checks, url.baseUrl)
  }

  const identity = await probe(
    `${url.baseUrl}/api/now/table/sys_user?${new URLSearchParams({
      sysparm_query: "sys_id=javascript:gs.getUserID()",
      sysparm_fields: "user_name,name,active",
      sysparm_limit: "1",
    }).toString()}`,
    authorization,
  )
  const api =
    "failure" in identity ? classifyTransportFailure(identity.failure) : classifyApiResponse(identity.observed)
  checks.push(api)
  if (api.status === "fail") return finish(checks, url.baseUrl)

  // Same query snow_session_context uses. Reading sys_user_has_role itself
  // needs a role, so a refusal here is a finding, not an error.
  const granted = await probe(
    `${url.baseUrl}/api/now/table/sys_user_has_role?${new URLSearchParams({
      sysparm_query: "user=javascript:gs.getUserID()",
      sysparm_fields: "role.name",
      sysparm_limit: String(ROLE_ROWS_CAP),
    }).toString()}`,
    authorization,
  )
  checks.push("failure" in granted ? classifyTransportFailure(granted.failure) : classifyRoles(granted.observed))

  return finish(checks, url.baseUrl)
}

/**
 * The report as a human reads it. Used by the `--doctor` flag and returned as
 * the MCP tool's summary, so it must stay plain text: no ANSI colour, no box
 * drawing, nothing that assumes a terminal.
 */
export const renderReport = (report: SetupReport): string => {
  const label: Record<CheckStep, string> = {
    credentials: "credentials",
    "instance-url": "instance url",
    instance: "instance",
    token: "oauth token",
    api: "api access",
    roles: "roles",
  }
  const marker: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" }

  // 2 spaces + a 4-char marker + 2 spaces + a 13-char label + 1 space, so
  // continuation lines land under the title rather than under the label.
  const indent = " ".repeat(22)
  const lines = report.checks.flatMap((check) => [
    `  ${marker[check.status]}  ${label[check.step].padEnd(13)} ${check.title}`,
    ...check.detail.map((line) => `${indent}${line}`),
    ...check.fix.map((line) => `${indent}-> ${line}`),
  ])

  const failed = report.checks.filter((check) => check.status === "fail")
  const warned = report.checks.filter((check) => check.status === "warn")
  const verdict =
    failed.length > 0
      ? `${failed.length} problem${failed.length === 1 ? "" : "s"} found. Fix the first FAIL above, then run this again.`
      : warned.length > 0
        ? `${warned.length} warning${warned.length === 1 ? "" : "s"}. The server will run, but read them.`
        : "Everything the server needs is in place."

  return ["ServiceNow MCP — setup check", "", ...lines, "", verdict].join("\n")
}

/**
 * What is wrong with an instance URL, and the base URL to use if it is
 * salvageable. Every case here is one someone actually pastes: the instance
 * name on its own, a full record URL copied out of the browser, a trailing
 * slash, http instead of https.
 */
export const inspectInstanceUrl = (raw: string | undefined): { check: Check; baseUrl?: string } => {
  const value = (raw ?? "").trim()
  if (value === "")
    return {
      check: {
        step: "instance-url",
        status: "fail",
        code: "instance-url-missing",
        title: "No instance URL configured.",
        detail: [],
        fix: ["Set SNOW_INSTANCE_URL to your instance, e.g. https://dev12345.service-now.com"],
      },
    }

  if (value.includes("your-") || value.includes("placeholder") || value.includes("YOUR_"))
    return {
      check: {
        step: "instance-url",
        status: "fail",
        code: "instance-url-placeholder",
        title: "The instance URL is still a placeholder.",
        detail: [`configured value: ${value}`],
        fix: ["Replace it with your real instance host, e.g. https://dev12345.service-now.com"],
      },
    }

  // URL.canParse rather than URL.parse: the latter only landed in Node 20.18,
  // and this package supports Node 20.
  const candidate = value.includes("://") ? value : `https://${value}`
  const parsed = URL.canParse(candidate) ? new URL(candidate) : undefined
  if (!parsed || parsed.hostname === "")
    return {
      check: {
        step: "instance-url",
        status: "fail",
        code: "instance-url-unparseable",
        title: "The instance URL is not a URL.",
        detail: [`configured value: ${value}`],
        fix: ["Use the host you log in to, with a scheme: https://dev12345.service-now.com"],
      },
    }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return {
      check: {
        step: "instance-url",
        status: "fail",
        code: "instance-url-scheme",
        title: `The instance URL uses the ${parsed.protocol} scheme.`,
        detail: [`configured value: ${value}`],
        fix: ["ServiceNow is reached over https: https://dev12345.service-now.com"],
      },
    }

  // A bare name — "dev12345" — is what developer.servicenow.com shows you, so
  // it gets pasted as-is. Complete it rather than failing on it, but say so:
  // the user's config is still wrong for every other tool that reads it.
  //
  // Only when the value is nothing BUT that name, though. A single-label host
  // with a scheme or a port is an on-prem instance behind corporate DNS
  // ("https://snprod:8443") or a local test server, and rewriting it would
  // point the probe — and the OAuth POST that carries the client secret —
  // at a service-now.com tenant the user never configured.
  const named = !parsed.hostname.includes(".") && parsed.port === "" && !value.includes("://")
  const baseUrl = named ? `https://${parsed.hostname}.service-now.com` : parsed.origin

  const notes = [
    ...(named ? [`"${parsed.hostname}" is an instance name, not a host — reading it as ${baseUrl}`] : []),
    ...(!value.includes("://") ? ["no scheme — reading it as https"] : []),
    ...(parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== ""
      ? [
          `everything after the host is ignored (${parsed.pathname}${parsed.search}${parsed.hash}) — this looks like a page URL, not the instance root`,
        ]
      : []),
    // Left in place it becomes "https://host//oauth_token.do", because every
    // caller concatenates a path onto this value.
    ...(value.endsWith("/") ? ["trailing slash — request URLs built from it get a doubled slash"] : []),
    ...(parsed.protocol === "http:" ? ["http, not https — credentials would cross the network in the clear"] : []),
  ]

  if (notes.length === 0)
    return {
      baseUrl,
      check: { step: "instance-url", status: "ok", code: "instance-url-ok", title: baseUrl, detail: [], fix: [] },
    }

  return {
    baseUrl,
    check: {
      step: "instance-url",
      status: "warn",
      code: "instance-url-normalized",
      title: `Using ${baseUrl}`,
      detail: [`configured value: ${value}`, ...notes],
      fix: [
        // Only worth saying when the value would actually change. An http URL
        // that is otherwise correct gets the https advice instead.
        ...(baseUrl === value ? [] : [`Set the instance URL to exactly ${baseUrl}`]),
        ...(parsed.protocol === "http:" ? ["Use https, unless this is a local test server."] : []),
      ],
    },
  }
}

/**
 * Does this host answer like a ServiceNow instance? Probed unauthenticated, so
 * it runs before credentials exist — which is the point: "your instance is
 * asleep" is the answer far more often than "your OAuth entry is wrong", and it
 * needs no OAuth entry to find out.
 */
export const classifyReachability = (observed: Observed): Check => {
  const html = htmlDiagnosis("instance", observed)
  if (html) return html

  if (observed.status >= 300 && observed.status < 400)
    return {
      step: "instance",
      status: "fail",
      code: "instance-redirects",
      title: "The instance redirected the REST API to a login page.",
      detail: [`HTTP ${observed.status}`, ...(observed.location ? [`location: ${observed.location}`] : [])],
      fix: [
        "A hibernating developer instance does this — wake it at https://developer.servicenow.com and wait a minute.",
        "Otherwise something in front of the instance (SSO portal, proxy, VPN gateway) is intercepting /api/now.",
      ],
    }

  if (observed.status === 401 || observed.status === 403)
    return {
      step: "instance",
      status: "ok",
      code: "instance-awake",
      title: "The instance is awake and answering the REST API.",
      detail: [`the unauthenticated probe answered HTTP ${observed.status}, which is what a healthy instance does`],
      fix: [],
    }

  if (observed.status === 404)
    return {
      step: "instance",
      status: "fail",
      code: "instance-not-servicenow",
      title: "That host answers, but /api/now/table is not there.",
      detail: ["HTTP 404", ...bodyDetail(observed)],
      fix: ["Check the host — this does not look like a ServiceNow instance."],
    }

  if (observed.status >= 500)
    return {
      step: "instance",
      status: "fail",
      code: "instance-error",
      title: `The instance answered HTTP ${observed.status}.`,
      detail: bodyDetail(observed),
      fix: [
        observed.status === 502 || observed.status === 503
          ? "502/503 from a developer instance usually means it is waking up or hibernating — open it in a browser, wait a minute, try again."
          : "The instance is failing on its own side. Try again, then check the instance in a browser.",
      ],
    }

  return {
    step: "instance",
    status: "ok",
    code: "instance-reachable",
    title: "The instance answered.",
    detail: [`unauthenticated probe answered HTTP ${observed.status}`],
    fix: [],
  }
}

/**
 * What `oauth_token.do` said. ServiceNow answers this endpoint with RFC 6749
 * error codes, so classify on `error` and quote `error_description` verbatim —
 * paraphrasing it is how "invalid_client" turns into a support thread.
 */
export const classifyTokenResponse = (observed: Observed): Check => {
  const html = htmlDiagnosis("token", observed)
  if (html) return html

  const body = parseJson(observed.body)
  const error = str(body?.error)
  const description = str(body?.error_description)
  const quoted = [
    `HTTP ${observed.status}`,
    ...(error ? [`ServiceNow said: ${error}${description ? ` — ${description}` : ""}`] : bodyDetail(observed)),
  ]

  if (str(body?.access_token))
    return {
      step: "token",
      status: "ok",
      code: "token-ok",
      title: "OAuth token exchange succeeded.",
      detail: [
        `token type ${str(body?.token_type) ?? "unknown"}, expires in ${typeof body?.expires_in === "number" ? body.expires_in : "?"}s`,
      ],
      fix: [],
    }

  if (error === "invalid_client")
    return {
      step: "token",
      status: "fail",
      code: "oauth-client-rejected",
      title: "ServiceNow rejected the client id or client secret.",
      detail: quoted,
      fix: [
        "Open System OAuth > Application Registry on the instance and compare the Client ID character for character.",
        "The client secret is only shown when the entry is created — if you are unsure, generate a new one and update your config.",
        "Copy the Client ID field, not the record's sys_id.",
      ],
    }

  if (error === "invalid_grant")
    return {
      step: "token",
      status: "fail",
      code: "oauth-grant-rejected",
      title: "The client is recognised, but the grant was refused.",
      detail: quoted,
      fix: [
        "For client_credentials: the Application Registry entry needs an OAuth application user, and that user must be active and unlocked.",
        "For refresh_token: refresh tokens expire (100 days by default) and are revoked when the entry changes — re-authorise to get a new one.",
      ],
    }

  if (error === "unauthorized_client" || error === "unsupported_grant_type")
    return {
      step: "token",
      status: "fail",
      code: "oauth-grant-not-allowed",
      title: "The OAuth entry does not allow this grant type.",
      detail: quoted,
      fix: [
        "On the Application Registry entry, allow the Client Credentials grant type (older releases hide it until the OAuth plugin is upgraded).",
        "If your instance cannot grant client_credentials, configure a refresh token or basic-auth credentials instead.",
      ],
    }

  if (error)
    return {
      step: "token",
      status: "fail",
      code: "oauth-error",
      title: `The token endpoint returned "${error}".`,
      detail: quoted,
      fix: ["Check the Application Registry entry on the instance against the message above."],
    }

  if (observed.status === 404)
    return {
      step: "token",
      status: "fail",
      code: "oauth-endpoint-missing",
      title: "/oauth_token.do is not there.",
      detail: quoted,
      fix: ["Check the instance URL — a ServiceNow instance always serves that endpoint."],
    }

  return {
    step: "token",
    status: "fail",
    code: "token-response-unrecognised",
    title: "The token endpoint answered with something unrecognisable.",
    detail: quoted,
    fix: ["Re-run with SNOW_MCP_DEBUG=true for the full exchange, and include the body above in a bug report."],
  }
}

/** What the REST API said when the token was actually used. */
export const classifyApiResponse = (observed: Observed): Check => {
  const html = htmlDiagnosis("api", observed)
  if (html) return html

  const body = parseJson(observed.body)
  const message = str(asRecord(body?.error)?.message) ?? str(asRecord(body?.error)?.detail)

  if (observed.status === 401)
    return {
      step: "api",
      status: "fail",
      code: "api-unauthorized",
      title: "The API rejected the token that was just issued.",
      detail: ["HTTP 401", ...(message ? [`ServiceNow said: ${message}`] : bodyDetail(observed))],
      fix: [
        "The account behind the OAuth entry may be inactive or locked out.",
        "If you switched instances, delete the cached token: ~/.serac/token-cache.json",
      ],
    }

  if (observed.status === 403)
    return {
      step: "api",
      status: "fail",
      code: "api-forbidden",
      title: "Authenticated, but not allowed to read sys_user.",
      detail: ["HTTP 403", ...(message ? [`ServiceNow said: ${message}`] : bodyDetail(observed))],
      fix: [
        "The account authenticated fine — it just holds no role that can read sys_user. Ask an admin to grant it one (itil or snc_internal is enough to start).",
      ],
    }

  if (observed.status !== 200)
    return {
      step: "api",
      status: "fail",
      code: "api-error",
      title: `The API answered HTTP ${observed.status}.`,
      detail: [...(message ? [`ServiceNow said: ${message}`] : bodyDetail(observed))],
      fix: [],
    }

  const user = asRecord(asArray(asRecord(body)?.result)?.[0])
  if (!user)
    return {
      step: "api",
      status: "warn",
      code: "api-user-unknown",
      title: "The API accepted the credentials, but did not resolve the current user.",
      detail: bodyDetail(observed),
      fix: ["Harmless for most tools. It usually means the account cannot read its own sys_user record."],
    }

  return {
    step: "api",
    status: "ok",
    code: "api-ok",
    title: `Authenticated as ${str(user.user_name) ?? "unknown"}${str(user.name) ? ` (${str(user.name)})` : ""}.`,
    detail: str(user.active) === "false" ? ["that account is marked inactive"] : [],
    fix: [],
  }
}

/**
 * A request that never got an answer. Kept as one finding with a named reason:
 * "unreachable" is the user's problem, "ENOTFOUND vs ECONNREFUSED" is the
 * detail that tells them which thing to fix.
 */
export const classifyTransportFailure = (failure: TransportFailure): Check => {
  const haystack = `${failure.code ?? ""} ${failure.message}`.toLowerCase()
  const reason =
    haystack.includes("enotfound") ||
    haystack.includes("eai_again") ||
    haystack.includes("getaddrinfo") ||
    haystack.includes("dns")
      ? {
          code: "instance-dns",
          title: "The instance host does not resolve.",
          fix: [
            "Check the host for a typo. A developer instance is dev12345.service-now.com — the number is on your developer.servicenow.com dashboard.",
          ],
        }
      : haystack.includes("econnrefused") ||
          haystack.includes("connectionrefused") ||
          haystack.includes("unable to connect")
        ? {
            code: "instance-refused",
            title: "The instance refused the connection.",
            fix: [
              "Nothing is listening on that host and port. Check the URL, and whether the instance is reachable from this network (VPN, proxy).",
            ],
          }
        : haystack.includes("timeout") || haystack.includes("timed out") || haystack.includes("aborted")
          ? {
              code: "instance-timeout",
              title: `The instance did not answer within ${PROBE_TIMEOUT_MS / 1000}s.`,
              fix: ["A hibernating instance can hang like this while it wakes. Open it in a browser, then try again."],
            }
          : haystack.includes("cert") || haystack.includes("tls") || haystack.includes("ssl")
            ? {
                code: "instance-tls",
                title: "The TLS handshake failed.",
                fix: ["A corporate proxy that re-signs TLS needs its CA trusted by node (NODE_EXTRA_CA_CERTS)."],
              }
            : {
                code: "instance-unreachable",
                title: "The instance could not be reached.",
                fix: ["Check network access to the instance from this machine."],
              }

  return {
    step: "instance",
    status: "fail",
    code: reason.code,
    title: reason.title,
    detail: [`${failure.code ? `${failure.code}: ` : ""}${failure.message}`],
    fix: reason.fix,
  }
}

export interface RoleCoverage {
  /** Tools in the manifest whose role requirement was resolved against a live instance. */
  resolved: number
  /** Tools the manifest could not resolve statically — no verdict either way. */
  unresolved: number
  unlocked: number
  blocked: number
  /** Roles that would unlock the most blocked tools, most first. */
  openers: { role: string; tools: number }[]
}

/**
 * How much of the catalog the given roles can actually run, from
 * `sn-roles.manifest.json`.
 *
 * Manifest semantics (see script/probe-sn-roles/README.md): `anyOf` lists roles
 * that suffice ALONE, `minimumBundle` is the smallest set needed TOGETHER, and
 * an empty bundle means the tool needs no role at all.
 */
export const summarizeRoleCoverage = (manifest: unknown, held: string[]): RoleCoverage => {
  const tools = Object.values(asRecord(asRecord(manifest)?.tools) ?? {})
    .map((tool) => asRecord(asRecord(tool)?.snRoles))
    .filter((roles): roles is Record<string, unknown> => roles !== undefined)
    .map((roles) => ({
      anyOf: (asArray(roles.anyOf) ?? []).map(String),
      bundle: (asArray(roles.minimumBundle) ?? []).map(String),
    }))

  const owned = new Set(held)
  const blocked = tools.filter(
    (tool) =>
      tool.bundle.length > 0 &&
      !tool.anyOf.some((role) => owned.has(role)) &&
      !tool.bundle.every((role) => owned.has(role)),
  )

  const openers = Object.entries(
    blocked
      .flatMap((tool) => tool.anyOf)
      .filter((role) => !owned.has(role))
      .reduce<Record<string, number>>((counts, role) => ({ ...counts, [role]: (counts[role] ?? 0) + 1 }), {}),
  )
    .map(([role, count]) => ({ role, tools: count }))
    .sort((a, b) => b.tools - a.tools)
    .slice(0, 5)

  return {
    resolved: tools.length,
    unresolved: Object.keys(asRecord(asRecord(manifest)?.tools) ?? {}).length - tools.length,
    unlocked: tools.length - blocked.length,
    blocked: blocked.length,
    openers,
  }
}

/**
 * The committed role manifest, or undefined when it is not on disk.
 *
 * Resolved relative to this module so it works from `src/` in a checkout and
 * from `dist/` in the npm tarball — both sit three levels under the package
 * root. `package.json` `files` ships it for exactly this reason.
 */
export const loadRolesManifest = (): unknown => readJson(new URL("../../../sn-roles.manifest.json", import.meta.url))

// ---------------------------------------------------------------------------
// Chain resolution
// ---------------------------------------------------------------------------

/**
 * Walk the credential chain the way the stdio bootstrap does, then report which
 * link won — by comparing the resolved values against each source, not by
 * re-deriving the decision. That is why a stale auth.json cannot hide here: if
 * the loaded instance URL came out of a file, this says which file.
 */
const resolveChain = async (supplied?: ServiceNowContext): Promise<{ context: ServiceNowContext; check: Check }> => {
  const envInstance = envCredential("instanceUrl")
  const envClientId = envCredential("clientId")
  const envClientSecret = envCredential("clientSecret")

  const files = authJsonPaths()
    .filter((path) => existsSync(path))
    .map((path) => ({ path, ...summarizeAuthFile(path) }))

  const local = loadContext()
  const enterprise =
    supplied === undefined && local.instanceUrl === "" && loadEnterpriseAuth()
      ? await loadFromEnterprisePortal()
      : undefined
  const context = supplied ?? enterprise ?? local

  const fromEnv = !!envInstance && !!context.instanceUrl && context.instanceUrl.includes(stripScheme(envInstance.value))
  const fromFile = fromEnv
    ? undefined
    : files.find((file) => file.instance !== undefined && context.instanceUrl.includes(stripScheme(file.instance)))
  const source = context.enterprise
    ? "the enterprise portal (credentials fetched at runtime)"
    : fromEnv
      ? `environment variables (${[envInstance, envClientId, envClientSecret]
          .filter((hit) => hit !== undefined)
          .map((hit) => hit.name)
          .join(", ")})`
      : fromFile
        ? `${fromFile.path} (modified ${fromFile.modified})`
        : undefined

  // Every source that carries credentials but did not supply these ones. This
  // is the "stale auth.json you forgot about" report, and it is also how a
  // half-set environment shows up: variables that are set but were skipped
  // because the environment link needs instance + id + secret together.
  const unused = [
    ...(!fromEnv && (envInstance || envClientId || envClientSecret)
      ? [
          `environment: ${[envInstance, envClientId, envClientSecret]
            .filter((hit) => hit !== undefined)
            .map((hit) => hit.name)
            .join(
              ", ",
            )} set, but the environment link needs instance + client id + client secret together, so it was skipped`,
        ]
      : []),
    ...files
      .filter((file) => file !== fromFile && file.instance !== undefined)
      .map((file) => `${file.path} holds credentials for ${file.instance}, modified ${file.modified} — not used`),
  ]

  if (!context.instanceUrl && !context.clientId && !context.username)
    return {
      context,
      check: {
        step: "credentials",
        status: "fail",
        code: "credentials-missing",
        title: "No ServiceNow credentials found anywhere in the chain.",
        detail: [
          `environment: none of ${[...ENV_VARS.instanceUrl, ...ENV_VARS.clientId].join(", ")} are set`,
          `auth.json: ${files.length === 0 ? `no file at any of the ${authJsonPaths().length} known paths` : files.map((file) => file.path).join(", ")}`,
          "enterprise portal: no enterprise session on this machine",
        ],
        fix: [
          "Set SNOW_INSTANCE_URL, SNOW_CLIENT_ID and SNOW_CLIENT_SECRET in your MCP client's env block.",
          "The client id and secret come from System OAuth > Application Registry on the instance.",
        ],
      },
    }

  const missing = [
    ...(context.instanceUrl ? [] : ["instance URL"]),
    ...(context.clientId || context.username ? [] : ["client id"]),
    ...(context.clientSecret || context.password ? [] : ["client secret"]),
  ]

  if (missing.length > 0)
    return {
      context,
      check: {
        step: "credentials",
        status: "fail",
        code: "credentials-partial",
        title: `Incomplete credentials — missing ${missing.join(" and ")}.`,
        detail: [...(source ? [`what was found came from ${source}`] : []), ...unused],
        fix: [`Supply the missing value from the same place as the rest: ${source ?? "your MCP client's env block"}.`],
      },
    }

  return {
    context,
    check: {
      step: "credentials",
      status: unused.length > 0 ? "warn" : "ok",
      code: unused.length > 0 ? "credentials-shadowed" : "credentials-ok",
      title: `Loaded from ${source ?? "the running server's own context — no local source matches it"}.`,
      detail: [
        `instance ${context.instanceUrl}`,
        context.clientId
          ? `client id ${redact(context.clientId)}, client secret ${context.clientSecret ? "set" : "MISSING"}`
          : `username ${context.username}, password ${context.password ? "set" : "MISSING"}`,
        ...(context.refreshToken ? ["a refresh token is present and will be tried first"] : []),
        ...unused,
      ],
      fix:
        unused.length > 0
          ? ["If the credentials above are not the ones you meant to use, remove the source you no longer want."]
          : [],
    },
  }
}

/**
 * Enough of an auth.json to report it: which instance it points at and whether
 * it holds credentials at all. Deliberately shallow — `loadFromAuthJson()` owns
 * the real validation, this only has to be able to name the file.
 */
const summarizeAuthFile = (path: string): { instance?: string; modified: string } => {
  const parsed = readJson(path)
  const servicenow = asRecord(parsed?.servicenow) ?? parsed
  const instance = str(servicenow?.instance)
  return {
    instance: instance && (servicenow?.clientId || servicenow?.username) ? instance : undefined,
    modified: statSync(path).mtime.toISOString().slice(0, 10),
  }
}

// ---------------------------------------------------------------------------
// Probing — observe only, decide nothing
// ---------------------------------------------------------------------------

const probe = async (
  url: string,
  authorization?: string,
): Promise<{ observed: Observed } | { failure: TransportFailure }> =>
  fetch(url, {
    headers: { Accept: "application/json", ...(authorization ? { Authorization: authorization } : {}) },
    // Manual: a redirect to a login page is a finding, and following it would
    // hide the status that identifies it.
    redirect: "manual",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
    .then(async (response) => ({
      observed: {
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        location: response.headers.get("location") ?? undefined,
        body: (await response.text()).slice(0, BODY_CAP),
      },
    }))
    .catch((error: unknown) => ({ failure: transportFailure(error) }))

const exchangeToken = async (
  baseUrl: string,
  context: ServiceNowContext,
  grant: "client_credentials" | "refresh_token",
): Promise<{ check: Check; token?: string }> => {
  const response = await fetch(`${baseUrl}/oauth_token.do`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: grant,
      client_id: context.clientId,
      client_secret: context.clientSecret,
      ...(grant === "refresh_token" ? { refresh_token: context.refreshToken ?? "" } : {}),
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
    .then(async (result) => ({
      observed: {
        status: result.status,
        contentType: result.headers.get("content-type") ?? undefined,
        location: result.headers.get("location") ?? undefined,
        body: (await result.text()).slice(0, BODY_CAP),
      },
    }))
    .catch((error: unknown) => ({ failure: transportFailure(error) }))

  if ("failure" in response) return { check: { ...classifyTransportFailure(response.failure), step: "token" } }
  return {
    check: classifyTokenResponse(response.observed),
    token: str(parseJson(response.observed.body)?.access_token),
  }
}

const transportFailure = (error: unknown): TransportFailure => {
  const record = asRecord(error)
  const cause = asRecord(record?.cause)
  return {
    code: str(record?.code) ?? str(cause?.code) ?? str(record?.name),
    message: str(record?.message) ?? String(error),
  }
}

// ---------------------------------------------------------------------------
// Shared classification
// ---------------------------------------------------------------------------

/**
 * The failure this whole feature exists for: a hibernating developer instance
 * answers every request — REST included — with an HTML page, so every tool
 * looks like it has a JSON parse bug. Detected by content, because the status
 * is usually 200 and the content-type is not always set.
 */
const htmlDiagnosis = (step: CheckStep, observed: Observed): Check | undefined => {
  const isHtml = (observed.contentType ?? "").includes("text/html") || /^\s*<(!doctype|html)/i.test(observed.body)
  if (!isHtml) return undefined

  if (/hibernat/i.test(observed.body))
    return {
      step,
      status: "fail",
      code: "instance-hibernating",
      title: "The instance is hibernating.",
      detail: [`HTTP ${observed.status}, ${observed.contentType ?? "no content-type"}`, ...bodyDetail(observed)],
      fix: [
        "Sign in at https://developer.servicenow.com, open your instance and press Wake.",
        "Give it a minute or two, then run this check again.",
        "Until then every tool call fails with what looks like a JSON parse error — that is this page, not a bug.",
      ],
    }

  return {
    step,
    status: "fail",
    code: "html-instead-of-json",
    title: "The instance answered with an HTML page instead of JSON.",
    detail: [`HTTP ${observed.status}, ${observed.contentType ?? "no content-type"}`, ...bodyDetail(observed)],
    fix: [
      "Almost always a hibernating developer instance — wake it at https://developer.servicenow.com and wait a minute.",
      "Otherwise this is a login page: something in front of the instance is intercepting the REST API, or the URL is not the instance root.",
    ],
  }
}

const classifyRoles = (observed: Observed): Check => {
  const html = htmlDiagnosis("roles", observed)
  if (html) return html

  const body = parseJson(observed.body)
  if (observed.status !== 200)
    return {
      step: "roles",
      status: "skip",
      code: "roles-unreadable",
      title: "Could not read the roles of the authenticated account.",
      detail: [
        `HTTP ${observed.status}`,
        ...(str(asRecord(body?.error)?.message) ? [`ServiceNow said: ${str(asRecord(body?.error)?.message)}`] : []),
      ],
      fix: [
        "Reading sys_user_has_role needs a role itself, so this usually means the account holds very few. Tool calls will still work where its roles allow.",
      ],
    }

  const rows = asArray(asRecord(body)?.result) ?? []
  const held = [
    ...new Set(rows.map((row) => str(asRecord(row)?.["role.name"])).filter((role): role is string => role !== undefined)),
  ].sort()

  const capped =
    rows.length >= ROLE_ROWS_CAP
      ? [`the query returned its full ${ROLE_ROWS_CAP}-row page, so this list is cut off and the counts below are a floor`]
      : []

  // Admin accounts hold hundreds of roles; the list is a hint, not an inventory.
  const listed = held.length > 12 ? `${held.slice(0, 12).join(", ")} and ${held.length - 12} more` : held.join(", ")

  const manifest = loadRolesManifest()
  if (!manifest)
    return {
      step: "roles",
      status: "ok",
      code: "roles-listed",
      title:
        held.length === 0
          ? "The account holds no roles."
          : `${held.length} role${held.length === 1 ? "" : "s"}: ${listed}`,
      detail: [...capped, "sn-roles.manifest.json is not installed, so tool coverage was not computed"],
      fix: [],
    }

  const coverage = summarizeRoleCoverage(manifest, held)
  const detail = [
    ...capped,
    `${coverage.unlocked} of ${coverage.resolved} tools with a known role requirement are within reach; ${coverage.blocked} are not`,
    `${coverage.unresolved} more tools have no statically resolvable requirement and were not counted`,
  ]

  if (coverage.blocked === 0)
    return {
      step: "roles",
      status: "ok",
      code: "roles-sufficient",
      title:
        held.length === 0
          ? "No roles held, and none are needed for the resolved catalog."
          : `${held.length} role${held.length === 1 ? "" : "s"}: ${listed}`,
      detail,
      fix: [],
    }

  return {
    step: "roles",
    status: "warn",
    code: held.length === 0 ? "roles-none" : "roles-partial",
    title:
      held.length === 0
        ? `Authenticated, but the account holds no roles — ${coverage.blocked} tools need one.`
        : `${held.length} role${held.length === 1 ? "" : "s"}: ${listed}`,
    detail,
    fix: [
      `Roles that would unlock the most: ${coverage.openers.map((opener) => `${opener.role} (+${opener.tools})`).join(", ")}`,
      "This is not a setup error — it is what the account can do. Ask an admin for the role a failing tool needs.",
    ],
  }
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

/** The order a request travels, which is the order the report reads in. */
const STEPS: CheckStep[] = ["credentials", "instance-url", "instance", "token", "api", "roles"]

/**
 * Close the report, filling in the steps the walk never reached so it always
 * shows all six and where it stopped.
 *
 * A warning or a skipped step is not a broken setup: "your account holds two
 * roles" and "basic auth needs no token exchange" are findings, not failures.
 */
const finish = (checks: Check[], instanceUrl: string | undefined): SetupReport => {
  const reached = new Set(checks.map((check) => check.step))
  const padded = [
    ...checks,
    ...STEPS.filter((step) => !reached.has(step)).map((step) =>
      skipped(step, "Not reached — fix the checks above first."),
    ),
  ].sort((a, b) => STEPS.indexOf(a.step) - STEPS.indexOf(b.step))
  return { ok: padded.every((check) => check.status !== "fail"), instanceUrl, checks: padded }
}

const skipped = (step: CheckStep, why: string): Check => ({
  step,
  status: "skip",
  code: `${step}-skipped`,
  title: why,
  detail: [],
  fix: [],
})

const withDetail = (check: Check, detail: string[]): Check =>
  detail.length === 0 ? check : { ...check, detail: [...check.detail, ...detail] }

/** One line of the body, quoted back. Users recognise their own error page. */
const bodyDetail = (observed: Observed): string[] => {
  const sample = observed.body.replace(/\s+/g, " ").trim()
  return sample === "" ? ["empty body"] : [`body: ${sample.slice(0, 160)}${sample.length > 160 ? "…" : ""}`]
}

const redact = (value: string): string => (value.length <= 4 ? "****" : `…${value.slice(-4)}`)

const stripScheme = (value: string): string => value.replace(/^https?:\/\//, "").replace(/\/+$/, "")

/** JSON.parse that answers undefined instead of throwing — these bodies are whatever the network handed us. */
const parseJson = (body: string): Record<string, unknown> | undefined => {
  try {
    return asRecord(JSON.parse(body))
  } catch {
    return undefined
  }
}

/**
 * Read and parse a JSON file, answering undefined for anything that goes wrong.
 * The doctor runs on machines where these files are half-written, owned by
 * another user, or not JSON at all — none of which is a reason to crash the one
 * command that is supposed to explain the mess.
 */
const readJson = (path: string | URL): Record<string, unknown> | undefined => {
  try {
    return parseJson(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asRecord = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined)

const asArray = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? value : undefined)

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)
