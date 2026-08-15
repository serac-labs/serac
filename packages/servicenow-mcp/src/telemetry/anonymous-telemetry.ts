/**
 * Anonymous usage telemetry — stdio transport only.
 *
 * A port of `packages/opencode/src/usage/anonymous-telemetry.ts` from the CLI
 * that this package replaced. The behaviour is deliberately unchanged: one
 * ping when a session starts, one when it ends, an install identifier that is
 * a random UUID on disk (never derived from hardware), and an end ping that
 * is written to disk first so a process that dies mid-flight retries on the
 * next launch. The receiving end — `POST /api/telemetry/ping` in
 * serac-platform — is untouched.
 *
 * What it sends: install id, version, channel, OS, architecture, install
 * method, session duration, how the session ended, and per-category tool-call
 * counts. It never sends prompts, arguments, tool names, table names, sys_ids,
 * file paths, project names, instance URLs or credentials — nothing derived
 * from what the user was doing.
 *
 * WHY THIS FILE IS NOT IN `servicenow-mcp-unified/shared/`
 * --------------------------------------------------------
 * `shared/` is what both transports import. The HTTP transport is the
 * multi-tenant server the platform runs for its customers: a ping from there
 * would measure our own infrastructure, collapse many tenants into one
 * "install", and transmit on behalf of people who never installed anything.
 * Living outside the shared tree means the HTTP path cannot reach this module
 * by importing the directory it already depends on — the only importer is the
 * stdio entry point `servicenow-mcp-unified/index.ts`. That invariant is
 * pinned by `transports/__tests__/telemetry-stdio-only.test.ts`, which walks
 * the real import graph of both entry points.
 *
 * Opting out: set `DO_NOT_TRACK`, `SERAC_TELEMETRY_DISABLED`, or run in CI
 * (`CI`). Nothing is sent, and nothing is written to disk. An opt-out stops
 * transmission, including of anything a previous run left pending; it does not
 * delete files an earlier opted-in run already wrote — `rm -rf
 * $XDG_STATE_HOME/serac` (default `~/.local/state/serac`) does that, and
 * touches no credential.
 */

import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { mcpDebug } from "../shared/mcp-debug.js"

/**
 * `portal.serac.build` — an older default — no longer resolves, so any build
 * still pointing there loses every ping silently. Point at the current host
 * directly; a 301 would also be fatal, because fetch downgrades a redirected
 * POST to GET and drops the body.
 */
export const DEFAULT_PORTAL_URL = "https://dashboard.serac.build"
export const PING_PATH = "/api/telemetry/ping"

const SEND_TIMEOUT_MS = 3_000
/** How long a shutdown may wait for the end ping. See `TelemetrySession.settle`. */
const SETTLE_TIMEOUT_MS = 1_000

/** Mirrors `VALID_EXIT_REASONS` on the receiving route. */
export const EXIT_REASONS = ["normal", "error", "interrupt"] as const
export type ExitReason = (typeof EXIT_REASONS)[number]

/** Mirrors `VALID_INSTALL_METHODS` on the receiving route. */
export const INSTALL_METHODS = ["npm", "bun", "brew", "binary", "other"] as const
export type InstallMethod = (typeof INSTALL_METHODS)[number]

/** Mirrors `VALID_TOOL_CATEGORIES` on the receiving route. */
export const TOOL_CATEGORIES = ["builtin", "servicenow", "mcp"] as const
export type ToolCategory = (typeof TOOL_CATEGORIES)[number]

/**
 * Exactly the fields that leave this process.
 *
 * `messageCount` is not here on purpose. An MCP server never sees messages —
 * it sees JSON-RPC requests — so the CLI's message counter has no honest
 * value to carry. The receiving route treats a missing `messageCount` as 0,
 * which is what it means: not measured. Tool activity is reported through
 * `toolCounts` instead, which the route already sanitizes per category.
 */
