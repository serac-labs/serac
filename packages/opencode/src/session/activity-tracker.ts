/**
 * Activity Tracker
 *
 * Automatically reports agent work to the Serac Enterprise portal so the
 * agent no longer has to call `activity_start`, `activity_add_artifact`, and
 * `activity_complete` itself.
 *
 * Wiring: `onToolAfter` is invoked from `session/prompt.ts` after every tool
 * call completes. We classify the tool, pull story / update-set / artifact
 * data out of the result, and call the enterprise MCP tools via
 * `MCP.callToolByName`.
 *
 * Failure mode: all errors are swallowed — activity tracking is a telemetry
 * side-effect and must never break tool execution. After repeated MCP failures
 * the tracker disables itself for the session.
 */

import { Log } from "@/util/log"
import { MCP } from "@/mcp"

export namespace ActivityTracker {
  const log = Log.create({ service: "activity-tracker" })

  interface PendingStory {
    storyId?: string
    storyTitle: string
    storyUrl?: string
    storyType: "story" | "bug" | "task" | "feature" | "request" | "other"
    source: "jira" | "azure-devops" | "confluence" | "manual" | "request"
  }

  interface SessionState {
    activityId?: string
    updateSetSysId?: string
    updateSetName?: string
    updateSetUrl?: string
    pendingStory?: PendingStory
    instanceUrl?: string
    loggedArtifacts: Set<string>
    disabled: boolean
    consecutiveFailures: number
  }

  const sessions = new Map<string, SessionState>()
  const DISABLE_AFTER_FAILURES = 3

  function getState(sessionID: string): SessionState {
    let s = sessions.get(sessionID)
    if (!s) {
      s = { loggedArtifacts: new Set(), disabled: false, consecutiveFailures: 0 }
      sessions.set(sessionID, s)
    }
    return s
  }

  const PICKUP_TOOLS = new Set([
    "jira_get_issue",
    "jira_get_next_todo",
    "jira_get_ready_work",
    "azure_get_work_item",
    "azdoGetWorkItem",
  ])

  const UPDATE_SET_TOOL = "snow_update_set_manage"

  function matchesTool(toolId: string, expected: string | Set<string>): string | undefined {
    const names = typeof expected === "string" ? [expected] : Array.from(expected)
    for (const n of names) {
      if (toolId === n) return n
      if (toolId.endsWith("_" + n)) return n
    }
    return undefined
  }

  function isSnowWrite(toolId: string): boolean {
    return (
      /snow_(create|deploy|edit)_/.test(toolId) ||
      (/snow_update_/.test(toolId) && !matchesTool(toolId, UPDATE_SET_TOOL))
    )
  }

