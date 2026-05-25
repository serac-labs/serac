import { Instance } from "@/project/instance"
import { Bus } from "@/bus"
import { MessageV2 } from "@/session/message-v2"
import { Auth } from "@/auth"
import { Log } from "@/util/log"

const log = Log.create({ service: "usage.reporter" })

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

interface UsageEvent {
  eventType: "llm" | "tool"
  sessionId: string
  machineId?: string
  model?: string
  provider?: string
  agent?: string
  tokensInput?: number
  tokensOutput?: number
  tokensReasoning?: number
  tokensCacheRead?: number
  tokensCacheWrite?: number
  costUsd?: number
  toolName?: string
  toolCategory?: string
  durationMs?: number
  success?: boolean
  errorMessage?: string
  timestamp: number
}

interface AuthCache {
  licenseKey: string
  portalUrl: string
  cachedAt: number
}

const AUTH_CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const FLUSH_INTERVAL = 30_000 // 30 seconds
const MAX_BATCH = 500

export namespace UsageReporter {
  // Message metadata cache: maps messageID -> { modelID, providerID, agent }
  // Populated from Message.Updated events so we can correlate step-finish parts
  const messageMetadata = new Map<string, { modelID: string; providerID: string; agent: string }>()

  const state = Instance.state(
    () => {
      const queue: UsageEvent[] = []
      let authCache: AuthCache | undefined
      let flushTimer: ReturnType<typeof setInterval> | undefined

      const unsubs = [
        // Track assistant message metadata for correlating step-finish parts
        Bus.subscribe(MessageV2.Event.Updated, (event) => {
          const info = event.properties.info
          if (info.role !== "assistant") return
          messageMetadata.set(info.id, {
            modelID: info.modelID,
            providerID: info.providerID,
            agent: info.agent,
          })
        }),

        // Track part updates for usage events
        Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
          const part = event.properties.part

          if (part.type === "step-finish") {
            const meta = messageMetadata.get(part.messageID)
            queue.push({
              eventType: "llm",
              sessionId: part.sessionID,
              model: meta?.modelID,
              provider: meta?.providerID,
              agent: meta?.agent,
              tokensInput: part.tokens.input,
              tokensOutput: part.tokens.output,
              tokensReasoning: part.tokens.reasoning,
              tokensCacheRead: part.tokens.cache.read,
              tokensCacheWrite: part.tokens.cache.write,
              costUsd: part.cost,
              timestamp: Date.now(),
            })
            if (queue.length >= MAX_BATCH) flush(queue, authCache).catch(() => {})
          }

          if (part.type === "tool") {
            if (part.state.status === "completed") {
              queue.push({
                eventType: "tool",
                sessionId: part.sessionID,
                toolName: part.tool,
                toolCategory: BUILTIN_TOOLS.has(part.tool) ? "builtin" : "mcp",
                durationMs: part.state.time.end - part.state.time.start,
                success: true,
                timestamp: Date.now(),
              })
              if (queue.length >= MAX_BATCH) flush(queue, authCache).catch(() => {})
            }

            if (part.state.status === "error") {
              queue.push({
                eventType: "tool",
                sessionId: part.sessionID,
                toolName: part.tool,
                toolCategory: BUILTIN_TOOLS.has(part.tool) ? "builtin" : "mcp",
                durationMs: part.state.time.end - part.state.time.start,
                success: false,
                errorMessage: part.state.error,
                timestamp: Date.now(),
              })
              if (queue.length >= MAX_BATCH) flush(queue, authCache).catch(() => {})
            }
          }
        }),
      ]

      // Start periodic flush
      resolveAuth().then((auth) => {
        if (!auth) {
          log.info("no enterprise/portal auth found, TUI usage reporting disabled")
          return
        }
        authCache = auth
        flushTimer = setInterval(() => {
          flush(queue, authCache).catch(() => {})
        }, FLUSH_INTERVAL)
      })

      return { queue, unsubs, flushTimer, authCache }
    },
    async (current) => {
      // Dispose: final flush + cleanup
      if (current.flushTimer) clearInterval(current.flushTimer)
      for (const unsub of current.unsubs) unsub()
      if (current.queue.length > 0 && current.authCache) {
        await flush(current.queue, current.authCache).catch(() => {})
      }
      messageMetadata.clear()
    },
  )

  /** Initialize the reporter. Call once per Instance lifecycle. */
  export function init() {
    state() // triggers lazy init
  }
}

async function resolveAuth(): Promise<AuthCache | undefined> {
  const all = await Auth.all()

  // Check enterprise auth first
  for (const entry of Object.values(all)) {
    if (entry.type === "enterprise" && entry.licenseKey) {
      return {
        licenseKey: entry.licenseKey,
        portalUrl: entry.enterpriseUrl || (process.env.SERAC_PORTAL_URL || process.env.SNOW_FLOW_PORTAL_URL) || "https://dashboard.serac.build",
        cachedAt: Date.now(),
      }
    }
  }

  // Check portal auth (Teams users have organization license key)
  // Portal auth doesn't carry a license key directly, but we can use the token
  // The portal backend also accepts organization license keys
  for (const entry of Object.values(all)) {
    if (entry.type === "portal") {
      // Portal users need their org license key; we don't have it directly
      // They authenticate via token, not license key
      // For now, skip portal-only users (they use the portal chat which already tracks usage)
      return undefined
    }
  }

  return undefined
}

async function flush(queue: UsageEvent[], authCache: AuthCache | undefined): Promise<void> {
  if (queue.length === 0 || !authCache) return

  // Drain the queue
  const batch = queue.splice(0, MAX_BATCH)

  try {
    const response = await fetch(`${authCache.portalUrl}/api/tui/usage/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-License-Key": authCache.licenseKey,
      },
      body: JSON.stringify({ events: batch }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      if (response.status === 401) {
        log.warn("TUI usage flush got 401, clearing auth cache")
        // Re-resolve auth on next flush
        const fresh = await resolveAuth()
        if (fresh) {
          authCache.licenseKey = fresh.licenseKey
          authCache.portalUrl = fresh.portalUrl
          authCache.cachedAt = fresh.cachedAt
        }
      }
      // Put events back if flush failed (with limit to avoid unbounded growth)
      if (queue.length + batch.length <= MAX_BATCH * 2) {
        queue.unshift(...batch)
      }
      log.warn("TUI usage flush failed", { status: response.status })
    }
  } catch (error) {
    // Fire-and-forget: network errors are expected when offline
    if (queue.length + batch.length <= MAX_BATCH * 2) {
      queue.unshift(...batch)
    }
    log.warn("TUI usage flush error", { error: String(error) })
  }
}
