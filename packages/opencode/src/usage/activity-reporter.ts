import { Instance } from "@/project/instance"
import { Bus } from "@/bus"
import { MessageV2 } from "@/session/message-v2"
import { Auth } from "@/auth"
import { Log } from "@/util/log"
import crypto from "crypto"

const log = Log.create({ service: "usage.activity" })

/**
 * MCP tools that create update sets
 */
const UPDATE_SET_TOOLS = new Set(["snow_update_set_manage", "snow_update_set_create"])

/**
 * MCP tools that create ServiceNow artifacts (reported as activity artifacts)
 */
const ARTIFACT_TOOLS: Record<string, string> = {
  snow_deploy: "widget",
  snow_create_widget: "widget",
  snow_update: "widget",
  snow_create_ui_page: "ui_page",
  snow_create_script_include: "script_include",
  snow_create_business_rule: "business_rule",
  snow_create_client_script: "client_script",
  snow_create_ui_policy: "ui_policy",
  snow_create_ui_action: "ui_action",
  snow_edit_artifact: "artifact",
  snow_create_rest_message: "rest_message",
  snow_manage_flow: "flow",
}

interface AuthCache {
  licenseKey: string
  portalUrl: string
}

interface ActiveActivity {
  activityId: string
  updateSetName: string
  updateSetSysId: string
  updateSetUrl?: string
}

const AUTH_CACHE_TTL = 5 * 60 * 1000

export namespace ActivityReporter {
  const state = Instance.state(
    () => {
      let authCache: AuthCache | undefined
      let activeActivity: ActiveActivity | undefined

      const unsubs = [
        Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
          const part = event.properties.part
          if (part.type !== "tool") return
          if (part.state.status !== "completed") return

          const toolName = part.tool
          const input = part.state.input
          const output = part.state.output

          // Detect update set creation
          if (UPDATE_SET_TOOLS.has(toolName)) {
            const action = input.action
            if (action === "create") {
              handleUpdateSetCreate(output, part.sessionID, authCache)
                .then((activity) => {
                  if (activity) activeActivity = activity
                })
                .catch(() => {})
            }
            if (action === "complete" && activeActivity) {
              handleUpdateSetComplete(activeActivity, authCache).catch(() => {})
              activeActivity = undefined
            }
          }

          // Detect artifact creation
          if (toolName in ARTIFACT_TOOLS && activeActivity) {
            const artifactType = ARTIFACT_TOOLS[toolName]
            handleArtifactCreate(activeActivity, artifactType, output, authCache).catch(() => {})
          }
        }),
      ]

      // Resolve enterprise auth
      resolveAuth().then((auth) => {
        if (!auth) {
          log.info("no enterprise auth found, activity reporting disabled")
          return
        }
        authCache = auth
        log.info("activity reporting enabled")
      })

      return { unsubs, authCache, activeActivity }
    },
    async (current) => {
      for (const unsub of current.unsubs) unsub()
    },
  )

  export function init() {
    state()
  }
}

async function resolveAuth(): Promise<AuthCache | undefined> {
  const all = await Auth.all()

  for (const entry of Object.values(all)) {
    if (entry.type === "enterprise" && entry.licenseKey) {
      return {
        licenseKey: entry.licenseKey,
        portalUrl: entry.enterpriseUrl || (process.env.SERAC_PORTAL_URL || process.env.SNOW_FLOW_PORTAL_URL) || "https://dashboard.serac.build",
      }
    }
  }

  return undefined
}

function parseToolOutput(output: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(output)
    return parsed?.data ?? parsed
  } catch {
    return undefined
  }
}

async function handleUpdateSetCreate(
  output: string,
  sessionId: string,
  authCache: AuthCache | undefined,
): Promise<ActiveActivity | undefined> {
  if (!authCache) return undefined

  const data = parseToolOutput(output)
  if (!data?.sys_id || !data?.name) return undefined

  const activityId = `act-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`

  const body = {
    licenseKey: authCache.licenseKey,
    activityId,
    source: "manual" as const,
    storyTitle: data.name,
    storyType: "task",
    updateSetName: data.name,
    updateSetSysId: data.sys_id,
    updateSetUrl: "",
  }

  try {
    const response = await fetch(`${authCache.portalUrl}/api/agent/activity/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-License-Key": authCache.licenseKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      log.warn("activity start failed", { status: response.status })
      return undefined
    }

    log.info("activity started", { activityId, updateSet: data.name })

    return {
      activityId,
      updateSetName: data.name,
      updateSetSysId: data.sys_id,
    }
  } catch (error) {
    log.warn("activity start error", { error: String(error) })
    return undefined
  }
}

async function handleUpdateSetComplete(activity: ActiveActivity, authCache: AuthCache | undefined): Promise<void> {
  if (!authCache) return

  try {
    const response = await fetch(`${authCache.portalUrl}/api/agent/activity/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-License-Key": authCache.licenseKey,
      },
      body: JSON.stringify({
        licenseKey: authCache.licenseKey,
        activityId: activity.activityId,
        status: "completed",
        summary: `Update set "${activity.updateSetName}" completed`,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (response.ok) {
      log.info("activity completed", { activityId: activity.activityId })
    }
  } catch (error) {
    log.warn("activity complete error", { error: String(error) })
  }
}

async function handleArtifactCreate(
  activity: ActiveActivity,
  artifactType: string,
  output: string,
  authCache: AuthCache | undefined,
): Promise<void> {
  if (!authCache) return

  const data = parseToolOutput(output)
  if (!data) return

  const artifactName = data.name || data.artifact_name || data.title || artifactType
  const artifactSysId = data.sys_id || data.artifact_sys_id || ""

  try {
    await fetch(`${authCache.portalUrl}/api/agent/activity/artifact`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-License-Key": authCache.licenseKey,
      },
      body: JSON.stringify({
        licenseKey: authCache.licenseKey,
        activityId: activity.activityId,
        artifactType,
        artifactName,
        artifactSysId,
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    // fire and forget
  }
}
