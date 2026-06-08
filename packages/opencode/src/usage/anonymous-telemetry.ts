import { Instance } from "@/project/instance"
import { Bus } from "@/bus"
import { MessageV2 } from "@/session/message-v2"
import { Log } from "@/util/log"
import { Installation } from "@/installation"
import { Flag } from "@/flag/flag"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { machineIdSync } from "node-machine-id"
import fs from "fs"
import path from "path"

const log = Log.create({ service: "usage.anonymous-telemetry" })

// Default points at the rebranded host. The legacy portal.serac.build
// origin redirects 301 to dashboard.serac.build, which Bun fetch follows
// by downgrading POST→GET (per WHATWG fetch spec for 301), silently
// dropping the body. Hitting the new host directly avoids the downgrade.
// Old installs still pinned at the legacy URL only land in telemetry once
// the nginx redirect is bumped to 308 (Permanent Redirect, method-preserving).
const PORTAL_URL = (process.env.SERAC_PORTAL_URL || process.env.SNOW_FLOW_PORTAL_URL) || "https://dashboard.serac.build"
const PENDING_END_PING_PATH = path.join(Global.Path.state, "anonymous-telemetry-pending-end.json")

interface TelemetryPingPayload {
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
  // Aggregate, content-free signals (end pings only): how many tool calls
  // ran per category, and which LLM provider family the session used.
  toolCounts?: Record<string, number>
  provider?: string
}

// Categorise a tool by name without sending the name itself: builtin coding
// tools vs the ServiceNow/Serac product tools vs any other MCP tool.
const BUILTIN_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "Task",
  "WebFetch",
  "WebSearch",
  "Skill",
  "TodoRead",
  "TodoWrite",
  "NotebookEdit",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
])

function toolCategory(tool: string): "builtin" | "servicenow" | "mcp" {
  if (BUILTIN_TOOLS.has(tool)) return "builtin"
  if (/^(snow|serac)_/i.test(tool)) return "servicenow"
  return "mcp"
}

function isDisabled(): boolean {
  const dnt = process.env.DO_NOT_TRACK?.toLowerCase()
  if (dnt === "1" || dnt === "true") return true
  if (Flag.OPENCODE_TELEMETRY_DISABLED) return true
  const ci = process.env.CI?.toLowerCase()
  if (ci === "true" || ci === "1") return true
  return false
}

function getMachineId(): string | undefined {
  try {
    return machineIdSync()
  } catch {
    return undefined
  }
}

function detectInstallMethod(): string {
  // Check npm
  if (process.env.npm_config_user_agent) return "npm"
  // Check bun
  if (typeof globalThis.Bun !== "undefined") return "bun"
  // Check homebrew
  const execPath = process.execPath || ""
  if (execPath.includes("Cellar") || execPath.includes("homebrew") || execPath.includes("linuxbrew")) return "brew"
  // Check standalone binary (no node_modules in path suggests binary distribution)
  if (!execPath.includes("node_modules") && !execPath.includes("node") && !execPath.includes("bun")) return "binary"
  return "other"
}

function writePendingEndPing(payload: TelemetryPingPayload): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_END_PING_PATH), { recursive: true })
    fs.writeFileSync(PENDING_END_PING_PATH, JSON.stringify(payload), "utf-8")
  } catch (error) {
    log.info("failed to persist pending telemetry ping", { error: String(error) })
  }
}

function readPendingEndPing(): TelemetryPingPayload | undefined {
  try {
    if (!fs.existsSync(PENDING_END_PING_PATH)) return undefined
    return JSON.parse(fs.readFileSync(PENDING_END_PING_PATH, "utf-8")) as TelemetryPingPayload
  } catch (error) {
    log.info("failed to read pending telemetry ping", { error: String(error) })
    return undefined
  }
}

function clearPendingEndPing(): void {
  try {
    if (fs.existsSync(PENDING_END_PING_PATH)) fs.unlinkSync(PENDING_END_PING_PATH)
  } catch (error) {
    log.info("failed to clear pending telemetry ping", { error: String(error) })
  }
}

async function flushPendingEndPing(): Promise<void> {
  const pending = readPendingEndPing()
  if (!pending) return
  const sent = await sendPing(pending)
  if (sent) clearPendingEndPing()
}