export interface TelemetryPayload {
  machineId: string
  /** Optional on the wire: the route stores a missing session id as null. */
  sessionId?: string
  version: string
  /** Optional on the wire: the route defaults a missing channel to `latest`. */
  channel?: string
  os: string
  arch: string
  installMethod: InstallMethod
  type: "start" | "end"
  sessionDurationSec: number
  /**
   * Optional on the wire only in one case: a persisted ping whose timestamp
   * did not survive validation is sent without it, so the route stamps arrival
   * time rather than storing a 1970 row. Every payload this module builds has
   * one.
   */
  timestamp?: number
  exitReason?: ExitReason
  /**
   * The error's *class name* only ("TypeError", "McpError") — never its
   * message. The CLI sent 500 characters of the message; an MCP server's
   * errors routinely embed instance hostnames, table names, sys_ids and
   * query strings, all of which describe what the user was doing. The class
   * name keeps the drilldown on the dashboard useful and is content-free by
   * construction; `ERROR_NAME_PATTERN` enforces that.
   */
  exitErrorMessage?: string
  /** Per-category counts, e.g. `{ servicenow: 12, mcp: 3 }`. End pings only. */
  toolCounts?: Partial<Record<ToolCategory, number>>
}

/**
 * The complete set of keys that may appear in a payload.
 *
 * This is the wire contract, not a comment about one: `sanitizePayload`
 * rebuilds every outbound body from exactly these fields, so a key outside the
 * list cannot survive the trip whatever the caller passed. Tests pin the list
 * against what the sanitiser actually emits, in both directions.
 */
export const PAYLOAD_KEYS = [
  "machineId",
  "sessionId",
  "version",
  "channel",
  "os",
  "arch",
  "installMethod",
  "type",
  "sessionDurationSec",
  "timestamp",
  "exitReason",
  "exitErrorMessage",
  "toolCounts",
] as const

const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

// ---------------------------------------------------------------------------
// Wire sanitisation
// ---------------------------------------------------------------------------

/** Both ids are `crypto.randomUUID()` output. Nothing else is an id here. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Version/channel: what the route's `sanitizeString(..., 20)` accepts. */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/
/** `process.platform` / `process.arch` are lowercase alphanumerics, always. */
const PLATFORM_PATTERN = /^[a-z0-9]{1,20}$/

const MAX_TOOL_COUNT = 1_000_000

/**
 * Rebuild a payload from validated parts, or reject it entirely.
 *
 * Every request body goes through here (see `sendPing`), which is what makes
 * "no free-form text leaves this machine" a property of the transport rather
 * than of each caller. It matters because one caller does not build its own
 * payload: `flushPendingEndPing` reads last run's ping back off disk, and that
 * file is a plain 0644 JSON file any process running as this user can write.
 * Without this, a planted or drifted file would be POSTed verbatim — and the
 * receiving route stores `exitErrorMessage` free-form, so the client-side
 * check is the only thing standing between a hand-written file and a hostname
 * in the platform database.
 *
 * The patterns are deliberately tighter than "is a string": a UUID, a semver,
 * a lowercase platform token and an enum cannot express a URL, an email
 * address, a file path or a query. A field that fails is dropped when the
 * route treats it as optional, and fails the whole ping when the route
 * requires it — never repaired into something that looks plausible.
 */