  /**
   * Unwrap tool results into the `{ success?, data?, artifact? }` shape used
   * by our ToolResult helpers. Handles:
   *   - MCP CallToolResult: `{ content: [{ type: "text", text: "<json>" }] }`
   *   - Direct ToolResult (local tool)
   */
  function extractData(result: any): any {
    if (!result || typeof result !== "object") return null
    if ("success" in result || "data" in result || "artifact" in result) return result
    const text = result?.content?.[0]?.text
    if (typeof text !== "string") return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  /** If the agent ran via `tool_execute`, unwrap to the inner tool + args. */
  function unwrapToolExecute(toolId: string, args: any): { toolId: string; args: any } {
    if (!/_tool_execute$/.test(toolId) && toolId !== "tool_execute") {
      return { toolId, args }
    }
    const inner = args?.tool
    const innerArgs = args?.args ?? {}
    if (typeof inner !== "string") return { toolId, args }
    return { toolId: inner, args: innerArgs }
  }

  function mapIssueType(t: string | undefined): PendingStory["storyType"] {
    if (!t) return "story"
    const lower = t.toLowerCase()
    if (lower.includes("bug")) return "bug"
    if (lower.includes("feature")) return "feature"
    if (lower.includes("request")) return "request"
    if (lower.includes("task")) return "task"
    if (lower.includes("story")) return "story"
    return "other"
  }

  function buildJiraBrowseUrl(issue: any): string | undefined {
    if (typeof issue?.url === "string") return issue.url
    if (typeof issue?.self === "string" && typeof issue?.key === "string") {
      const m = issue.self.match(/^(https?:\/\/[^/]+)/)
      if (m) return `${m[1]}/browse/${issue.key}`
    }
    return undefined
  }

  function parseStoryFromPickUp(toolName: string, data: any): PendingStory | undefined {
    if (!data) return undefined

    if (toolName === "jira_get_next_todo") {
      const issue = data.issue
      if (!issue) return undefined
      return {
        storyId: issue.key,
        storyTitle: issue.summary || "Untitled",
        storyUrl: issue.url,
        storyType: mapIssueType(issue.issueType),
        source: "jira",
      }
    }

    if (toolName === "jira_get_ready_work") {
      const issue = Array.isArray(data.issues) ? data.issues[0] : undefined
      if (!issue) return undefined
      return {
        storyId: issue.key,
        storyTitle: issue.summary || "Untitled",
        storyUrl: issue.url,
        storyType: mapIssueType(issue.issueType),
        source: "jira",
      }
    }

    if (toolName === "jira_get_issue") {
      const issue = data.issue
      if (!issue) return undefined
      const fields = issue.fields ?? {}
      return {
        storyId: issue.key,
        storyTitle: fields.summary || "Untitled",
        storyUrl: buildJiraBrowseUrl(issue),
        storyType: mapIssueType(fields.issuetype?.name),
        source: "jira",
      }
    }

    if (toolName === "azure_get_work_item" || toolName === "azdoGetWorkItem") {
      const wi = data.workItem
      if (!wi) return undefined
      const fields = wi.fields ?? {}
      return {
        storyId: String(fields["System.Id"] ?? wi.id ?? ""),
        storyTitle: fields["System.Title"] || "Untitled",
        storyUrl: wi?._links?.html?.href || wi.url,
        storyType: mapIssueType(fields["System.WorkItemType"]),
        source: "azure-devops",
      }
    }

    return undefined
  }

  function parseUpdateSet(data: any): { sys_id: string; name: string } | undefined {
    if (!data) return undefined
    const inner = data?.data ?? data
    const sys_id = inner?.sys_id ?? inner?.update_set?.sys_id
    const name = inner?.name ?? inner?.update_set?.name
    if (typeof sys_id !== "string" || typeof name !== "string") return undefined
    return { sys_id, name }
  }

  function extractInstanceUrl(data: any): string | undefined {
    const candidates = [
      data?.instance_url,
      data?.instanceUrl,
      data?.data?.instance_url,
      data?.url,
      data?.data?.url,
      data?.update_set?.url,
      data?.data?.update_set?.url,
    ]
    for (const c of candidates) {
      if (typeof c !== "string") continue
      const m = c.match(/^(https?:\/\/[^/]+)/)
      if (m) return m[1]
    }
    return undefined
  }

  const TYPE_TO_TABLE: Record<string, string> = {
    business_rule: "sys_script",
    script_include: "sys_script_include",
    client_script: "sys_script_client",
    ui_action: "sys_ui_action",
    ui_page: "sys_ui_page",
    widget: "sp_widget",
    sp_widget: "sp_widget",
    sp_page: "sp_page",
    catalog_item: "sc_cat_item",
    catalog_ui_policy: "catalog_ui_policy",
    workflow: "wf_workflow",
    flow: "sys_hub_flow",
    update_set: "sys_update_set",
    application: "sys_app",
    table: "sys_db_object",
    field: "sys_dictionary",
  }

  function buildArtifactUrl(instanceUrl: string | undefined, sys_id: string, tableOrType?: string): string | undefined {
    if (!instanceUrl) return undefined
    const table = (tableOrType && TYPE_TO_TABLE[tableOrType]) || tableOrType || "sys_metadata"
    return `${instanceUrl}/${table}.do?sys_id=${sys_id}`
  }

  async function callActivityTool(state: SessionState, name: string, args: Record<string, unknown>): Promise<any> {
    try {
      const res = await MCP.callToolByName(name, args, { timeout: 10_000 })
      state.consecutiveFailures = 0
      return res
    } catch (err: any) {
      state.consecutiveFailures += 1
      log.info("activity tool call failed", { tool: name, error: err?.message, failures: state.consecutiveFailures })
      if (state.consecutiveFailures >= DISABLE_AFTER_FAILURES) {
        state.disabled = true
        log.info("activity tracker disabled for session after repeated failures")
      }
      return null
    }
  }

  async function startActivity(state: SessionState): Promise<void> {
    if (!state.updateSetSysId || !state.updateSetName) return
    const updateSetUrl = state.updateSetUrl ?? buildArtifactUrl(state.instanceUrl, state.updateSetSysId, "update_set")
    if (!updateSetUrl) return
    state.updateSetUrl = updateSetUrl
    const story = state.pendingStory
    const res = await callActivityTool(state, "activity_start", {
      source: story?.source ?? "manual",
      storyId: story?.storyId,
      storyTitle: story?.storyTitle ?? "Ad-hoc ServiceNow work",
      storyUrl: story?.storyUrl,
      storyType: story?.storyType ?? "request",
      updateSetName: state.updateSetName,
      updateSetSysId: state.updateSetSysId,
      updateSetUrl,
    })
    const text = res?.content?.[0]?.text
    if (typeof text !== "string") return
    try {
      const parsed = JSON.parse(text)
      if (parsed?.success && typeof parsed.activityId === "string") {
        state.activityId = parsed.activityId
        state.pendingStory = undefined
        log.info("activity started", { activityId: parsed.activityId })
      }
    } catch {
      /* ignore */
    }
  }

  async function completeActivity(state: SessionState, summary: string): Promise<void> {
    if (!state.activityId) return
    await callActivityTool(state, "activity_complete", {
      activityId: state.activityId,
      summary,
      metadata: {
        artifactsLogged: state.loggedArtifacts.size,
        updateSetSysId: state.updateSetSysId,
      },
    })
    state.activityId = undefined
    state.loggedArtifacts.clear()
  }

  /**
   * Main entry point. Called from `session/prompt.ts` after every tool call
   * completes successfully. Failures are swallowed.
   */
  export async function onToolAfter(sessionID: string, rawToolId: string, rawArgs: any, rawResult: any): Promise<void> {
    const state = getState(sessionID)
    if (state.disabled) return

    const { toolId, args } = unwrapToolExecute(rawToolId, rawArgs)
    const data = extractData(rawResult)
    if (!data) return

    try {
      // Pick-up tool → buffer story info
      const pickupName = matchesTool(toolId, PICKUP_TOOLS)
      if (pickupName) {
        const story = parseStoryFromPickUp(pickupName, data?.data ?? data)
        if (story) {
          state.pendingStory = story
          log.info("buffered story", { storyId: story.storyId, title: story.storyTitle })
        }
        return
      }

      // Update-set lifecycle
      if (matchesTool(toolId, UPDATE_SET_TOOL)) {
        const action = String(args?.action ?? "create").toLowerCase()
        const instanceUrl = extractInstanceUrl(data)
        if (instanceUrl) state.instanceUrl = instanceUrl

        if (action === "create" || action === "switch" || action === "current") {
          const us = parseUpdateSet(data)
          if (us) {
            state.updateSetSysId = us.sys_id
            state.updateSetName = us.name
            state.updateSetUrl = buildArtifactUrl(state.instanceUrl, us.sys_id, "update_set")
            if (!state.activityId) await startActivity(state)
          }
        } else if (action === "complete") {
          if (state.activityId) {
            await completeActivity(state, "Update set completed.")
          }
        }
        return
      }

      // Snow write → attach artifact
      if (isSnowWrite(toolId)) {
        const artifact = data?.artifact ?? data?.data?.artifact
        if (!artifact?.sys_id) return

        if (!state.activityId) {
          if (!state.updateSetSysId) return
          await startActivity(state)
          if (!state.activityId) return
        }

        if (state.loggedArtifacts.has(artifact.sys_id)) return
        state.loggedArtifacts.add(artifact.sys_id)

        const url =
          artifact.url ??
          buildArtifactUrl(state.instanceUrl, artifact.sys_id, artifact.table ?? artifact.type) ??
          ""

        await callActivityTool(state, "activity_add_artifact", {
          activityId: state.activityId,
          artifactType: artifact.type ?? "artifact",
          artifactName: artifact.name ?? artifact.sys_id,
          artifactSysId: artifact.sys_id,
          artifactUrl: url,
        })
      }
    } catch (err: any) {
      log.info("activity tracker error (non-fatal)", { error: err?.message })
    }
  }

  /** Called when a session ends to flush any in-flight activity. */
  export async function onSessionEnd(sessionID: string): Promise<void> {
    const state = sessions.get(sessionID)
    if (!state) return
    if (state.activityId) {
      await completeActivity(state, "Session ended.")
    }
    sessions.delete(sessionID)
  }
}
