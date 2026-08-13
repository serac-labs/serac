/**
 * Anonymous usage telemetry.
 *
 * Re-ported onto this branch's architecture — see issue #269. The original
 * module lived on the pre-rebuild fork line, which shares no git ancestry
 * with this history, so every import in it resolved to a module that no
 * longer exists. This is a rewrite against the current layout, not a
 * cherry-pick.
 *
 * What it sends: an install identifier, version, channel, OS, architecture,
 * how the CLI was installed, how long the session lasted, and how it ended.
 * No prompts, no file paths, no project names, no model or provider keys —
 * nothing derived from what the user was working on.
 *
 * Opting out: set `DO_NOT_TRACK=1`, `SERAC_TELEMETRY_DISABLED=1`, or run in
 * CI (`CI=true`), and nothing is sent or written.
 */

import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { InstallationVersion, InstallationChannel } from "@opencode-ai/core/installation/version"
import fs from "fs"
import path from "path"

const log = Log.create({ service: "usage.anonymous-telemetry" })

/**
 * `portal.serac.build` — the old default — no longer resolves at all, so any
 * build still pointing there loses every ping silently. Point at the current
 * host directly; a 301 would also be fatal here, because fetch downgrades a
 * redirected POST to GET and drops the body.
 */
const PORTAL_URL = process.env["SERAC_PORTAL_URL"] || "https://dashboard.serac.build"

const STATE_DIR = path.join(Global.Path.state, "telemetry")
const INSTALL_ID_PATH = path.join(STATE_DIR, "install-id")
const PENDING_END_PING_PATH = path.join(STATE_DIR, "pending-end.json")

const SEND_TIMEOUT_MS = 3_000

export interface TelemetryPingPayload {
  machineId: string
  sessionId: string
  version: string
  channel: string
  os: string
  arch: string
  installMethod: string
  type: "start" | "end"
  sessionDurationSec: number
  messageCount: number
  timestamp: number
  exitReason?: "normal" | "error" | "interrupt"
  exitErrorMessage?: string
}

function isDisabled(): boolean {
  const dnt = process.env["DO_NOT_TRACK"]?.toLowerCase()
  if (dnt === "1" || dnt === "true") return true
  const ci = process.env["CI"]?.toLowerCase()
  if (ci === "1" || ci === "true") return true
  const off = process.env["SERAC_TELEMETRY_DISABLED"]?.toLowerCase()
  if (off === "1" || off === "true") return true
  return false
}

const debug = () => Boolean(process.env["SERAC_DEBUG_TELEMETRY"])

/**
 * A random identifier, generated once and kept in the state directory.
 *
 * The old module derived this from machine hardware via `node-machine-id`.
 * A stored random value is both one dependency lighter and genuinely
 * anonymous — it identifies an installation, not a machine, and deleting the
 * state directory resets it. The trade-off is that a reinstall counts as a
 * new install; that is the right side to err on.
 */
function installId(): string | undefined {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    if (fs.existsSync(INSTALL_ID_PATH)) {
      const existing = fs.readFileSync(INSTALL_ID_PATH, "utf-8").trim()
      if (existing) return existing
    }
    const fresh = crypto.randomUUID()
    fs.writeFileSync(INSTALL_ID_PATH, fresh, "utf-8")
    return fresh
  } catch (error) {
    log.info("could not establish an install id", { error: String(error) })
    return undefined
  }
}

function detectInstallMethod(): string {
  if (process.env["npm_config_user_agent"]) return "npm"
  if (typeof (globalThis as any).Bun !== "undefined") return "bun"
  const execPath = process.execPath || ""
  if (execPath.includes("Cellar") || execPath.includes("homebrew") || execPath.includes("linuxbrew")) return "brew"
  if (!execPath.includes("node_modules") && !execPath.includes("node") && !execPath.includes("bun")) return "binary"
  return "other"
}