export const sanitizePayload = (value: unknown): TelemetryPayload | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>

  const matching = (key: string, pattern: RegExp): string | undefined => {
    const candidate = raw[key]
    return typeof candidate === "string" && pattern.test(candidate) ? candidate : undefined
  }

  const oneOf = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const candidate = raw[key]
    return typeof candidate === "string" && (allowed as readonly string[]).includes(candidate)
      ? (candidate as T)
      : undefined
  }

  const wholeNumber = (key: string): number | undefined => {
    const candidate = raw[key]
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) return undefined
    return Math.floor(candidate)
  }

  // Required by the route: a ping missing any of these is a 400 anyway.
  const machineId = matching("machineId", UUID_PATTERN)
  const version = matching("version", VERSION_PATTERN)
  const platform = matching("os", PLATFORM_PATTERN)
  const arch = matching("arch", PLATFORM_PATTERN)
  const type = oneOf("type", ["start", "end"] as const)
  if (!machineId || !version || !platform || !arch || !type) return undefined

  const sessionId = matching("sessionId", UUID_PATTERN)
  const channel = matching("channel", VERSION_PATTERN)
  const installMethod = oneOf("installMethod", INSTALL_METHODS)
  const exitReason = type === "end" ? oneOf("exitReason", EXIT_REASONS) : undefined
  const errorName = exitReason === "error" ? matching("exitErrorMessage", ERROR_NAME_PATTERN) : undefined

  const toolCounts = ((): Partial<Record<ToolCategory, number>> | undefined => {
    const candidate = raw["toolCounts"]
    if (type !== "end" || typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return undefined
    const counts: Partial<Record<ToolCategory, number>> = {}
    for (const category of TOOL_CATEGORIES) {
      const count = (candidate as Record<string, unknown>)[category]
      if (typeof count !== "number" || !Number.isFinite(count)) continue
      const whole = Math.min(Math.max(0, Math.floor(count)), MAX_TOOL_COUNT)
      if (whole > 0) counts[category] = whole
    }
    return Object.keys(counts).length > 0 ? counts : undefined
  })()

  return {
    machineId,
    ...(sessionId ? { sessionId } : {}),
    version,
    ...(channel ? { channel } : {}),
    os: platform,
    arch,
    ...(installMethod ? { installMethod } : {}),
    type,
    sessionDurationSec: wholeNumber("sessionDurationSec") ?? 0,
    ...((): { timestamp?: number } => {
      const stamp = wholeNumber("timestamp")
      return stamp ? { timestamp: stamp } : {}
    })(),
    ...(exitReason ? { exitReason } : {}),
    ...(errorName ? { exitErrorMessage: errorName } : {}),
    ...(toolCounts ? { toolCounts } : {}),
  } as TelemetryPayload
}

// ---------------------------------------------------------------------------
// Opt-out
// ---------------------------------------------------------------------------

/**
 * True when any opt-out signal is set.
 *
 * Slightly broader than the CLI's `1`/`true` check: any value that is not
 * empty, `0` or `false` counts as opted out. Broadening an opt-out can only
 * ever send less, and `DO_NOT_TRACK=yes` from a user who meant it should not
 * silently keep tracking.
 */
export const isTelemetryDisabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const optedOut = (raw: string | undefined): boolean => {
    if (raw === undefined) return false
    const value = raw.trim().toLowerCase()
    return value !== "" && value !== "0" && value !== "false"
  }
  return optedOut(env["DO_NOT_TRACK"]) || optedOut(env["CI"]) || optedOut(env["SERAC_TELEMETRY_DISABLED"])
}

// ---------------------------------------------------------------------------
// State directory
// ---------------------------------------------------------------------------

/**
 * `$XDG_STATE_HOME/serac/telemetry`, defaulting to `~/.local/state/serac/telemetry`.
 *
 * The CLI used opencode's `Global.Path.state`, which was `xdgState/opencode` —
 * so XDG state is the faithful equivalent, not a new invention. It is also the
 * correct XDG category for this data: an install id is state that persists
 * between runs, is machine-local, is regenerable, and is neither configuration
 * (`XDG_CONFIG_HOME`) nor a disposable cache.
 *
 * Deliberately NOT `~/.serac` (`seracHomePath()`), which is where this package
 * keeps `auth.json`. Telemetry state and ServiceNow credentials should be
 * separately deletable: `rm -rf ~/.local/state/serac` resets the install id
 * without touching a single credential, which is exactly the reset a
 * privacy-minded user wants to be able to perform.
 *
 * Per the XDG spec a relative `XDG_STATE_HOME` is invalid and ignored.
 */
export const telemetryStateDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const configured = env["XDG_STATE_HOME"]?.trim()
  const home = env["HOME"] || env["USERPROFILE"] || os.homedir()
  const base = configured && path.isAbsolute(configured) ? configured : path.join(home, ".local", "state")
  return path.join(base, "serac", "telemetry")
}

export const installIdPath = (stateDir: string): string => path.join(stateDir, "install-id")
export const pendingEndPingPath = (stateDir: string): string => path.join(stateDir, "pending-end.json")

/**
 * A random identifier, generated once and kept in the state directory.
 *
 * `node-machine-id` is a dependency of this package but is deliberately not
 * used here: a hardware-derived id follows a machine across reinstalls and
 * across every product on it. A stored random value identifies an
 * installation, and deleting the state directory resets it. The trade-off is
 * that a reinstall counts as a new install; that is the right side to err on.
 */