async function sendPing(payload: TelemetryPingPayload): Promise<boolean> {
  try {
    const response = await fetch(`${PORTAL_URL}/api/telemetry/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3_000),
    })
    log.info("telemetry ping sent", { status: response.status, type: payload.type })
    if ((process.env.SERAC_DEBUG_TELEMETRY || process.env.SNOW_FLOW_DEBUG_TELEMETRY)) {
      console.error(`[telemetry] ping OK (${payload.type}) → ${response.status}`)
    }
    return response.ok
  } catch (error) {
    log.info("telemetry ping failed", { error: String(error), type: payload.type })
    if ((process.env.SERAC_DEBUG_TELEMETRY || process.env.SNOW_FLOW_DEBUG_TELEMETRY)) {
      console.error(`[telemetry] ping failed (${payload.type}):`, String(error))
    }
    return false
  }
}

export namespace AnonymousTelemetry {
  const state = Instance.state(
    () => {
      if (isDisabled()) {
        log.info("anonymous telemetry disabled (env)")
        return { disabled: true as const, unsubs: [] as (() => void)[], startTime: 0, messageCount: 0 }
      }

      const machineId = getMachineId()
      if (!machineId) {
        log.info("anonymous telemetry disabled (no machine id)")
        return { disabled: true as const, unsubs: [] as (() => void)[], startTime: 0, messageCount: 0 }
      }

      let messageCount = 0
      let exitReason: "normal" | "error" | "interrupt" = "normal"
      let exitErrorMessage: string | undefined
      let configDisabled = false
      let endPingSent = false
      let provider: string | undefined
      const toolCounts: Record<string, number> = {}
      const startTime = Date.now()
      const sessionId = crypto.randomUUID()
      const installMethod = detectInstallMethod()

      const unsubs = [
        Bus.subscribe(MessageV2.Event.Updated, (event) => {
          const info = event.properties.info
          if (info.role === "user") messageCount++
          // Capture the LLM provider family (e.g. "anthropic", "openai",
          // "github-copilot", "ollama") — no model, no key, no content.
          else if (info.role === "assistant" && info.providerID) provider = info.providerID
        }),
        Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
          const part = event.properties.part
          if (part.type !== "tool") return
          if (part.state.status !== "completed" && part.state.status !== "error") return
          const category = toolCategory(part.tool)
          toolCounts[category] = (toolCounts[category] || 0) + 1
        }),
      ]

      const flushEndPing = async (reason?: "normal" | "error" | "interrupt", errorMessage?: string) => {
        if (configDisabled || endPingSent) return
        if (reason) exitReason = reason
        if (errorMessage) exitErrorMessage = errorMessage.slice(0, 500)
        endPingSent = true

        const payload: TelemetryPingPayload = {
          ...basePayload,
          type: "end",
          exitReason,
          exitErrorMessage,
          sessionDurationSec: Math.round((Date.now() - startTime) / 1000),
          messageCount,
          timestamp: Date.now(),
          ...(Object.keys(toolCounts).length > 0 ? { toolCounts } : {}),
          ...(provider ? { provider } : {}),
        }

        // Always persist before sending: process exit (even a normal one) can
        // tear down the event loop before the 3s fetch resolves, which is why
        // ~2/3 of sessions historically never delivered an end ping. The next
        // launch's flushPendingEndPing() retries; we clear only on success.
        writePendingEndPing(payload)
        const sent = await sendPing(payload)
        if (sent) clearPendingEndPing()
      }

      // Track exit reason via process signals
      const onError = (err: unknown) => {
        exitReason = "error"
        if (err instanceof Error) exitErrorMessage = `${err.name}: ${err.message}`.slice(0, 500)
        else if (typeof err === "string") exitErrorMessage = err.slice(0, 500)
        else exitErrorMessage = String(err).slice(0, 500)
        void flushEndPing("error", exitErrorMessage)
      }
      const onInterrupt = () => {
        exitReason = "interrupt"
        void flushEndPing("interrupt", undefined)
      }
      process.on("uncaughtException", onError)
      process.on("unhandledRejection", onError)
      process.on("SIGINT", onInterrupt)
      process.on("SIGTERM", onInterrupt)

      const basePayload = {
        machineId,
        sessionId,
        version: Installation.VERSION,
        channel: Installation.CHANNEL,
        os: process.platform,
        arch: process.arch,
        installMethod,
      }

      log.info("anonymous telemetry initializing", { machineId: machineId.slice(0, 8) + "..." })

      Config.get()
        .then(async (config) => {
          if (config.telemetry === false) {
            configDisabled = true
            log.info("anonymous telemetry disabled (config)")
            for (const unsub of unsubs) unsub()
            unsubs.length = 0
            return
          }
          await flushPendingEndPing()
          log.info("anonymous telemetry active, sending start ping")
          await sendPing({ ...basePayload, type: "start", sessionDurationSec: 0, messageCount: 0, timestamp: Date.now() })
        })
        .catch(async () => {
          await flushPendingEndPing()
          log.info("anonymous telemetry active (config unavailable), sending start ping")
          await sendPing({ ...basePayload, type: "start", sessionDurationSec: 0, messageCount: 0, timestamp: Date.now() })
        })

      return {
        disabled: false as const,
        unsubs,
        startTime,
        machineId,
        sessionId,
        basePayload,
        get messageCount() {
          return messageCount
        },
        get exitReason() {
          return exitReason
        },
        get exitErrorMessage() {
          return exitErrorMessage
        },
        get configDisabled() {
          return configDisabled
        },
        async flushEndPing() {
          await flushEndPing()
        },
        cleanup() {
          process.removeListener("uncaughtException", onError)
          process.removeListener("unhandledRejection", onError)
          process.removeListener("SIGINT", onInterrupt)
          process.removeListener("SIGTERM", onInterrupt)
        },
      }
    },
    async (current) => {
      for (const unsub of current.unsubs) unsub()
      if (current.disabled || current.configDisabled) return

      if ("cleanup" in current) current.cleanup()
      if ("flushEndPing" in current) await current.flushEndPing()
    },
  )

  export function init() {
    state()
  }
}
