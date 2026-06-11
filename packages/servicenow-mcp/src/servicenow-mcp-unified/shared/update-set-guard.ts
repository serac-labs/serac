/**
 * Update-set guard.
 *
 * Companion to the prod-write guard in call-tool.ts: a configuration write
 * with no active update set for the session is blocked, so agent changes
 * can't silently land in the Default update set. The agent lifts the guard
 * once per session by ensuring/creating/switching an update set (or by
 * verifying a non-Default set is already current); an explicit user decline
 * is recorded via `__skipUpdateSet: true` and remembered for the session.
 *
 * Classification is conservative: only write tools outside the data domains
 * below are gated. Per-tool corrections go through the `updateSet` field on
 * MCPToolDefinition ("required" | "exempt") instead of growing these lists.
 */

import { type MCPToolDefinition } from "./types.js"
import { isWriteTool, SKIP_ACTIONS, SKIP_TOOLS } from "./instance-map-hook.js"

// Write tools in these categories mutate process data (incidents, CIs,
// assets, cases, ...), not configuration — ServiceNow does not capture them
// in update sets, so demanding one would be wrong.
const EXEMPT_CATEGORIES = [
  "itsm",
  "core-operations",
  "cmdb",
  "asset-management",
  "csm",
  "ml-analytics",
  "performance-analytics",
]

// Same idea one level deeper: tools living in config-flavoured categories
// whose writes are still data- or action-shaped (sending mail, executing a
// background script, importing rows, managing users/queues/sessions).
const EXEMPT_SUBCATEGORIES = [
  "agile",
  "approvals",
  "attachments",
  "comments",
  "customer-service",
  "email",
  "field-service",
  "hr",
  "import-export",
  "incidents",
  "queues",
  "script-execution",
  "session",
  "user-admin",
  "user-management",
]

// The unlock/inspection tools themselves are never gated.
const UPDATE_SET_TOOLS = ["snow_update_set_manage", "snow_update_set_query", "snow_ensure_active_update_set"]

/**
 * Should this call only run with an active update set?
 */
export function requiresUpdateSet(
  definition: MCPToolDefinition | undefined,
  args: Record<string, any> | undefined,
): boolean {
  if (!definition) return false
  if (definition.updateSet === "exempt") return false
  if (definition.updateSet === "required") return true
  if (!isWriteTool(definition)) return false
  if (UPDATE_SET_TOOLS.includes(definition.name)) return false
  if (SKIP_TOOLS.has(definition.name)) return false
  const action = typeof args?.action === "string" ? args.action : undefined
  if (action && SKIP_ACTIONS.has(action)) return false
  if (definition.category && EXEMPT_CATEGORIES.includes(definition.category)) return false
  if (definition.subcategory && EXEMPT_SUBCATEGORIES.includes(definition.subcategory)) return false
  return true
}

type GuardEntry = {
  active?: { sysId?: string; name?: string }
  skipped: boolean
  touched: number
}

const TTL_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 5000

// Session-scoped guard state. Keys are composed as
// tenantId\x00sessionId\x00instanceUrl — see guardKey() — so entries can
// never cross tenants; pruned by age once the map grows.
const guardState = new Map<string, GuardEntry>()

export function guardKey(
  tenantId: string | undefined,
  sessionId: string | undefined,
  instanceUrl: string | undefined,
): string {
  return `${tenantId ?? "stdio"}\x00${sessionId ?? "stdio"}\x00${instanceUrl ?? ""}`
}

function entry(key: string): GuardEntry {
  prune()
  const found = guardState.get(key)
  if (found) {
    found.touched = Date.now()
    return found
  }
  const fresh: GuardEntry = { skipped: false, touched: Date.now() }
  guardState.set(key, fresh)
  return fresh
}

function prune(): void {
  if (guardState.size < MAX_ENTRIES) return
  const cutoff = Date.now() - TTL_MS
  for (const [key, value] of guardState) {
    if (value.touched < cutoff) guardState.delete(key)
  }
}

/**
 * True when the session has an active update set — or the user explicitly
 * declined tracking for this session.
 */
export function updateSetActive(key: string): boolean {
  const found = guardState.get(key)
  if (!found) return false
  found.touched = Date.now()
  if (found.skipped) return true
  return found.active !== undefined
}

/** Record an explicit user decline (`__skipUpdateSet: true`) for the session. */
export function recordUpdateSetSkip(key: string): void {
  entry(key).skipped = true
}

/** Test helper — wipe all guard state. */
export function resetUpdateSetState(): void {
  guardState.clear()
}

/**
 * Keep the session state in sync with what the update-set tools actually
 * did: the guard lifts the moment a set is ensured/created/switched (or
 * verified current and non-Default) and re-arms on complete. A create with
 * auto_switch=false (or ensure with sync_with_user=false) does not track
 * changes, so it does not lift the guard either.
 */
export function observeUpdateSetTool(
  name: string,
  args: Record<string, any> | undefined,
  result: unknown,
  key: string,
): void {
  if (!UPDATE_SET_TOOLS.includes(name)) return
  const res = result as { success?: boolean; data?: Record<string, any> } | undefined
  if (!res?.success) return
  const data = res.data ?? {}
  const explicit = typeof args?.action === "string" ? args.action : undefined
  const action = explicit ?? (name === "snow_ensure_active_update_set" ? "ensure" : undefined)

  if (action === "complete") {
    entry(key).active = undefined
    return
  }
  if (action === "create" && args?.auto_switch === false) return
  if (action === "ensure" && args?.sync_with_user === false) return
  if (action === "ensure" || action === "create" || action === "switch") {
    entry(key).active = { sysId: data.sys_id, name: data.name }
    return
  }
  if (action === "current" && typeof data.name === "string" && data.name !== "Default" && data.sys_id) {
    entry(key).active = { sysId: data.sys_id, name: data.name }
  }
}

/**
 * Shared write-guard helpers — used by BOTH dispatch paths (the direct
 * handler in call-tool.ts and the tool_execute meta path), so the guard
 * behavior and messages cannot drift apart.
 *
 * confirmationFlag: agents — especially smaller models — routinely
 * stringify booleans ("__confirmProd": "true", "active": "true"). Both
 * write-guards accept boolean true and the string "true", so a
 * user-approved retry is not re-blocked over a serialization detail.
 */
export function confirmationFlag(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.toLowerCase() === "true")
}

export function prodWriteBlockMessage(name: string): string {
  return (
    `"${name}" is a write against a PRODUCTION ServiceNow instance and is blocked by default. ` +
    `Surface this change to the user; only after they approve, re-issue the exact same call with ` +
    `"__confirmProd": true added to the arguments. Reads, and writes to dev/test/uat, need no confirmation.`
  )
}

export function updateSetBlockMessage(name: string): string {
  return (
    `"${name}" is a configuration write but no update set is active for this session — the change ` +
    `would land in the Default update set untracked. Ask the user whether to capture this work in a ` +
    `named update set (suggest a name); after they approve, call snow_ensure_active_update_set({ name }) ` +
    `once and re-issue this call. If the user explicitly declines tracking, re-issue once with ` +
    `"__skipUpdateSet": true — the choice is remembered for the rest of the session.`
  )
}