export const resolveInstallId = (stateDir: string): string | undefined => {
  const file = installIdPath(stateDir)
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf-8").trim()
      if (existing) return existing
    }
    const fresh = randomUUID()
    fs.writeFileSync(file, fresh, "utf-8")
    return fresh
  } catch (error) {
    mcpDebug("[telemetry] could not establish an install id:", String(error))
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Version + channel
// ---------------------------------------------------------------------------

export interface PackageIdentity {
  version: string
  channel: string
}

/**
 * `dist/telemetry/anonymous-telemetry.js` and `src/telemetry/anonymous-telemetry.ts`
 * sit at the same depth (tsconfig.build.json maps rootDir `src` → outDir
 * `dist`), so one relative path reaches package.json in both layouts.
 */
const defaultPackageJsonPath = (): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json")

/**
 * Read version + channel from this package's own package.json.
 *
 * The CLI got these from build-time globals in a package that no longer
 * exists. `sanitizeString(version, 20)` on the receiving route rejects
 * anything outside `[a-zA-Z0-9._-]`, and a rejected version is a 400 for the
 * whole ping — so semver build metadata (`+sha`) is dropped and the result is
 * clamped to 20 characters. The channel is the first prerelease identifier
 * (`0.3.0-beta.1` → `beta`), or `latest` for a plain release, matching what
 * the route defaults to.
 */
export const readPackageIdentity = (packageJsonPath: string = defaultPackageJsonPath()): PackageIdentity => {
  const parse = (): string | undefined => {
    try {
      const raw = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { version?: unknown }
      return typeof raw.version === "string" ? raw.version : undefined
    } catch (error) {
      mcpDebug("[telemetry] could not read package.json:", String(error))
      return undefined
    }
  }

  const declared = parse()
  if (!declared) return { version: "0.0.0", channel: "local" }

  const withoutBuild = declared.split("+")[0] ?? declared
  const version = withoutBuild.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 20) || "0.0.0"
  const prerelease = version.split("-")[1]
  const channel = prerelease ? prerelease.split(".")[0]!.slice(0, 20) : "latest"
  return { version, channel }
}

// ---------------------------------------------------------------------------
// Install method
// ---------------------------------------------------------------------------

export interface InstallProbe {
  /** `npm_config_user_agent`, set by npx/bunx and by npm lifecycle scripts. */
  userAgent?: string
  /** `process.execPath` — the interpreter, or the executable for a compiled build. */
  execPath: string
  /** Filesystem path of this module. */
  modulePath: string
  /** Whether the Bun runtime is present. */
  hasBunRuntime: boolean
  /** Whether we appear to be inside a container image. */
  inContainer: boolean
}

/**
 * Map how this server was launched onto the receiving route's allowlist
 * (`npm | bun | brew | binary | other`). Anything outside it is dropped to
 * null server-side, so guessing a nicer-sounding value would just lose the
 * signal.
 *
 * The CLI detected CLI install shapes. An MCP server is typically started by
 * a client config as `npx @serac-labs/servicenow-mcp`, as a globally
 * installed binary on PATH, or as `docker run -i`. Mapping used here:
 *
 *   npx / npm-spawned          → npm
 *   bunx / the Bun runtime     → bun
 *   Homebrew-installed node    → brew
 *   compiled single-file build → binary
 *   installed under node_modules and spawned directly → npm
 *   container, pnpm/yarn dlx, a plain source checkout → other
 *
 * `other` is used where it is the truthful answer. Docker is not an install
 * method the allowlist knows about, and pretending `pnpm dlx` is npm would be
 * a lie about a different package manager — both are honestly `other`.
 */