async function sendPing(payload: TelemetryPingPayload): Promise<boolean> {
  try {
    const response = await fetch(`${PORTAL_URL}/api/telemetry/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    log.info("ping sent", { status: response.status, type: payload.type })
    if (debug()) console.error(`[telemetry] ${payload.type} → ${response.status}`)
    return response.ok
  } catch (error) {
    log.info("ping failed", { error: String(error), type: payload.type })
    if (debug()) console.error(`[telemetry] ${payload.type} failed:`, String(error))
    return false
  }
}

function writePendingEndPing(payload: TelemetryPingPayload): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(PENDING_END_PING_PATH, JSON.stringify(payload), "utf-8")
  } catch (error) {
    log.info("could not persist the pending end ping", { error: String(error) })
  }
}

function clearPendingEndPing(): void {
  try {
    fs.rmSync(PENDING_END_PING_PATH, { force: true })
  } catch {
    /* nothing to do — the next run overwrites it */
  }
}

/**
 * Deliver the previous run's end ping, if it never made it.
 *
 * A process exit tears down the event loop before an in-flight fetch can
 * resolve, which is why end pings were historically far rarer than starts.
 * Every end ping is therefore written to disk first and only cleared once it
 * has actually been accepted; this is where the retry happens.
 */
async function flushPendingEndPing(): Promise<void> {
  let pending: TelemetryPingPayload | undefined
  try {
    if (!fs.existsSync(PENDING_END_PING_PATH)) return
    pending = JSON.parse(fs.readFileSync(PENDING_END_PING_PATH, "utf-8")) as TelemetryPingPayload
  } catch (error) {
    log.info("could not read the pending end ping", { error: String(error) })
    clearPendingEndPing()
    return
  }
  if (!pending) return
  if (await sendPing(pending)) clearPendingEndPing()
}

export namespace AnonymousTelemetry {
  let started = false

  /**
   * Call once, as early in the process as possible. Never throws and never
   * blocks: the start ping and the previous run's retry are both fired
   * without awaiting.
   */
  export function start(): void {
    if (started) return
    started = true

    if (isDisabled()) {
      log.info("disabled by environment")
      return
    }

    const machineId = installId()
    if (!machineId) return

    const sessionId = crypto.randomUUID()
    const startTime = Date.now()

    const base = {
      machineId,
      sessionId,
      version: InstallationVersion,
      channel: InstallationChannel,
      os: process.platform,
      arch: process.arch,
      installMethod: detectInstallMethod(),
      // Counting messages and tool calls needs a subscription to the event
      // stream, which is effect-based here and deserves its own change. The
      // field stays on the payload so the receiving end is unchanged.
      messageCount: 0,
    }

    void flushPendingEndPing()
    void sendPing({ ...base, type: "start", sessionDurationSec: 0, timestamp: Date.now() })

    let ended = false
    const endPayload = (reason: "normal" | "error" | "interrupt", message?: string): TelemetryPingPayload => ({
      ...base,
      type: "end",
      sessionDurationSec: Math.round((Date.now() - startTime) / 1000),
      timestamp: Date.now(),
      exitReason: reason,
      ...(message ? { exitErrorMessage: message.slice(0, 500) } : {}),
    })

    const finish = (reason: "normal" | "error" | "interrupt", message?: string) => {
      if (ended) return
      ended = true
      const payload = endPayload(reason, message)
      // Persist first, always: if the process dies before the fetch resolves
      // the next launch retries it. Only a confirmed delivery clears the file.
      writePendingEndPing(payload)
      void sendPing(payload).then((sent) => {
        if (sent) clearPendingEndPing()
      })
    }

    const describe = (err: unknown): string => {
      if (err instanceof Error) return `${err.name}: ${err.message}`
      if (typeof err === "string") return err
      return String(err)
    }

    process.on("uncaughtException", (err) => finish("error", describe(err)))
    process.on("unhandledRejection", (err) => finish("error", describe(err)))
    process.on("SIGINT", () => finish("interrupt"))
    process.on("SIGTERM", () => finish("interrupt"))
    // `exit` handlers must be synchronous, so this only writes the file —
    // delivery is left to the next run's flush.
    process.on("exit", () => {
      if (ended) return
      ended = true
      writePendingEndPing(endPayload("normal"))
    })
  }
}