export const detectInstallMethod = (probe: InstallProbe): InstallMethod => {
  // Checked first: in a container the image was built by someone else, so
  // whatever package manager ran during the build says nothing about how a
  // user installed anything.
  if (probe.inContainer) return "other"

  const agent = probe.userAgent?.trim().toLowerCase()
  if (agent) {
    if (agent.startsWith("bun")) return "bun"
    if (agent.startsWith("npm")) return "npm"
    // pnpm, yarn, deno, anything else: not in the allowlist.
    return "other"
  }

  const execPath = probe.execPath || ""
  if (/(^|\/)(Cellar|homebrew|linuxbrew)(\/|$)/i.test(execPath)) return "brew"

  // A compiled single-file executable runs itself, not an interpreter. Checked
  // before the Bun-runtime test because `bun build --compile` output also has
  // `globalThis.Bun`, and the honest answer there is "binary".
  const interpreter = path.basename(execPath).toLowerCase().replace(/\.exe$/, "")
  if (interpreter && interpreter !== "node" && interpreter !== "bun" && interpreter !== "deno") return "binary"

  if (probe.hasBunRuntime) return "bun"
  if (probe.modulePath.includes(`${path.sep}node_modules${path.sep}`)) return "npm"

  // Running from a source checkout under plain node.
  return "other"
}

const detectContainer = (): boolean => {
  try {
    if (fs.existsSync("/.dockerenv")) return true
    if (process.env["KUBERNETES_SERVICE_HOST"]) return true
    return false
  } catch {
    return false
  }
}

export const currentInstallProbe = (): InstallProbe => ({
  userAgent: process.env["npm_config_user_agent"],
  execPath: process.execPath || "",
  modulePath: (() => {
    try {
      return fileURLToPath(import.meta.url)
    } catch {
      return ""
    }
  })(),
  hasBunRuntime: typeof (globalThis as { Bun?: unknown }).Bun !== "undefined",
  inContainer: detectContainer(),
})

// ---------------------------------------------------------------------------
// Tool categories
// ---------------------------------------------------------------------------

/**
 * Reduce a tool name to one of the receiving route's categories. The name is
 * consumed here and never stored: only the per-category counter moves on.
 *
 * `builtin` is never produced. In the CLI it meant the agent's own
 * filesystem/shell tools; this server has none. It stays in the type because
 * the receiving end still accepts it and the shape must not drift.
 */
export const categorizeTool = (toolName: string): ToolCategory =>
  toolName.startsWith("snow_") ? "servicenow" : "mcp"

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * POST one ping. Never throws, never retries here.
 *
 * `abort` is how a shutdown reclaims the process: an in-flight fetch is a live
 * handle, so without it a portal that accepts a socket and never answers keeps
 * the server alive for the full send timeout after the client has already
 * closed the pipe. `AbortSignal.any` is deliberately not used — it is Node
 * 20.3+, and one controller listening to both sources works everywhere.
 */
export const sendPing = async (portalUrl: string, payload: TelemetryPayload, abort?: AbortSignal): Promise<boolean> => {
  // Sanitising here rather than at each call site is the point: this is the
  // only function in the package that opens a socket to the portal, so a
  // field that was never validated cannot reach the wire by any route.
  const body = sanitizePayload(payload)
  if (!body) {
    mcpDebug("[telemetry] refusing to send a payload that failed validation")
    return false
  }
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  const timer: any = setTimeout(stop, SEND_TIMEOUT_MS)
  timer?.unref?.()
  abort?.addEventListener("abort", stop, { once: true })
  try {
    const response = await fetch(`${portalUrl}${PING_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    mcpDebug(`[telemetry] ${payload.type} ping → ${response.status}`)
    return response.ok
  } catch (error) {
    mcpDebug(`[telemetry] ${payload.type} ping failed:`, String(error))
    return false
  } finally {
    clearTimeout(timer)
    abort?.removeEventListener("abort", stop)
  }
}

const writePendingEndPing = (stateDir: string, payload: TelemetryPayload): void => {
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(pendingEndPingPath(stateDir), JSON.stringify(payload), "utf-8")
  } catch (error) {
    mcpDebug("[telemetry] could not persist the pending end ping:", String(error))
  }
}

const clearPendingEndPing = (stateDir: string): void => {
  try {
    fs.rmSync(pendingEndPingPath(stateDir), { force: true })
  } catch {
    /* nothing to do — the next run overwrites it */
  }
}

/**
 * Deliver the previous run's end ping, if it never made it.
 *
 * A process exit tears down the event loop before an in-flight fetch can
 * resolve, which is why end pings were historically far rarer than starts.
 * Every end ping is written to disk first and only cleared once it has been
 * accepted; this is where the retry happens.
 *
 * The file is treated as untrusted input, because it is: it is a world-readable
 * JSON file in a predictable location, and a future version of this package
 * could also leave a differently-shaped one behind. It is re-validated through
 * `sanitizePayload` and discarded — not sent, not kept — when it is not a
 * well-formed end ping.
 */
export const flushPendingEndPing = async (stateDir: string, portalUrl: string, abort?: AbortSignal): Promise<boolean> => {
  const file = pendingEndPingPath(stateDir)
  const pending = ((): TelemetryPayload | undefined => {
    try {
      if (!fs.existsSync(file)) return undefined
      const parsed = sanitizePayload(JSON.parse(fs.readFileSync(file, "utf-8")))
      if (parsed?.type === "end") return parsed
      mcpDebug("[telemetry] discarding a pending end ping that is not a valid end payload")
      clearPendingEndPing(stateDir)
      return undefined
    } catch (error) {
      mcpDebug("[telemetry] could not read the pending end ping:", String(error))
      clearPendingEndPing(stateDir)
      return undefined
    }
  })()
  if (!pending) return false
  const sent = await sendPing(portalUrl, pending, abort)
  if (sent) clearPendingEndPing(stateDir)
  return sent
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionDeps {
  env?: NodeJS.ProcessEnv
  stateDir?: string
  portalUrl?: string
  identity?: PackageIdentity
  installMethod?: InstallMethod
  now?: () => number
}

export interface TelemetrySession {
  /** False when opted out or when no install id could be established. */
  readonly enabled: boolean
  /** Fire the start ping and retry the previous run's end ping. Non-blocking. */
  start: () => void
  /** Count one tool call by category. The name is not retained. */
  recordToolCall: (toolName: string) => void
  /** Persist and send the end ping. Idempotent, non-blocking. */
  finish: (reason: ExitReason, error?: unknown) => void
  /** Synchronous, network-free end. For `process.on("exit")` and for crashes. */
  persistPendingEnd: (reason: ExitReason, error?: unknown) => void
  /** Briefly wait for the in-flight pings before the process exits. */
  settle: (timeoutMs?: number) => Promise<void>
  /** Test seam: resolves once the in-flight pings settle. */
  readonly inFlight: () => Promise<void>
}

/**
 * The error's class name, if it is one.
 *
 * Wrapped in a try/catch because reading `.name` runs user code: an object
 * whose `name` is a throwing getter would otherwise make `finish()` throw, and
 * both of its callers are the worst possible places for that — the fatal-error
 * handler in the stdio entry (the throw would escape `main()` and skip
 * `process.exit(1)`) and the `uncaughtExceptionMonitor` handler. This module
 * promises that every failure path is silent and non-fatal; that has to
 * include this one.
 */
const errorClassName = (error: unknown): string | undefined => {
  try {
    const name = error instanceof Error ? error.name : typeof error === "object" && error ? error.constructor?.name : undefined
    return typeof name === "string" && ERROR_NAME_PATTERN.test(name) ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * Build a telemetry session. All state lives in this closure — the module
 * itself holds none, so a process can hold several (the tests do) and nothing
 * leaks between them.
 *
 * Every failure path is silent and non-fatal: a missing state directory, an
 * unreachable portal, a malformed package.json and a rejected fetch all end
 * as a no-op. Nothing here is ever awaited by the MCP server.
 */
export const createSession = (deps: SessionDeps = {}): TelemetrySession => {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const portalUrl = (deps.portalUrl ?? env["SERAC_PORTAL_URL"] ?? DEFAULT_PORTAL_URL).replace(/\/+$/, "")
  const stateDir = deps.stateDir ?? telemetryStateDir(env)

  const counts: Partial<Record<ToolCategory, number>> = {}
  // Aborted by `settle()` when it runs out of patience, so a hung request can
  // never be what keeps a finished server's process alive.
  const shutdown = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const track = (promise: Promise<unknown>): void => {
    pending.add(promise)
    void promise.finally(() => pending.delete(promise))
  }

  const disabled = isTelemetryDisabled(env)
  const machineId = disabled ? undefined : resolveInstallId(stateDir)

  const noop: TelemetrySession = {
    enabled: false,
    start: () => {},
    recordToolCall: () => {},
    finish: () => {},
    persistPendingEnd: () => {},
    settle: async () => {},
    inFlight: async () => {},
  }

  if (disabled) {
    mcpDebug("[telemetry] disabled by environment")
    return noop
  }
  if (!machineId) return noop

  const identity = deps.identity ?? readPackageIdentity()
  const installMethod = deps.installMethod ?? detectInstallMethod(currentInstallProbe())
  const sessionId = randomUUID()
  const startedAt = now()

  const state = { started: false, ended: false }

  const base = {
    machineId,
    sessionId,
    version: identity.version,
    channel: identity.channel,
    os: process.platform,
    arch: process.arch,
    installMethod,
  }

  const endPayload = (reason: ExitReason, error?: unknown): TelemetryPayload => {
    const name = reason === "error" ? errorClassName(error) : undefined
    return {
      ...base,
      type: "end",
      sessionDurationSec: Math.max(0, Math.round((now() - startedAt) / 1000)),
      timestamp: now(),
      exitReason: reason,
      ...(name ? { exitErrorMessage: name } : {}),
      ...(Object.keys(counts).length > 0 ? { toolCounts: { ...counts } } : {}),
    }
  }

  return {
    enabled: true,

    start: () => {
      if (state.started) return
      state.started = true
      track(flushPendingEndPing(stateDir, portalUrl, shutdown.signal))
      track(sendPing(portalUrl, { ...base, type: "start", sessionDurationSec: 0, timestamp: now() }, shutdown.signal))
    },

    recordToolCall: (toolName: string) => {
      if (!toolName) return
      const category = categorizeTool(toolName)
      counts[category] = (counts[category] ?? 0) + 1
    },

    finish: (reason: ExitReason, error?: unknown) => {
      if (state.ended) return
      state.ended = true
      const payload = endPayload(reason, error)
      // Persist first, always: if the process dies before the fetch resolves,
      // the next launch retries it. Only a confirmed delivery clears the file.
      writePendingEndPing(stateDir, payload)
      track(
        sendPing(portalUrl, payload, shutdown.signal).then((sent) => {
          if (sent) clearPendingEndPing(stateDir)
        }),
      )
    },

    persistPendingEnd: (reason: ExitReason, error?: unknown) => {
      if (state.ended) return
      state.ended = true
      writePendingEndPing(stateDir, endPayload(reason, error))
    },

    /**
     * Wait, with a hard cap, for the in-flight pings — then decide what an
     * unanswered request means.
     *
     * `finish()` keeps the end ping on disk until delivery is *confirmed*, so
     * a ping the portal accepted at 1.2s while this cap expired at 1.0s would
     * be re-sent by the next launch and stored twice; the route has no dedupe,
     * and a duplicate end row double-counts tool calls and pushes the session
     * completion rate above 100%. Reproduced with a portal held at a 1.2s
     * round trip: 7 stored end rows for 4 real sessions.
     *
     * So an unconfirmed request is treated as delivered and the file is
     * dropped. The alternative — waiting longer — delays every shutdown for
     * everyone, and the alternative to that is corrupting the numbers. Only
     * the ambiguous case is affected: a portal that is offline, refusing
     * connections or unresolvable rejects in milliseconds, well inside the
     * cap, and those pings are still kept and retried on the next launch. The
     * cost is an occasional lost end ping for a user behind a connection that
     * accepts a socket and never answers, which is the right way round —
     * under-counting is a shape this dashboard already has, over-counting is
     * not.
     *
     * Reaching the cap also aborts the requests. A pending fetch is a live
     * handle that keeps the process alive on its own, so on the shutdown path
     * that does not call `process.exit` — a client closing stdin — leaving it
     * running would hold a finished server open for the full send timeout.
     * Aborting makes the cap a real ceiling on how long telemetry can outlive
     * the server: measured against a portal that never answers, 5.2s down to
     * 1.1s.
     */
    settle: async (timeoutMs = SETTLE_TIMEOUT_MS) => {
      if (pending.size === 0) return
      const timedOut = await Promise.race([
        Promise.allSettled([...pending]).then(() => false),
        new Promise<boolean>((resolve) => {
          const timer: any = setTimeout(() => resolve(true), timeoutMs)
          timer?.unref?.()
        }),
      ])
      if (!timedOut) return
      shutdown.abort()
      if (state.ended) clearPendingEndPing(stateDir)
    },

    inFlight: async () => {
      await Promise.allSettled([...pending])
    },
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

const singleton: { session?: TelemetrySession } = {}

/**
 * The process-lifetime session used by the stdio entry point. For stdio,
 * process lifetime *is* the session: one user, one client, one server
 * process, start to exit.
 */
export const AnonymousTelemetry = {
  /**
   * Call once from the stdio entry point. Never throws, never awaits.
   *
   * Two process listeners are attached, both chosen so the MCP server's own
   * behaviour does not change:
   *
   *   - `uncaughtExceptionMonitor`, not `uncaughtException`. Registering an
   *     `uncaughtException` handler *suppresses* the default crash, which
   *     would leave a broken MCP server running and answering requests. The
   *     monitor variant observes the error and lets Node die exactly as it
   *     would have. Since Node 15 an unhandled rejection is raised as an
   *     uncaught exception too, so this covers both without a
   *     `unhandledRejection` listener, which would also swallow the default.
   *
   *     It only *persists* the end ping. Sending is pointless here and worse
   *     than pointless: the process is already dying, so nothing can observe
   *     the response and clear the file. A live crash run showed the request
   *     arriving and being stored, the process dying before the 200 was read,
   *     and the next launch re-sending the same session — two end rows for one
   *     crash. Deferring delivery to the next launch's flush makes the crash
   *     path exactly-once, like the normal-exit path already is.
   *   - `beforeExit`, which is how the *common* shutdown is caught. The MCP
   *     spec's first step for stopping a stdio server is to close the child's
   *     stdin and wait; no signal is sent, and the SDK's
   *     `StdioServerTransport` never listens for stdin's `end` either, so
   *     nothing in the server observes that shutdown at all. What actually
   *     happens is that the event loop runs dry — which is precisely when
   *     `beforeExit` fires, and only then, since a connected transport keeps
   *     stdin referenced. Sending here rather than only persisting is what
   *     stops every end ping from arriving one launch late, with the last
   *     session before a user stops never arriving at all. The in-flight ping
   *     re-fills the event loop by itself, so the process lives exactly as
   *     long as the request does (3s ceiling, the fetch's own timeout) and
   *     `beforeExit` firing again afterwards is a no-op, because `finish()`
   *     is idempotent.
   *   - `exit`, which must be synchronous: it only writes the pending end
   *     ping, leaving delivery to the next launch's flush. It is the backstop
   *     for the paths `beforeExit` never sees — `process.exit()` and a fatal
   *     signal.
   *
   * SIGINT/SIGTERM are intentionally NOT handled here. The entry point already
   * owns those, and a second listener registered before the entry point's own
   * would swallow the signal during startup and hang the server.
   */
  start: (deps: SessionDeps = {}): void => {
    if (singleton.session) return
    const session = createSession(deps)
    singleton.session = session
    if (!session.enabled) return
    session.start()
    process.on("uncaughtExceptionMonitor", (error: unknown) => session.persistPendingEnd("error", error))
    process.on("beforeExit", () => {
      session.finish("normal")
      void session.settle()
    })
    process.on("exit", () => session.persistPendingEnd("normal"))
  },

  recordToolCall: (toolName: string): void => singleton.session?.recordToolCall(toolName),

  finish: (reason: ExitReason, error?: unknown): void => singleton.session?.finish(reason, error),

  /**
   * Wait, briefly and with a hard cap, for the end ping to settle. Call this
   * on a shutdown path that ends in `process.exit()`, after the server has
   * been stopped.
   *
   * Why this exists: `finish()` persists the end ping and only deletes the
   * file once delivery is confirmed. `process.exit()` tears the event loop
   * down mid-fetch, so a ping the portal *did* accept still left its file
   * behind — and the next launch re-sent it. That produced a duplicate end
   * row for every clean session, and the receiving route has no dedupe. A
   * live run against a local portal reproduced it on every single session.
   *
   * This delays nothing the user is waiting on: the MCP server is already
   * closed by this point, no request can be in flight, and the cap is one
   * second (the ping's own timeout is three). See `TelemetrySession.settle`
   * for what happens when the cap is reached.
   */
  settle: (timeoutMs?: number): Promise<void> => singleton.session?.settle(timeoutMs) ?? Promise.resolve(),
}
