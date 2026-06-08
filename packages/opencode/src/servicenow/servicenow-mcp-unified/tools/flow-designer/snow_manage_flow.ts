/**
 * Serac Flow Designer Tool
 *
 * DISCLAIMER:
 * This tool uses both official and undocumented ServiceNow APIs to interact
 * with Flow Designer. The GraphQL-based operations (snFlowDesigner) use
 * internal ServiceNow APIs that are not officially documented and may change
 * without notice. Use at your own risk.
 *
 * This tool is not affiliated with, endorsed by, or sponsored by ServiceNow, Inc.
 * ServiceNow is a registered trademark of ServiceNow, Inc.
 *
 * A valid ServiceNow subscription and credentials are required to use this tool.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { summary } from "../../shared/output-formatter.js"
import crypto from "crypto"

// ── helpers ────────────────────────────────────────────────────────────

function sanitizeInternalName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
}

function isSysId(value: string): boolean {
  return /^[a-f0-9]{32}$/.test(value)
}

/**
 * Validate and fix common pill syntax issues in input values.
 * - Removes empty pills: {{}} or {{ }}
 * - Trims spaces inside pill references: {{ trigger.current.priority }} → {{trigger.current.priority}}
 * - Normalizes double spaces inside pill names
 * - Checks for unbalanced {{ / }} and removes broken pills
 */
function validateAndFixPills(value: string): string {
  if (!value || typeof value !== "string" || !value.includes("{{")) return value

  // Remove empty pills: {{}} or {{ }} or {{  }}
  var result = value.replace(/\{\{\s*\}\}/g, "")

  // Trim leading/trailing spaces inside pill references:
  // {{ trigger.current.priority }} → {{trigger.current.priority}}
  result = result.replace(/\{\{\s+/g, "{{").replace(/\s+\}\}/g, "}}")

  // Normalize double spaces inside pill names
  result = result.replace(/\{\{([^}]*)\}\}/g, function (_m: string, inner: string) {
    return "{{" + inner.replace(/\s{2,}/g, " ") + "}}"
  })

  // Check for unbalanced pills: count {{ and }} occurrences
  var opens = (result.match(/\{\{/g) || []).length
  var closes = (result.match(/\}\}/g) || []).length
  if (opens !== closes) {
    // Remove orphaned {{ or }} — strip any {{ without a matching }} and vice versa
    // Walk through and only keep balanced pairs
    var balanced = ""
    var i = 0
    while (i < result.length) {
      if (result[i] === "{" && result[i + 1] === "{") {
        var closeIdx = result.indexOf("}}", i + 2)
        if (closeIdx !== -1) {
          balanced += result.substring(i, closeIdx + 2)
          i = closeIdx + 2
        } else {
          // Orphaned {{ — skip it
          i += 2
        }
      } else if (result[i] === "}" && result[i + 1] === "}") {
        // Orphaned }} — skip it
        i += 2
      } else {
        balanced += result[i]
        i++
      }
    }
    result = balanced
  }

  return result
}

/** Canonical list of shorthand prefixes that reference the trigger's current record.
 *  Single source of truth — used by rewriteShorthandPills() and hasShorthandPills(). */
const PILL_SHORTHANDS = ["trigger.current", "current", "trigger_record", "trigger record", "trigger.record", "record"]

/**
 * Rewrite shorthand pill references to use the canonical data pill base.
 * e.g. "{{trigger.current.priority}}" → "{{Created or Updated_1.current.priority}}"
 *      "{{current}}" → "{{Created or Updated_1.current}}"
 * Also normalizes bare trigger.record → trigger.current for non-pill values.
 */
function rewriteShorthandPills(value: string, dataPillBase: string): string {
  if (!value || !dataPillBase) return value
  // Normalize bare trigger.record/trigger_record → trigger.current (non-pill values only)
  if (!value.includes("{{")) {
    value = value.replace(/\btrigger\.record\./g, "trigger.current.")
    value = value.replace(/\btrigger_record\./g, "trigger.current.")
  }
  // Rewrite pill-wrapped shorthand references
  for (var i = 0; i < PILL_SHORTHANDS.length; i++) {
    var sh = PILL_SHORTHANDS[i]
    value = value.split("{{" + sh + ".").join("{{" + dataPillBase + ".")
    value = value.split("{{" + sh + "}}").join("{{" + dataPillBase + "}}")
  }
  return value
}

/** Check if a string contains any shorthand pill references that need rewriting. */
function hasShorthandPills(value: string): boolean {
  if (!value || !value.includes("{{")) return false
  return PILL_SHORTHANDS.some(function (sh) {
    return value.includes("{{" + sh + ".") || value.includes("{{" + sh + "}}")
  })
}

// ── GraphQL Flow Designer helpers ─────────────────────────────────────

function jsToGraphQL(val: any): string {
  if (val === null || val === undefined) return "null"
  if (typeof val === "string") return JSON.stringify(val)
  if (typeof val === "number" || typeof val === "bigint") return String(val)
  if (typeof val === "boolean") return val ? "true" : "false"
  if (Array.isArray(val)) return "[" + val.map(jsToGraphQL).join(", ") + "]"
  if (typeof val === "object") {
    return (
      "{" +
      Object.entries(val)
        .map(([k, v]) => k + ": " + jsToGraphQL(v))
        .join(", ") +
      "}"
    )
  }
  return String(val)
}

function generateUUID(): string {
  return crypto.randomUUID()
}

/**
 * Get the current max global order from the flow's live state.
 *
 * IMPORTANT: Flow Designer elements (actions, flow logic, subflows) are NOT stored as
 * individual records in sys_hub_action_instance / sys_hub_flow_logic / sys_hub_sub_flow_instance.
 * They only exist inside the version payload managed by the GraphQL API.
 * Table API queries on these tables will always return 0 results.
 *
 * Strategy (most reliable first):
 * 1. processflow API — always returns real-time state, even right after mutations
 * 2. sys_hub_flow_version.payload — fallback, may be stale after rapid mutations
 * 3. Return 0 (caller should use explicit order)
 */
async function getMaxOrderFromVersion(client: any, flowId: string): Promise<number> {
  // Helper: recursively extract all "order" values from a nested structure
  const findMaxOrder = (obj: any): number => {
    if (!obj || typeof obj !== "object") return 0
    let max = 0
    if (obj.order !== undefined) {
      const o = parseInt(String(obj.order), 10)
      if (!isNaN(o) && o > max) max = o
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const v = findMaxOrder(obj[i])
        if (v > max) max = v
      }
    } else {
      const vals = Object.values(obj)
      for (let i = 0; i < vals.length; i++) {
        const v = findMaxOrder(vals[i])
        if (v > max) max = v
      }
    }
    return max
  }

  // Strategy 1: processflow API (real-time, same as Flow Designer UI)
  try {
    const pfResp = await client.get("/api/now/processflow/flow/" + flowId)
    const pfRaw = pfResp.data
    if (typeof pfRaw === "string") {
      // XML — extract all order="N" and <order>N</order> values
      let max = 0
      const orderAttrRx = /\border="(\d+)"/g
      const orderElemRx = /<order>(\d+)<\/order>/g
      let m
      while ((m = orderAttrRx.exec(pfRaw)) !== null) {
        const v = parseInt(m[1], 10)
        if (v > max) max = v
      }
      while ((m = orderElemRx.exec(pfRaw)) !== null) {
        const v = parseInt(m[1], 10)
        if (v > max) max = v
      }
      if (max > 0) return max
    } else if (pfRaw && typeof pfRaw === "object") {
      const data = pfRaw.result?.data || pfRaw.result || pfRaw.data || pfRaw
      const max = findMaxOrder(data)
      if (max > 0) return max
    }
  } catch (e: any) {
    console.warn(
      "[snow_manage_flow] getMaxOrderFromVersion processflow API failed for flow=" + flowId + ": " + (e.message || ""),
    )
  }

  // Strategy 2: sys_hub_flow_version.payload (may be stale after rapid mutations)
  try {
    const resp = await client.get("/api/now/table/sys_hub_flow_version", {
      params: {
        sysparm_query: "flow=" + flowId + "^ORDERBYDESCsys_created_on",
        sysparm_fields: "sys_id,payload",
        sysparm_limit: 1,
      },
    })
    const payload = resp.data.result?.[0]?.payload
    if (payload) {
      const parsed = typeof payload === "string" ? JSON.parse(payload) : payload
      const max = findMaxOrder(parsed)
      if (max > 0) return max
    }
  } catch (e: any) {
    console.warn(
      "[snow_manage_flow] getMaxOrderFromVersion version payload failed for flow=" + flowId + ": " + (e.message || ""),
    )
  }

  return 0
}

interface FlowElement {
  id: string
  uuid: string
  order: number
  parent: string
  connectedTo: string
  elementType: string
  patchType: "action" | "flowlogic" | "subflow"
}

function parseElementsFromXml(raw: string): FlowElement[] {
  const elements: FlowElement[] = []
  const tags = [
    { tag: "actionInstance", patchType: "action" as const },
    { tag: "flowLogicInstance", patchType: "flowlogic" as const },
    { tag: "subflowInstance", patchType: "subflow" as const },
  ]
  for (const { tag, patchType } of tags) {
    const rx = new RegExp("<" + tag + "[\\s\\S]*?<\\/" + tag + ">", "g")
    const matches = raw.match(rx) || []
    for (const m of matches) {
      const attr = (name: string) => {
        const a = m.match(new RegExp(name + '="([^"]*)"'))
        const e = m.match(new RegExp("<" + name + ">([^<]*)</" + name + ">"))
        return a ? a[1] : e ? e[1] : ""
      }
      elements.push({
        id: attr("id") || attr("sysId"),
        uuid: attr("uiUniqueIdentifier") || attr("id") || attr("sysId"),
        order: parseInt(attr("order") || "0", 10),
        parent: attr("parentUiId") || attr("parent") || "",
        connectedTo: attr("connectedTo") || "",
        elementType: (attr("typeLabel") || attr("type") || patchType).toUpperCase(),
        patchType,
      })
    }
  }
  return elements
}

function parseElementsFromJson(raw: Record<string, unknown>): FlowElement[] {
  const elements: FlowElement[] = []
  const data = (raw as any).result?.data || (raw as any).result || (raw as any).data || raw
  const model = data?.model || data
  const sources: Array<{ key: string; patchType: "action" | "flowlogic" | "subflow" }> = [
    { key: "actionInstances", patchType: "action" },
    { key: "flowLogicInstances", patchType: "flowlogic" },
    { key: "subflowInstances", patchType: "subflow" },
  ]
  for (const { key, patchType } of sources) {
    const items = model?.[key] || []
    for (const item of items) {
      elements.push({
        id: item.id || item.sysId || "",
        uuid: item.uiUniqueIdentifier || item.id || item.sysId || "",
        order: parseInt(String(item.order || 0), 10),
        parent: item.parentUiId || item.parent || "",
        connectedTo: item.connectedTo || "",
        elementType: (item.typeLabel || item.type || patchType).toUpperCase(),
        patchType,
      })
    }
  }
  return elements
}

async function getFlowElementsFromProcessflow(client: any, flowId: string): Promise<FlowElement[]> {
  try {
    const resp = await client.get("/api/now/processflow/flow/" + flowId)
    const raw = resp.data
    if (typeof raw === "string") {
      const elements = parseElementsFromXml(raw)
      if (elements.length > 0) return elements
    }
    if (raw && typeof raw === "object") {
      const elements = parseElementsFromJson(raw)
      if (elements.length > 0) return elements
    }
  } catch (e: any) {
    console.warn("[snow_manage_flow] processflow API failed: " + (e.message || ""))
  }
  try {
    const resp = await client.get("/api/now/table/sys_hub_flow_version", {
      params: {
        sysparm_query: "flow=" + flowId + "^ORDERBYDESCsys_created_on",
        sysparm_fields: "sys_id,payload",
        sysparm_limit: 1,
      },
    })
    const payload = resp.data.result?.[0]?.payload
    if (payload) {
      const parsed = typeof payload === "string" ? JSON.parse(payload) : payload
      return parseElementsFromJson(parsed)
    }
  } catch (e: any) {
    console.warn("[snow_manage_flow] version payload fallback failed: " + (e.message || ""))
  }
  return []
}

function findCatchForTry(elements: FlowElement[], tryUuid: string): FlowElement | undefined {
  return (
    elements.find((el) => el.connectedTo === tryUuid && el.elementType.includes("CATCH")) ||
    elements.find((el) => el.connectedTo === tryUuid && el.patchType === "flowlogic")
  )
}

function buildReorderUpdates(
  elements: FlowElement[],
  shiftAtOrAbove: number,
  excludeUuids?: Set<string>,
): { actions: any[]; flowLogics: any[]; subflows: any[] } {
  const result = { actions: [] as any[], flowLogics: [] as any[], subflows: [] as any[] }
  const affected = elements
    .filter((el) => el.order >= shiftAtOrAbove && (!excludeUuids || !excludeUuids.has(el.uuid)))
    .sort((a, b) => b.order - a.order)
  for (const el of affected) {
    const entry = {
      uiUniqueIdentifier: el.uuid,
      type: el.patchType === "flowlogic" ? "flowlogic" : el.patchType,
      order: String(el.order + 1),
    }
    if (el.patchType === "action") result.actions.push(entry)
    else if (el.patchType === "flowlogic") result.flowLogics.push(entry)
    else result.subflows.push(entry)
  }
  return result
}

function isTryElement(el: FlowElement): boolean {
  return el.elementType.includes("TRY") && !el.elementType.includes("CATCH")
}

function isCatchElement(el: FlowElement): boolean {
  return el.elementType.includes("CATCH") || el.elementType.includes("ERROR HANDLER")
}

function getMaxDescendantOrder(elements: FlowElement[], rootUuid: string): number {
  var max = 0
  var root = elements.find(function (el) {
    return el.uuid === rootUuid
  })
  if (root) max = root.order
  var queue = [rootUuid]
  while (queue.length > 0) {
    var current = queue.shift()!
    for (var i = 0; i < elements.length; i++) {
      var candidate = elements[i]!
      if (candidate.parent === current || candidate.connectedTo === current) {
        if (candidate.order > max) max = candidate.order
        queue.push(candidate.uuid)
      }
    }
  }
  return max
}

async function computeNestedOrder(
  client: any,
  flowId: string,
  parentUiId: string,
  explicitOrder: number | undefined,
  steps: any,
): Promise<{
  order: number
  reorder: { actions: any[]; flowLogics: any[]; subflows: any[] }
  catchUuid?: string
} | null> {
  const empty = { actions: [], flowLogics: [], subflows: [] }
  const elements = await getFlowElementsFromProcessflow(client, flowId)
  steps.nested_order_elements = elements.map((el) => ({
    uuid: el.uuid.substring(0, 8),
    order: el.order,
    parent: el.parent.substring(0, 8) || "(root)",
    connectedTo: el.connectedTo.substring(0, 8) || "",
    type: el.elementType,
    patchType: el.patchType,
  }))
  if (elements.length === 0) {
    steps.nested_order_bail = "no_elements"
    return null
  }

  const parent = elements.find((el) => el.uuid === parentUiId || el.id === parentUiId)
  if (!parent) {
    steps.nested_order_bail = "parent_not_found:" + parentUiId.substring(0, 8)
    return null
  }

  steps.nested_order_context = {
    parent_uuid: parentUiId.substring(0, 8),
    parent_type: parent.elementType,
    parent_order: parent.order,
    is_try: isTryElement(parent),
    is_catch: isCatchElement(parent),
  }

  const children = elements.filter((el) => el.parent === parentUiId && !isCatchElement(el))
  const insertAt =
    explicitOrder ||
    (children.length > 0
      ? Math.max(...children.map((c) => getMaxDescendantOrder(elements, c.uuid))) + 1
      : parent.order + 1)

  if (isTryElement(parent)) {
    const companion = findCatchForTry(elements, parentUiId)
    if (!companion) {
      steps.try_child_reorder = { catch_companion: "not_found", insert_at: insertAt }
      return { order: insertAt, reorder: buildReorderUpdates(elements, insertAt, new Set([parentUiId])) }
    }
    const reorder = insertAt <= companion.order ? buildReorderUpdates(elements, insertAt, new Set([parentUiId])) : empty
    steps.try_child_reorder = {
      catch_uuid: companion.uuid.substring(0, 8),
      catch_old_order: companion.order,
      sibling_count: children.length,
      insert_at: insertAt,
      shifted: reorder.actions.length + reorder.flowLogics.length + reorder.subflows.length,
    }
    return { order: insertAt, reorder, catchUuid: companion.uuid }
  }

  if (isCatchElement(parent)) {
    const reorder = buildReorderUpdates(
      elements.filter((el) => el.parent !== parentUiId && el.uuid !== parentUiId),
      insertAt,
    )
    steps.catch_child_reorder = {
      insert_at: insertAt,
      shifted: reorder.actions.length + reorder.flowLogics.length + reorder.subflows.length,
    }
    return { order: insertAt, reorder }
  }

  const reorder = buildReorderUpdates(elements, insertAt, new Set([parentUiId]))
  steps.generic_child_reorder = {
    parent_type: parent.elementType,
    insert_at: insertAt,
    shifted: reorder.actions.length + reorder.flowLogics.length + reorder.subflows.length,
  }
  return { order: insertAt, reorder }
}

/**
 * Patch the sys_hub_flow_safe_edit row for a flow so its `user` field
 * matches a specific sys_id. Used by the auto-recovery in
 * executeFlowPatchMutation when ServiceNow's GraphQL engine reports a
 * different user than the one our acquireFlowEditingLock wrote.
 *
 * Returns true if the row was successfully patched (or freshly created),
 * false on any failure — callers should not let a failed recovery
 * mask the original GraphQL error.
 */
async function patchSafeEditUser(client: any, flowId: string, userSysId: string): Promise<boolean> {
  try {
    const checkResp = await client.get("/api/now/table/sys_hub_flow_safe_edit", {
      params: {
        sysparm_query: "document_id=" + flowId,
        sysparm_fields: "sys_id,user",
        sysparm_limit: 1,
      },
    })
    const existing = checkResp.data?.result?.[0]
    if (existing?.sys_id) {
      await client.patch("/api/now/table/sys_hub_flow_safe_edit/" + existing.sys_id, {
        user: userSysId,
        flow: flowId,
      })
      return true
    }
    // No record yet — create one bound to the requested user.
    await client.post("/api/now/table/sys_hub_flow_safe_edit", {
      document_id: flowId,
      user: userSysId,
      flow: flowId,
    })
    return true
  } catch (_) {
    return false
  }
}

async function executeFlowPatchMutation(client: any, flowPatch: any, responseFields: string): Promise<any> {
  const start = Date.now()
  const mutation =
    "mutation { global { snFlowDesigner { flow(flowPatch: " +
    jsToGraphQL(flowPatch) +
    ") { id " +
    responseFields +
    " __typename } __typename } __typename } }"
  let resp = await client.post("/api/now/graphql", { variables: {}, query: mutation })
  let errors = resp.data?.errors

  if (errors && errors.length > 0) {
    const firstMsg = String(errors[0].message || JSON.stringify(errors[0]))

    // Auto-recovery for safe-edit user mismatch. ServiceNow surfaces the
    // user it expects in the error message itself ("User with ID X does
    // not have safe edit record for flow with ID Y"); we patch the
    // sys_hub_flow_safe_edit row to that user and retry the mutation
    // once. Handles OAuth setups where the gs.getUserID() session and
    // the GraphQL session resolve to different users — issue #105.
    const safeEditMatch = /User with ID ([0-9a-fA-F]+) does not have safe edit record for flow with ID ([0-9a-fA-F]+)/.exec(
      firstMsg,
    )
    if (safeEditMatch && flowPatch?.flowId) {
      const requiredUser = safeEditMatch[1]
      const errorFlowId = safeEditMatch[2]
      // Only recover when the error and the patch agree on which flow
      // is being edited; never silently retarget another flow's lock.
      if (errorFlowId === flowPatch.flowId) {
        const patched = await patchSafeEditUser(client, errorFlowId, requiredUser)
        if (patched) {
          resp = await client.post("/api/now/graphql", { variables: {}, query: mutation })
          errors = resp.data?.errors
          if (!errors || errors.length === 0) {
            const recovered = resp.data?.data?.global?.snFlowDesigner?.flow || resp.data
            if (recovered && typeof recovered === "object") {
              recovered._mutationMs = Date.now() - start
              recovered._recoveredFromSafeEditMismatch = { rebound_to: requiredUser }
            }
            return recovered
          }
        }
      }
    }

    throw new Error("GraphQL error: " + JSON.stringify(errors[0].message || errors[0]))
  }
  const result = resp.data?.data?.global?.snFlowDesigner?.flow || resp.data
  if (result && typeof result === "object") result._mutationMs = Date.now() - start
  return result
}

async function verifyFlowState(
  client: any,
  flowId: string,
  expect: { type: "trigger" | "action" | "flow_logic" | "subflow" | "stage"; id?: string; deleted?: boolean },
): Promise<{ verified: boolean; found: boolean; elementCount: number; error?: string }> {
  try {
    const resp = await client.get("/api/now/processflow/flow/" + flowId)
    const raw = resp.data

    if (typeof raw === "string") {
      const tagMap: Record<string, string> = {
        trigger: "triggerInstance",
        action: "actionInstance",
        flow_logic: "flowLogicInstance",
        subflow: "actionInstance",
        stage: "stage",
      }
      const tag = tagMap[expect.type]
      const regex = new RegExp("<" + tag + "[^>]*>[\\s\\S]*?<\\/" + tag + ">", "g")
      const matches = raw.match(regex) || []
      const found = expect.id
        ? matches.some(function (m: string) {
            return m.includes(expect.id!)
          })
        : true
      return { verified: expect.deleted ? !found : found, found, elementCount: matches.length }
    }

    const data = raw?.result?.data || raw?.data || raw
    if (!data) return { verified: false, found: false, elementCount: 0, error: "empty processflow response" }

    const collectionMap: Record<string, any[]> = {
      trigger: data.model?.triggerInstances || data.triggerInstances || [],
      action: data.model?.actionInstances || data.actionInstances || [],
      flow_logic: data.model?.flowLogicInstances || data.flowLogicInstances || [],
      subflow: (data.model?.actionInstances || data.actionInstances || []).filter(function (a: any) {
        return a.type === "subflow"
      }),
      stage: data.model?.stages || data.stages || [],
    }
    const collection = collectionMap[expect.type] || []
    const arr = Array.isArray(collection) ? collection : []
    const found = expect.id
      ? arr.some(function (el: any) {
          return el.id === expect.id || el.sysId === expect.id
        })
      : arr.length > 0

    return { verified: expect.deleted ? !found : found, found, elementCount: arr.length }
  } catch (e: any) {
    return { verified: false, found: false, elementCount: 0, error: e.message }
  }
}

/**
 * Resolve the current authenticated user's sys_id.
 * Caches the result on the client object to avoid repeated lookups.
 */
async function getCurrentUserSysId(client: any): Promise<string> {
  if (client._cachedUserSysId) return client._cachedUserSysId
  // Encoded `javascript:` queries are evaluated server-side against the
  // current session, so this returns the *authenticated* caller's sys_id.
  // The previous "limit 1, no filter" lookup grabbed whatever happened to
  // be the first row in `sys_user` — usually a demo data user on dev
  // instances — which is what broke the Flow Designer safe-edit lock
  // chain in issue #101 (the lock was created for the wrong user, and
  // every subsequent GraphQL trigger/action call was rejected). Same
  // pattern as snow_session_context and snow_impersonate_user.
  try {
    var resp = await client.get("/api/now/table/sys_user", {
      params: {
        sysparm_query: "sys_id=javascript:gs.getUserID()",
        sysparm_limit: 1,
        sysparm_fields: "sys_id",
      },
    })
    var id = resp.data?.result?.[0]?.sys_id || ""
    if (id) {
      client._cachedUserSysId = id
      return id
    }
  } catch (_) {
    // Fall through to the user_name fallback.
  }
  // Fallback for hardened instances that strip `sys_id=javascript:` from
  // queries: the username variant tends to be left intact because it's
  // the workhorse for permission filters across the platform.
  try {
    var resp = await client.get("/api/now/table/sys_user", {
      params: {
        sysparm_query: "user_name=javascript:gs.getUserName()",
        sysparm_limit: 1,
        sysparm_fields: "sys_id",
      },
    })
    var id = resp.data?.result?.[0]?.sys_id || ""
    if (id) {
      client._cachedUserSysId = id
      return id
    }
  } catch (_) {
    return ""
  }
  return ""
}

/**
 * Acquire the Flow Designer editing lock on a flow.
 * Uses GraphQL safeEdit(upsert) as primary, then REST fallback with user+flow fields.
 * This must be called before GraphQL mutations on existing flows.
 */
async function acquireFlowEditingLock(
  client: any,
  flowId: string,
): Promise<{ success: boolean; error?: string; debug?: any }> {
  var debug: any = {}
  var userSysId = await getCurrentUserSysId(client)
  debug.user_sys_id = userSysId || "unknown"

  // Step 1: Call safeEdit(upsert) GraphQL mutation
  try {
    var mutation =
      'mutation { global { snFlowDesigner { safeEdit(safeEditInput: {upsert: {flowId: "' +
      flowId +
      '"}}) { __typename } __typename } __typename } }'
    var resp = await client.post("/api/now/graphql", { variables: {}, query: mutation })
    var gqlErrors = resp.data?.errors
    if (gqlErrors && gqlErrors.length > 0) {
      var runtimeErrors = gqlErrors.filter(function (e: any) {
        return e.errorType !== "ValidationError"
      })
      if (runtimeErrors.length > 0) {
        var lockedMsg = runtimeErrors[0].message || ""
        if (lockedMsg.indexOf("locked") >= 0 || lockedMsg.indexOf("edit") >= 0) {
          return { success: false, error: lockedMsg, debug }
        }
      }
      debug.graphql_errors = gqlErrors.map(function (e: any) {
        return e.message || JSON.stringify(e)
      })
    }
    var safeEdit = resp.data?.data?.global?.snFlowDesigner?.safeEdit
    if (safeEdit) {
      debug.graphql_upsert = true
    }
  } catch (e: any) {
    debug.graphql_error = e.message
  }

  // Step 2: Verify a sys_hub_flow_safe_edit record exists with correct user
  try {
    var checkResp = await client.get("/api/now/table/sys_hub_flow_safe_edit", {
      params: {
        sysparm_query: "document_id=" + flowId,
        sysparm_fields: "sys_id,document_id,user,flow",
        sysparm_limit: 1,
      },
    })
    var existing = checkResp.data.result?.[0]
    if (existing?.sys_id) {
      var needsUpdate = false
      var userVal = typeof existing.user === "object" ? existing.user.value : existing.user
      var flowVal = typeof existing.flow === "object" ? existing.flow.value : existing.flow
      if (userSysId && userVal !== userSysId) needsUpdate = true
      if (!flowVal || flowVal !== flowId) needsUpdate = true
      if (needsUpdate) {
        var patch: any = {}
        if (userSysId && userVal !== userSysId) patch.user = userSysId
        if (!flowVal || flowVal !== flowId) patch.flow = flowId
        await client.patch("/api/now/table/sys_hub_flow_safe_edit/" + existing.sys_id, patch)
        debug.safe_edit_patched = patch
      }
      debug.safe_edit_record = existing.sys_id
      return { success: true, debug }
    }
    debug.safe_edit_record = "not_found_after_graphql"
  } catch (e: any) {
    debug.safe_edit_check_error = e.message
  }

  // Step 3: Fallback — create the safe_edit record via REST with user and flow fields
  try {
    var body: any = { document_id: flowId }
    if (userSysId) body.user = userSysId
    body.flow = flowId
    var createResp = await client.post("/api/now/table/sys_hub_flow_safe_edit", body)
    var created = createResp.data.result
    if (created?.sys_id) {
      debug.rest_created = created.sys_id
      return { success: true, debug }
    }
    debug.rest_create_response = created
  } catch (e: any) {
    debug.rest_create_error = e.message
  }

  if (debug.graphql_upsert) {
    debug.fallback = "trusting_graphql_upsert"
    return { success: true, debug }
  }

  return { success: false, error: "Could not acquire editing lock (GraphQL + REST fallback both failed)", debug }
}

/**
 * Release the Flow Designer editing lock on a flow.
 * The UI calls safeEdit(delete: flowId) when closing the editor.
 * Without this, the flow remains locked to the API user forever.
 *
 * Uses GraphQL safeEdit(delete) as primary, then falls back to directly
 * deleting sys_hub_flow_safe_edit records via REST (handles ghost locks).
 */
async function releaseFlowEditingLock(
  client: any,
  flowId: string,
): Promise<{ success: boolean; error?: string; compilationError?: string; debug?: any }> {
  var graphqlOk = false
  var compilationError: string | undefined
  var debug: any = {}
  // Step 1: GraphQL safeEdit(delete) — primary mechanism
  // This triggers flow compilation and version creation on the server side.
  // If the flow has invalid elements (e.g. unsupported flowLogic type), the compilation
  // fails and returns an error like "Unsupported flowLogic type: ELSE. A version was not created."
  try {
    var mutation =
      'mutation { global { snFlowDesigner { safeEdit(safeEditInput: {delete: "' +
      flowId +
      '"}) { deleteResult { deleteSuccess id __typename } __typename } __typename } __typename } }'
    var resp = await client.post("/api/now/graphql", { variables: {}, query: mutation })
    var deleteResult = resp.data?.data?.global?.snFlowDesigner?.safeEdit?.deleteResult
    graphqlOk = deleteResult?.deleteSuccess === true
    debug.deleteResult = deleteResult
    // Check for GraphQL-level errors
    var gqlErrors = resp.data?.errors
    if (gqlErrors && gqlErrors.length > 0) {
      compilationError = gqlErrors
        .map(function (e: any) {
          return e.message || JSON.stringify(e)
        })
        .join("; ")
      debug.graphql_errors = gqlErrors
    }
    // If deleteSuccess is false but no GraphQL error, check the result for messages
    if (!graphqlOk && !compilationError) {
      compilationError = "safeEdit(delete) returned deleteSuccess=false. The flow may have compilation errors."
    }
  } catch (e: any) {
    compilationError = e.message || "safeEdit(delete) threw an exception"
    debug.graphql_exception = e.message
  }

  // Step 2: REST fallback — directly delete any sys_hub_flow_safe_edit records for this flow
  // This catches ghost locks that GraphQL safeEdit(delete) misses.
  try {
    var checkResp = await client.get("/api/now/table/sys_hub_flow_safe_edit", {
      params: { sysparm_query: "document_id=" + flowId, sysparm_fields: "sys_id", sysparm_limit: 10 },
    })
    var records = checkResp.data?.result || []
    for (var r = 0; r < records.length; r++) {
      await client.delete("/api/now/table/sys_hub_flow_safe_edit/" + records[r].sys_id)
    }
    debug.safe_edit_records_cleaned = records.length
  } catch (e: any) {
    console.warn("[snow_manage_flow] releaseFlowEditingLock: REST cleanup failed: " + (e.message || ""))
  }

  // Step 3: Also clean up sys_hub_flow_lock records (some instances persist locks here)
  // Without this, open_flow ghost-lock retry fails because GraphQL safeEdit(upsert) still sees a lock.
  try {
    var lockResp = await client.get("/api/now/table/sys_hub_flow_lock", {
      params: { sysparm_query: "flow=" + flowId, sysparm_fields: "sys_id", sysparm_limit: 10 },
    })
    var lockRecords = lockResp.data?.result || []
    for (var lr = 0; lr < lockRecords.length; lr++) {
      try {
        await client.delete("/api/now/table/sys_hub_flow_lock/" + lockRecords[lr].sys_id)
      } catch (_) {
        /* best-effort */
      }
    }
    debug.flow_lock_records_cleaned = lockRecords.length
  } catch (_) {
    debug.flow_lock_table = "not_available"
  }

  return { success: graphqlOk, compilationError, debug }
}

/**
 * Verify whether an editing lock (sys_hub_flow_safe_edit record) exists for the given flow.
 * Used before GraphQL mutations to detect lost/expired locks early.
 */
async function verifyFlowEditingLock(
  client: any,
  flowId: string,
): Promise<{ locked: boolean; lockAge?: number; lockUser?: string }> {
  try {
    var resp = await client.get("/api/now/table/sys_hub_flow_safe_edit", {
      params: {
        sysparm_query: "document_id=" + flowId,
        sysparm_fields: "sys_id,document_id,user,sys_created_on",
        sysparm_limit: 1,
      },
    })
    var record = resp.data.result?.[0]
    if (record?.sys_id) {
      var ageMs = record.sys_created_on ? Date.now() - new Date(record.sys_created_on).getTime() : 0
      return { locked: true, lockAge: ageMs, lockUser: record.user || "" }
    }
    return { locked: false }
  } catch (e: any) {
    console.warn("[snow_manage_flow] verifyFlowEditingLock failed: " + (e.message || ""))
    return { locked: false }
  }
}

/**
 * Read the committed state of a flow after a publish/activate call and report
 * whether it is genuinely active AND has a compiled snapshot.
 *
 * The versioning API (and the REST fallback) can return HTTP 200 while the
 * server-side compilation never finishes, leaving the flow active=false /
 * status=draft with an empty master_snapshot. In that state the flow does NOT
 * trigger. This is the source of truth the publish handler trusts instead of
 * the API status code. A flow is publish-OK only when active === true AND a
 * snapshot reference exists (master_snapshot or latest_snapshot).
 */
async function verifyFlowActivation(
  client: any,
  flowId: string,
): Promise<{ active: boolean; status: string; hasSnapshot: boolean; snapshot: string }> {
  try {
    var resp = await client.get("/api/now/table/sys_hub_flow/" + flowId, {
      params: {
        sysparm_fields: "active,status,master_snapshot,latest_snapshot",
        sysparm_exclude_reference_link: "true",
      },
    })
    var rec = resp.data?.result || {}
    var active = rec.active === "true" || rec.active === true
    var status = (rec.status || "unknown") + ""
    // Reference fields come back as { value: "..." } unless flattened; handle both.
    var master = typeof rec.master_snapshot === "object" ? rec.master_snapshot?.value : rec.master_snapshot
    var latest = typeof rec.latest_snapshot === "object" ? rec.latest_snapshot?.value : rec.latest_snapshot
    var snapshot = master || latest || ""
    return { active: active, status: status, hasSnapshot: !!snapshot, snapshot: snapshot }
  } catch (e: any) {
    console.warn("[snow_manage_flow] verifyFlowActivation failed for flow=" + flowId + ": " + (e.message || ""))
    return { active: false, status: "verify_failed", hasSnapshot: false, snapshot: "" }
  }
}

/**
 * Compile + publish a flow's working copy into a master snapshot.
 *
 * This is the step the Flow Designer UI performs on Activate that the tool
 * historically skipped: it POSTs the full working-copy definition (read back
 * from processflow/flow/{id}) to processflow/flow/{id}/snapshot. That endpoint
 * compiles the flow, flips it active/published, and returns the new
 * masterSnapshotId. Without it, create_version has nothing to snapshot and the
 * flow stays draft with an empty master_snapshot — the long-standing
 * "publish reports success but the flow never triggers" bug.
 *
 * Returns the new masterSnapshotId on success, or "" on failure.
 */
async function compileFlowSnapshot(client: any, flowId: string): Promise<string> {
  try {
    var defResp = await client.get("/api/now/processflow/flow/" + flowId)
    var def = defResp.data?.result?.data
    if (!def || !def.id) return ""
    // The UI tags every snapshot post with a fresh client session id.
    def.clientSessionId = generateUUID()
    // Triggered flows compile via .../snapshot; subflows use .../subflow
    // (the .../snapshot endpoint 500s for type=subflow). Server-side
    // compilation can take well over the default 60s client timeout on large
    // flows / busy instances, so give this call room.
    var endpoint = def.type === "subflow" ? "/subflow" : "/snapshot"
    var snapResp = await client.post(
      "/api/now/processflow/flow/" + flowId + endpoint + "?sysparm_transaction_scope=global",
      def,
      { timeout: 180000 },
    )
    return snapResp.data?.result?.data?.masterSnapshotId || ""
  } catch (e: any) {
    console.warn("[snow_manage_flow] compileFlowSnapshot failed for flow=" + flowId + ": " + (e.message || ""))
    return ""
  }
}

/**
 * Add a user flow variable to an EXISTING flow via the GraphQL
 * flow(flowPatch: { flowVariables: { insert } }) mutation — the same path the
 * Flow Designer UI uses. This adds to the working copy WITHOUT publishing
 * (unlike posting the def to /snapshot, which compiles and then ignores further
 * appends), so multiple variables can be added before close_flow/publish.
 *
 * Flow `inputs` are trigger-derived and can't be added this way; this is for
 * user `flowVariables`. Returns the new variable's sysId.
 */
async function addFlowVariable(
  client: any,
  flowId: string,
  variable: { name: string; label?: string; type?: string; order?: number },
): Promise<{ success: boolean; sysId?: string; error?: string }> {
  try {
    var vtype = variable.type || "string"
    var vlabel = TYPE_LABELS[vtype] || vtype.charAt(0).toUpperCase() + vtype.slice(1)
    var varObj = {
      label: variable.label || variable.name,
      name: variable.name,
      type: vtype,
      type_label: vlabel,
      order: variable.order || 1,
      mandatory: false,
      readonly: false,
      attributes: "sourceUiUniqueId=,sourceType=,sourceId=,uiUniqueId=" + generateUUID() + ",",
      uiDisplayType: vtype,
      uiDisplayTypeLabel: vlabel,
    }
    var result = await executeFlowPatchMutation(
      client,
      { flowId: flowId, flowVariables: { insert: [varObj] } },
      "flowVariables { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }",
    )
    return { success: true, sysId: result?.flowVariables?.inserts?.[0]?.sysId }
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) }
  }
}

/**
 * Ensure an editing lock exists for the given flow, re-acquiring if necessary.
 * Call this before every GraphQL element mutation.
 */
async function ensureFlowEditingLock(
  client: any,
  flowId: string,
): Promise<{ success: boolean; reacquired?: boolean; warning?: string }> {
  var lockStatus = await verifyFlowEditingLock(client, flowId)
  if (lockStatus.locked) return { success: true }

  try {
    await client.get("/api/now/processflow/flow/" + flowId)
  } catch (_) {
    /* best-effort */
  }

  console.warn("[snow_manage_flow] Lock not found for flow " + flowId + ", re-acquiring...")
  var acquireResult = await acquireFlowEditingLock(client, flowId)
  if (acquireResult.success) return { success: true, reacquired: true }

  console.warn("[snow_manage_flow] Lock acquisition failed for flow " + flowId + ", attempting pre-release + retry...")
  var preRelease = await releaseFlowEditingLock(client, flowId)
  if (preRelease.debug?.safe_edit_records_cleaned || preRelease.debug?.flow_lock_records_cleaned) {
    await new Promise(function (resolve) {
      setTimeout(resolve, 1500)
    })
  }
  var retryResult = await acquireFlowEditingLock(client, flowId)
  if (retryResult.success) return { success: true, reacquired: true }

  console.warn(
    "[snow_manage_flow] Lock acquisition failed for flow " +
      flowId +
      " after pre-release + retry: " +
      (retryResult.error || "unknown"),
  )
  return {
    success: false,
    warning: retryResult.error || "Could not acquire editing lock. Try calling checkout or open_flow explicitly.",
  }
}

/** Safely extract a string from a ServiceNow Table API value (handles reference objects like {value, link}). */
const str = (val: any): string =>
  typeof val === "object" && val !== null ? val.display_value || val.value || "" : val || ""

/** Safely convert usedInstances to an array (handles object {}, undefined, null, or already an array). */
function toArray(val: any): any[] {
  if (Array.isArray(val)) return val
  if (!val) return []
  return []
}

// ── Update Set helpers ────────────────────────────────────────────────

/**
 * Set update set as current for the OAuth service account.
 * Copied from snow_update_set_manage.ts — inline to avoid cross-tool imports.
 */
async function setUpdateSetForServiceAccount(client: any, updateSetId: string): Promise<void> {
  var existingPref = await client.get("/api/now/table/sys_user_preference", {
    params: {
      sysparm_query: "name=sys_update_set^user=javascript:gs.getUserID()",
      sysparm_limit: 1,
    },
  })

  if (existingPref.data.result && existingPref.data.result.length > 0) {
    await client.patch("/api/now/table/sys_user_preference/" + existingPref.data.result[0].sys_id, {
      value: updateSetId,
    })
  } else {
    await client.post("/api/now/table/sys_user_preference", {
      name: "sys_update_set",
      value: updateSetId,
      user: "javascript:gs.getUserID()",
    })
  }
}

/**
 * Ensure an update set is active for tracking flow designer changes.
 * Returns early if ensure_update_set is false (default).
 * If update_set_id is provided, switches to that set.
 * Otherwise, looks up an existing "in progress" set by name, or creates a new one.
 */
async function ensureUpdateSetForFlow(
  client: any,
  args: any,
): Promise<{ updateSetId?: string; updateSetName?: string; warning?: string }> {
  if (args.ensure_update_set !== true) return {}

  var targetId = args.update_set_id
  var setName = args.update_set_name || "Serac: Flow Designer changes"

  // If explicit update_set_id provided, just switch to it
  if (targetId) {
    try {
      await setUpdateSetForServiceAccount(client, targetId)
      return { updateSetId: targetId, updateSetName: "(explicit)" }
    } catch (e: any) {
      return { warning: "Failed to switch to update set " + targetId + ": " + e.message }
    }
  }

  // Look up existing "in progress" update set by name
  try {
    var existing = await client.get("/api/now/table/sys_update_set", {
      params: {
        sysparm_query: "name=" + setName + "^state=in progress",
        sysparm_fields: "sys_id,name",
        sysparm_limit: 1,
      },
    })
    if (existing.data.result && existing.data.result.length > 0) {
      var existingSet = existing.data.result[0]
      await setUpdateSetForServiceAccount(client, existingSet.sys_id)
      return { updateSetId: existingSet.sys_id, updateSetName: existingSet.name }
    }
  } catch (e: any) {
    console.warn(
      "[snow_manage_flow] ensureUpdateSetForFlow: lookup failed, falling through to create: " + (e.message || ""),
    )
  }

  // Create a new update set
  try {
    var createResp = await client.post("/api/now/table/sys_update_set", {
      name: setName,
      description: "Auto-created by Serac for Flow Designer changes",
      state: "in progress",
    })
    var created = createResp.data.result
    if (created?.sys_id) {
      await setUpdateSetForServiceAccount(client, created.sys_id)
      return { updateSetId: created.sys_id, updateSetName: created.name || setName }
    }
  } catch (e: any) {
    return { warning: "Failed to create update set: " + e.message }
  }

  return { warning: "Could not ensure update set (no error thrown but no set created)" }
}

/**
 * Merge update set context into a response data object.
 * Adds update_set info if present.
 */
function withUpdateSetContext(data: any, ctx: { updateSetId?: string; updateSetName?: string; warning?: string }): any {
  if (!ctx.updateSetId && !ctx.warning) return data
  return Object.assign({}, data, {
    update_set: ctx.updateSetId ? { sys_id: ctx.updateSetId, name: ctx.updateSetName } : undefined,
    update_set_warning: ctx.warning || undefined,
  })
}

/** Deduplicate labelCache entries by name — merge usedInstances when the same pill appears in multiple inputs. */
function deduplicateLabelCache(entries: any[]): any[] {
  var seen: Record<string, any> = {}
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]
    var key = entry.name || ""
    if (seen[key]) {
      // Merge usedInstances from duplicate into existing entry
      var existing = seen[key]
      var newInstances = toArray(entry.usedInstances)
      for (var j = 0; j < newInstances.length; j++) {
        existing.usedInstances.push(newInstances[j])
      }
    } else {
      var clonedInstances = toArray(entry.usedInstances).slice()
      seen[key] = Object.assign({}, entry, { usedInstances: clonedInstances })
    }
  }
  return Object.values(seen)
}

/** Build a standardized labelCache entry. All pill entries should use this factory to ensure consistent shape. */
function buildLabelCacheEntry(opts: {
  name: string
  label: string
  reference: string
  reference_display: string
  type: string
  base_type: string
  parent_table_name: string
  column_name: string
  usedInstances: { uiUniqueIdentifier: string; inputName: string }[]
}): any {
  return {
    name: opts.name,
    label: opts.label,
    reference: opts.reference,
    reference_display: opts.reference_display,
    type: opts.type,
    base_type: opts.base_type,
    parent_table_name: opts.parent_table_name,
    column_name: opts.column_name,
    usedInstances: opts.usedInstances,
    choices: {},
  }
}

/**
 * Fetch the existing labelCache pills from the flow's processflow data.
 * Returns a map: pill name → existing usedInstances[].
 * Used to determine whether to INSERT (new pill) or UPDATE (existing pill) in mutations.
 */
async function getExistingLabelCachePills(client: any, flowId: string): Promise<Record<string, any[]>> {
  try {
    var resp = await client.get("/api/now/processflow/flow/" + flowId)
    var raw = resp.data
    var jsonStr = ""

    if (typeof raw === "string") {
      // XML response — extract labelCacheAsJsonString
      var match = raw.match(/<labelCacheAsJsonString[^>]*>([\s\S]*?)<\/labelCacheAsJsonString>/)
      if (match) jsonStr = match[1]
    } else if (raw && typeof raw === "object") {
      var data = raw.result?.data || raw.data || raw
      if (data.labelCacheAsJsonString) jsonStr = data.labelCacheAsJsonString
      else if (data.model?.labelCacheAsJsonString) jsonStr = data.model.labelCacheAsJsonString
    }

    if (!jsonStr) return {}

    // Unescape XML entities if needed
    jsonStr = jsonStr
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
    var cache = JSON.parse(jsonStr)
    var result: Record<string, any[]> = {}
    if (Array.isArray(cache)) {
      for (var i = 0; i < cache.length; i++) {
        var entry = cache[i]
        if (entry.name) result[entry.name] = toArray(entry.usedInstances)
      }
    }
    return result
  } catch (e: any) {
    console.warn("[snow_manage_flow] getExistingLabelCachePills failed for flow=" + flowId + ": " + (e.message || ""))
    return {}
  }
}

/**
 * Split labelCache entries into inserts (new pills) and updates (existing pills).
 * For updates: merges new usedInstances with the existing ones.
 * For inserts: uses full metadata as-is.
 */
function splitLabelCacheEntries(
  entries: any[],
  existingPills: Record<string, any[]>,
): { inserts: any[]; updates: any[] } {
  var inserts: any[] = []
  var updates: any[] = []
  var seenUpdates: Record<string, any> = {}

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]
    var name = entry.name || ""
    if (!name) continue

    if (existingPills[name]) {
      // Pill already exists — UPDATE with merged usedInstances
      if (seenUpdates[name]) {
        // Multiple new uses of the same existing pill — merge into one update
        var newInst = entry.usedInstances || []
        for (var j = 0; j < newInst.length; j++) seenUpdates[name].usedInstances.push(newInst[j])
      } else {
        var mergedInstances = toArray(existingPills[name]).concat(toArray(entry.usedInstances))
        seenUpdates[name] = { name: name, usedInstances: mergedInstances }
      }
    } else {
      // New pill — INSERT with full metadata
      inserts.push(entry)
    }
  }

  updates = Object.values(seenUpdates)
  return { inserts: deduplicateLabelCache(inserts), updates: updates }
}

// Type label mapping for parameter definitions
const TYPE_LABELS: Record<string, string> = {
  string: "String",
  integer: "Integer",
  boolean: "True/False",
  choice: "Choice",
  reference: "Reference",
  object: "Object",
  glide_date_time: "Date/Time",
  glide_date: "Date",
  decimal: "Decimal",
  conditions: "Conditions",
  glide_list: "List",
  html: "HTML",
  script: "Script",
  url: "URL",
}

/**
 * Build full action input objects matching the Flow Designer UI format.
 * The UI sends inputs WITH parameter definitions in the INSERT mutation (not empty inputs + separate UPDATE).
 */
async function buildActionInputsForInsert(
  client: any,
  actionDefId: string,
  userValues?: Record<string, string>,
): Promise<{
  inputs: any[]
  resolvedInputs: Record<string, string>
  actionParams: any[]
  missingMandatory: string[]
  invalidTable?: { input: string; value: string; message: string; validOptions: string[] }
}> {
  // Query sys_hub_action_input with full field set
  var actionParams: any[] = []
  try {
    var resp = await client.get("/api/now/table/sys_hub_action_input", {
      params: {
        sysparm_query: "model=" + actionDefId,
        sysparm_fields:
          "sys_id,element,label,internal_type,mandatory,default_value,order,max_length,hint,read_only,extended,data_structure,reference,reference_display,ref_qual,choice_option,table_name,column_name,use_dependent,dependent_on,show_ref_finder,local,attributes,sys_class_name",
        sysparm_display_value: "false",
        sysparm_limit: 50,
      },
    })
    actionParams = resp.data.result || []
  } catch (e: any) {
    console.warn(
      "[snow_manage_flow] sys_hub_action_input query failed for model=" + actionDefId + ": " + (e.message || ""),
    )
  }

  // Fuzzy-match user-provided values to actual field names.
  // ServiceNow action parameters often have prefixed element names:
  //   ah_to, ah_subject, sn_table, log_message, etc.
  // Users/agents commonly pass the short form: to, subject, table, message.
  var resolvedInputs: Record<string, string> = {}
  if (userValues) {
    var paramElements = actionParams.map(function (p: any) {
      return str(p.element)
    })
    for (var [key, value] of Object.entries(userValues)) {
      // 1. Exact match on element name
      if (paramElements.includes(key)) {
        resolvedInputs[key] = value
        continue
      }
      // 2. Fuzzy match: suffix/prefix matching, label matching, stripped prefix matching
      var keyLC = key.toLowerCase().replace(/[\s-]/g, "_")
      var match = actionParams.find(function (p: any) {
        var el = str(p.element)
        var elLC = el.toLowerCase()
        // Suffix: ah_to matches key "to"
        if (elLC.endsWith("_" + keyLC)) return true
        // Prefix: table_name matches key "table"
        if (elLC.startsWith(keyLC + "_")) return true
        // Exact (case-insensitive)
        if (elLC === keyLC) return true
        // Label match (case-insensitive)
        if (str(p.label).toLowerCase() === keyLC) return true
        // Strip common ServiceNow prefixes and compare
        var stripped = elLC.replace(/^(ah_|sn_|sc_|rp_|fb_|kb_)/, "")
        if (stripped === keyLC) return true
        // key without underscores vs element without underscores (e.g. "logmessage" vs "log_message")
        if (elLC.replace(/_/g, "") === keyLC.replace(/_/g, "")) return true
        return false
      })
      if (match) resolvedInputs[str(match.element)] = value
      else resolvedInputs[key] = value
    }
  }

  // Auto-convert object values to ServiceNow encoded strings (e.g. {priority: "2", state: "3"} → "priority=2^state=3")
  // This handles agents passing field values as JSON objects instead of encoded strings.
  for (var rk of Object.keys(resolvedInputs)) {
    var rv = resolvedInputs[rk]
    if (rv && typeof rv === "object" && !Array.isArray(rv)) {
      var pairs: string[] = []
      for (var [fk, fv] of Object.entries(rv)) {
        pairs.push(fk + "=" + String(fv))
      }
      resolvedInputs[rk] = pairs.join("^")
    }
  }

  // Build full input objects with parameter definitions (matching UI format)
  // Use str() on all fields — the Table API may return reference fields as objects {value, link}
  var inputs = actionParams.map(function (rec: any) {
    var paramType = str(rec.internal_type) || "string"
    var element = str(rec.element)
    var userVal = resolvedInputs[element] || ""
    return {
      id: str(rec.sys_id),
      name: element,
      children: [],
      displayValue: { value: "" },
      value: { schemaless: false, schemalessValue: "", value: userVal },
      parameter: {
        id: str(rec.sys_id),
        label: str(rec.label) || element,
        name: element,
        type: paramType,
        type_label: TYPE_LABELS[paramType] || paramType.charAt(0).toUpperCase() + paramType.slice(1),
        hint: str(rec.hint),
        order: parseInt(str(rec.order) || "0", 10),
        extended: str(rec.extended) === "true",
        mandatory: str(rec.mandatory) === "true",
        readonly: str(rec.read_only) === "true",
        maxsize: parseInt(str(rec.max_length) || "8000", 10),
        data_structure: str(rec.data_structure),
        reference: str(rec.reference),
        reference_display: str(rec.reference_display),
        ref_qual: str(rec.ref_qual),
        choiceOption: str(rec.choice_option),
        table: str(rec.table_name),
        columnName: str(rec.column_name),
        defaultValue: str(rec.default_value),
        use_dependent: str(rec.use_dependent) === "true",
        dependent_on: str(rec.dependent_on),
        show_ref_finder: str(rec.show_ref_finder) === "true",
        local: str(rec.local) === "true",
        attributes: str(rec.attributes),
        sys_class_name: str(rec.sys_class_name),
        children: [],
      },
    }
  })

  // Check for mandatory fields that are missing a value
  var missingMandatory = inputs
    .filter(function (inp: any) {
      return inp.parameter?.mandatory && !inp.value?.value
    })
    .map(function (inp: any) {
      return inp.name + " (" + (inp.parameter?.label || inp.name) + ")"
    })

  // Validate table inputs that must be a child of a specific parent (e.g. task_table must extend 'task')
  for (var tblKey of Object.keys(TABLE_INPUT_PARENTS)) {
    var tblInput = inputs.find(function (inp: any) {
      return inp.name === tblKey
    })
    if (tblInput && tblInput.value?.value) {
      var tblVal = tblInput.value.value
      var parentTbl = TABLE_INPUT_PARENTS[tblKey]
      var tblCheck = await validateTableExtends(client, tblVal, parentTbl)
      if (!tblCheck.valid) {
        var optionNames = tblCheck.validOptions.map(function (o: any) {
          return o.name
        })
        return {
          inputs,
          resolvedInputs,
          actionParams,
          missingMandatory: [],
          invalidTable: {
            input: tblKey,
            value: tblVal,
            message:
              "Table '" +
              tblVal +
              "' is not valid for " +
              tblKey +
              ". " +
              (tblVal === parentTbl ? "The base '" + parentTbl + "' table cannot be used directly. " : "") +
              "Valid options: " +
              optionNames.join(", "),
            validOptions: optionNames,
          },
        }
      }
      // Set displayValue for valid table
      if (tblCheck.tableLabel) {
        tblInput.displayValue = { schemaless: false, schemalessValue: "", value: tblCheck.tableLabel }
      }
    }
  }

  return { inputs, resolvedInputs, actionParams, missingMandatory }
}

// ── Table validation helpers ──────────────────────────────────────────

/** Check if a table exists in sys_db_object. */
async function validateTableExists(client: any, tableName: string): Promise<{ exists: boolean; label: string }> {
  if (!tableName) return { exists: false, label: "" }
  try {
    var resp = await client.get("/api/now/table/sys_db_object", {
      params: {
        sysparm_query: "name=" + tableName,
        sysparm_fields: "sys_id,label",
        sysparm_display_value: "true",
        sysparm_limit: 1,
      },
    })
    var rec = resp.data.result?.[0]
    return rec ? { exists: true, label: str(rec.label) || tableName } : { exists: false, label: "" }
  } catch (e: any) {
    console.warn("[snow_manage_flow] validateTableExists failed for table=" + tableName + ": " + (e.message || ""))
    return { exists: false, label: "" }
  }
}

/** Check if a table is a child of a parent table (e.g. task_table must be a child of 'task'). */
async function validateTableExtends(
  client: any,
  tableName: string,
  parentTable: string,
): Promise<{ valid: boolean; validOptions: { name: string; label: string }[]; tableLabel: string }> {
  try {
    var parentResp = await client.get("/api/now/table/sys_db_object", {
      params: { sysparm_query: "name=" + parentTable, sysparm_fields: "sys_id", sysparm_limit: 1 },
    })
    var parentSysId = str(parentResp.data.result?.[0]?.sys_id)
    if (!parentSysId) return { valid: false, validOptions: [], tableLabel: "" }

    var childResp = await client.get("/api/now/table/sys_db_object", {
      params: {
        sysparm_query: "super_class=" + parentSysId,
        sysparm_fields: "name,label",
        sysparm_display_value: "true",
        sysparm_limit: 100,
      },
    })
    var children = childResp.data.result || []
    var validOptions = children
      .map(function (c: any) {
        return { name: str(c.name), label: str(c.label) }
      })
      .filter(function (c: any) {
        return c.name
      })

    var match = children.find(function (c: any) {
      return str(c.name) === tableName
    })
    return { valid: !!match, validOptions: validOptions, tableLabel: match ? str(match.label) : "" }
  } catch (e: any) {
    console.warn(
      "[snow_manage_flow] validateTableExtends failed for " +
        tableName +
        " extends " +
        parentTable +
        ": " +
        (e.message || ""),
    )
    return { valid: false, validOptions: [], tableLabel: "" }
  }
}

// Mapping of action inputs that must be a child of a specific parent table
const TABLE_INPUT_PARENTS: Record<string, string> = {
  task_table: "task",
}

/**
 * Build full flow logic input objects AND flowLogicDefinition matching the Flow Designer UI format.
 * The UI sends inputs WITH parameter definitions and the full flowLogicDefinition in the INSERT mutation.
 *
 * Flow logic definitions (IF, ELSE, FOR_EACH, etc.) store their input parameters in
 * sys_hub_flow_logic_input (NOT sys_hub_action_input), using the definition's sys_id as the 'model' reference.
 */
async function buildFlowLogicInputsForInsert(
  client: any,
  defId: string,
  defRecord: any,
  userValues?: Record<string, string>,
): Promise<{
  inputs: any[]
  flowLogicDefinition: any
  resolvedInputs: Record<string, string>
  inputQueryError?: string
  defParamsCount: number
  missingMandatory: string[]
}> {
  // Query sys_hub_flow_logic_input for this definition's inputs (separate table from sys_hub_action_input)
  // Field names verified from actual sys_hub_flow_logic_input XML schema
  var defParams: any[] = []
  var inputQueryError = ""
  try {
    var resp = await client.get("/api/now/table/sys_hub_flow_logic_input", {
      params: {
        sysparm_query: "model=" + defId,
        sysparm_fields:
          "sys_id,element,label,internal_type,mandatory,default_value,order,max_length,hint,read_only,attributes,sys_class_name,reference,choice,dependent,dependent_on_field,use_dependent_field,column_label",
        sysparm_display_value: "false",
        sysparm_limit: 50,
      },
    })
    defParams = resp.data.result || []
  } catch (e: any) {
    inputQueryError = e.message || "unknown error"
    // Fallback: try with minimal fields
    try {
      var resp2 = await client.get("/api/now/table/sys_hub_flow_logic_input", {
        params: {
          sysparm_query: "model=" + defId,
          sysparm_fields: "sys_id,element,label,internal_type,mandatory,order,max_length,attributes",
          sysparm_display_value: "false",
          sysparm_limit: 50,
        },
      })
      defParams = resp2.data.result || []
      inputQueryError = ""
    } catch (e2: any) {
      inputQueryError += "; fallback also failed: " + (e2.message || "")
    }
  }

  // Fuzzy-match user-provided values to actual field names
  var resolvedInputs: Record<string, string> = {}
  if (userValues) {
    var paramElements = defParams.map(function (p: any) {
      return str(p.element)
    })
    for (var [key, value] of Object.entries(userValues)) {
      var strValue = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "")
      if (paramElements.includes(key)) {
        resolvedInputs[key] = strValue
        continue
      }
      var match = defParams.find(function (p: any) {
        var el = str(p.element)
        return el.endsWith("_" + key) || el === key || str(p.label).toLowerCase() === key.toLowerCase()
      })
      if (match) resolvedInputs[str(match.element)] = strValue
      else resolvedInputs[key] = strValue
    }
  }

  // Build parameter definition objects (shared between inputs array and flowLogicDefinition.inputs)
  var inputDefs = defParams.map(function (rec: any) {
    var paramType = str(rec.internal_type) || "string"
    var element = str(rec.element)
    return {
      id: str(rec.sys_id),
      label: str(rec.label) || element,
      name: element,
      type: paramType,
      type_label: TYPE_LABELS[paramType] || paramType.charAt(0).toUpperCase() + paramType.slice(1),
      hint: str(rec.hint),
      order: parseInt(str(rec.order) || "0", 10),
      extended: str(rec.extended) === "true",
      mandatory: str(rec.mandatory) === "true",
      readonly: str(rec.read_only) === "true",
      maxsize: parseInt(str(rec.max_length) || "8000", 10),
      data_structure: str(rec.data_structure),
      reference: str(rec.reference),
      reference_display: str(rec.reference_display),
      ref_qual: str(rec.ref_qual),
      choiceOption: str(rec.choice_option),
      table: str(rec.table_name),
      columnName: str(rec.column_name),
      defaultValue: str(rec.default_value),
      use_dependent: str(rec.use_dependent) === "true",
      dependent_on: str(rec.dependent_on),
      show_ref_finder: str(rec.show_ref_finder) === "true",
      local: str(rec.local) === "true",
      attributes: str(rec.attributes),
      sys_class_name: str(rec.sys_class_name),
      children: [],
    }
  })

  // Build full input objects with parameter definitions and user values
  var inputs = inputDefs.map(function (paramDef: any) {
    var userVal = resolvedInputs[paramDef.name] || ""
    return {
      id: paramDef.id,
      name: paramDef.name,
      children: [],
      displayValue: { value: "" },
      value: { schemaless: false, schemalessValue: "", value: userVal },
      parameter: paramDef,
    }
  })

  // Build flowLogicDefinition object (matching UI format)
  // Try multiple field name variations — ServiceNow column names may differ from expected snake_case
  var flowLogicDefinition: any = {
    id: defId,
    name: defRecord.name || "",
    description: str(defRecord.description),
    connectedTo: str(defRecord.connected_to) || str(defRecord.connectedTo) || str(defRecord.connectedto) || "",
    quiescence: str(defRecord.quiescence) || "never",
    compilationClass:
      str(defRecord.compilation_class) || str(defRecord.compilationClass) || str(defRecord.compilationclass) || "",
    order: parseInt(str(defRecord.order) || "1", 10),
    type: str(defRecord.type) || "",
    visible: str(defRecord.visible) !== "false",
    attributes: str(defRecord.attributes),
    userCanRead: true,
    category: str(defRecord.category),
    inputs: inputDefs,
    variables: "[]",
  }

  // Check for mandatory fields that are missing a value
  var missingMandatory = inputs
    .filter(function (inp: any) {
      return inp.parameter?.mandatory && !inp.value?.value
    })
    .map(function (inp: any) {
      return inp.name + " (" + (inp.parameter?.label || inp.name) + ")"
    })

  return {
    inputs,
    flowLogicDefinition,
    resolvedInputs,
    inputQueryError: inputQueryError || undefined,
    defParamsCount: defParams.length,
    missingMandatory,
  }
}

// Note: reordering of existing elements is NOT possible via Table API because
// Flow Designer elements only exist in the version payload (managed by GraphQL).
// The caller must provide the correct global order. When inserting between existing
// elements, the caller should include the necessary sibling updates in the same
// GraphQL mutation (matching how the Flow Designer UI works).

/**
 * Calculate the insert order for a new flow element.
 *
 * Flow Designer uses GLOBAL ordering: all elements (actions, flow logic, subflows)
 * share a single sequential numbering (1, 2, 3, 4, 5...).
 *
 * IMPORTANT: Flow elements do NOT exist as individual records in the Table API.
 * They only live inside the version payload managed by the GraphQL API.
 * Therefore we CANNOT query Table API to find existing elements or their orders.
 *
 * Order computation strategy:
 * 1. If explicit order is provided → use it as the global order (the caller knows best)
 * 2. Otherwise → try to determine max order from version payload, return max + 1
 */
async function calculateInsertOrder(
  client: any,
  flowId: string,
  _parentUiId?: string,
  explicitOrder?: number,
): Promise<number> {
  // Explicit order provided: trust it as the correct global order.
  // This matches how the Flow Designer UI works — it computes the correct global
  // order client-side and sends it in the mutation.
  if (explicitOrder) return explicitOrder

  // No explicit order: try to find max order from version payload
  const maxOrder = await getMaxOrderFromVersion(client, flowId)
  if (maxOrder > 0) return maxOrder + 1

  // Last resort fallback
  return 1
}

/**
 * Flatten an attributes object { key: "val" } into comma-separated "key=val," string (matching UI format).
 * If already a string, returns as-is.
 */
function flattenAttributes(attrs: any): string {
  if (!attrs || typeof attrs === "string") return attrs || ""
  return (
    Object.entries(attrs)
      .map(([k, v]) => k + "=" + v)
      .join(",") + ","
  )
}

/**
 * Build full trigger input and output objects for the INSERT mutation by fetching from the
 * triggerpicker API (/api/now/hub/triggerpicker/{id}) — the same endpoint Flow Designer UI uses.
 *
 * The UI sends ALL inputs with full parameter definitions (choices, defaults, attributes) and
 * ALL outputs in a single INSERT mutation. This function replicates that format exactly.
 *
 * Fallback: if the triggerpicker API fails, queries sys_hub_trigger_input / sys_hub_trigger_output
 * via the Table API (same approach as buildActionInputsForInsert / buildFlowLogicInputsForInsert).
 */
/**
 * Parse XML string from triggerpicker API to extract input/output elements.
 * The triggerpicker endpoint may return XML instead of JSON on some instances.
 */
function parseTriggerpickerXml(xmlStr: string): { inputs: any[]; outputs: any[] } {
  var inputs: any[] = []
  var outputs: any[] = []

  // Helper: extract text content of an XML element by tag name
  var getTag = function (xml: string, tag: string): string {
    var m = xml.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"))
    return m ? m[1].trim() : ""
  }

  // Helper: extract all occurrences of a repeated element
  var getAll = function (xml: string, tag: string): string[] {
    var re = new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">", "g")
    var results: string[] = []
    var m
    while ((m = re.exec(xml)) !== null) results.push(m[1])
    return results
  }

  // Try to find input elements — XML may wrap them in <inputs><element>...</element></inputs>
  // or <trigger_inputs><input>...</input></trigger_inputs> etc.
  var inputsSection = getTag(xmlStr, "inputs") || getTag(xmlStr, "trigger_inputs") || xmlStr
  var inputElements = getAll(inputsSection, "element")
  if (inputElements.length === 0) inputElements = getAll(inputsSection, "input")
  if (inputElements.length === 0) inputElements = getAll(inputsSection, "trigger_input")

  for (var ii = 0; ii < inputElements.length; ii++) {
    var el = inputElements[ii]
    var name = getTag(el, "name") || getTag(el, "element")
    if (!name) continue
    inputs.push({
      id: getTag(el, "sys_id") || getTag(el, "id"),
      name: name,
      label: getTag(el, "label") || name,
      type: getTag(el, "type") || getTag(el, "internal_type") || "string",
      type_label: getTag(el, "type_label") || "",
      mandatory: getTag(el, "mandatory") === "true",
      order: parseInt(getTag(el, "order") || "0", 10),
      maxsize: parseInt(getTag(el, "maxsize") || getTag(el, "max_length") || "4000", 10),
      hint: getTag(el, "hint"),
      defaultValue: getTag(el, "defaultValue") || getTag(el, "default_value"),
      defaultDisplayValue: getTag(el, "defaultDisplayValue") || getTag(el, "default_display_value"),
      choiceOption: getTag(el, "choiceOption") || getTag(el, "choice_option"),
      reference: getTag(el, "reference"),
      reference_display: getTag(el, "reference_display"),
      use_dependent: getTag(el, "use_dependent") === "true",
      dependent_on: getTag(el, "dependent_on"),
      internal_link: getTag(el, "internal_link"),
      attributes: getTag(el, "attributes"),
    })
  }

  var outputsSection = getTag(xmlStr, "outputs") || getTag(xmlStr, "trigger_outputs") || ""
  var outputElements = getAll(outputsSection, "element")
  if (outputElements.length === 0) outputElements = getAll(outputsSection, "output")
  if (outputElements.length === 0) outputElements = getAll(outputsSection, "trigger_output")

  for (var oi = 0; oi < outputElements.length; oi++) {
    var oel = outputElements[oi]
    var oname = getTag(oel, "name") || getTag(oel, "element")
    if (!oname) continue
    outputs.push({
      id: getTag(oel, "sys_id") || getTag(oel, "id"),
      name: oname,
      label: getTag(oel, "label") || oname,
      type: getTag(oel, "type") || getTag(oel, "internal_type") || "string",
      type_label: getTag(oel, "type_label") || "",
      mandatory: getTag(oel, "mandatory") === "true",
      order: parseInt(getTag(oel, "order") || "0", 10),
      maxsize: parseInt(getTag(oel, "maxsize") || getTag(oel, "max_length") || "200", 10),
      hint: getTag(oel, "hint"),
      reference: getTag(oel, "reference"),
      reference_display: getTag(oel, "reference_display"),
      use_dependent: getTag(oel, "use_dependent") === "true",
      dependent_on: getTag(oel, "dependent_on"),
      internal_link: getTag(oel, "internal_link"),
      attributes: getTag(oel, "attributes"),
    })
  }

  return { inputs, outputs }
}

/**
 * Build a single trigger input object in GraphQL mutation format.
 * Used by buildTriggerInputsForInsert and the hardcoded fallback.
 */
function buildTriggerInputObj(inp: any, userTable?: string, userCondition?: string): any {
  var paramType = inp.type || "string"
  var name = inp.name || ""
  var label = inp.label || name
  var attrs = typeof inp.attributes === "object" ? flattenAttributes(inp.attributes) : inp.attributes || ""

  // Determine value: user-provided > default
  var value = ""
  if (name === "table" && userTable) value = userTable
  else if (name === "condition") value = userCondition || "^EQ"
  else if (inp.defaultValue) value = inp.defaultValue

  var parameter: any = {
    id: inp.id || "",
    label: label,
    name: name,
    type: paramType,
    type_label: inp.type_label || TYPE_LABELS[paramType] || paramType,
    order: inp.order || 0,
    extended: inp.extended || false,
    mandatory: inp.mandatory || false,
    readonly: inp.readonly || false,
    maxsize: inp.maxsize || 4000,
    data_structure: "",
    reference: inp.reference || "",
    reference_display: inp.reference_display || "",
    ref_qual: inp.ref_qual || "",
    choiceOption: inp.choiceOption || "",
    table: "",
    columnName: "",
    defaultValue: inp.defaultValue || "",
    use_dependent: inp.use_dependent || false,
    dependent_on: inp.dependent_on || "",
    internal_link: inp.internal_link || "",
    show_ref_finder: inp.show_ref_finder || false,
    local: inp.local || false,
    attributes: attrs,
    sys_class_name: "",
    children: [],
  }
  if (inp.hint) parameter.hint = inp.hint
  if (inp.defaultDisplayValue) parameter.defaultDisplayValue = inp.defaultDisplayValue
  if (inp.choices) parameter.choices = inp.choices
  if (inp.defaultChoices) parameter.defaultChoices = inp.defaultChoices

  var inputObj: any = {
    name: name,
    label: label,
    internalType: paramType,
    mandatory: inp.mandatory || false,
    order: inp.order || 0,
    valueSysId: "",
    field_name: name,
    type: paramType,
    children: [],
    displayValue: { value: "" },
    value: value ? { schemaless: false, schemalessValue: "", value: value } : { value: "" },
    parameter: parameter,
  }

  if (inp.choices && Array.isArray(inp.choices)) {
    inputObj.choiceList = inp.choices.map(function (c: any) {
      return { label: c.label, value: c.value }
    })
  }

  return inputObj
}

/**
 * Build a single trigger output object in GraphQL mutation format.
 */
function buildTriggerOutputObj(out: any): any {
  var paramType = out.type || "string"
  var name = out.name || ""
  var label = out.label || name
  var attrs = typeof out.attributes === "object" ? flattenAttributes(out.attributes) : out.attributes || ""

  var parameter: any = {
    id: out.id || "",
    label: label,
    name: name,
    type: paramType,
    type_label: out.type_label || TYPE_LABELS[paramType] || paramType,
    hint: out.hint || "",
    order: out.order || 0,
    extended: out.extended || false,
    mandatory: out.mandatory || false,
    readonly: out.readonly || false,
    maxsize: out.maxsize || 200,
    data_structure: "",
    reference: out.reference || "",
    reference_display: out.reference_display || "",
    ref_qual: "",
    choiceOption: "",
    table: "",
    columnName: "",
    defaultValue: "",
    use_dependent: out.use_dependent || false,
    dependent_on: out.dependent_on || "",
    internal_link: out.internal_link || "",
    show_ref_finder: false,
    local: false,
    attributes: attrs,
    sys_class_name: "",
  }

  var children: any[] = []
  var paramChildren: any[] = []
  if (out.children && Array.isArray(out.children)) {
    children = out.children.map(function (child: any) {
      return { id: "", name: child.name || "", scriptActive: false, children: [], value: { value: "" }, script: null }
    })
    paramChildren = out.children.map(function (child: any) {
      return {
        id: "",
        label: child.label || child.name || "",
        name: child.name || "",
        type: child.type || "string",
        type_label: child.type_label || TYPE_LABELS[child.type || "string"] || "String",
        hint: "",
        order: child.order || 0,
        extended: false,
        mandatory: false,
        readonly: false,
        maxsize: 0,
        data_structure: "",
        reference: "",
        reference_display: "",
        ref_qual: "",
        choiceOption: "",
        table: "",
        columnName: "",
        defaultValue: "",
        defaultDisplayValue: "",
        use_dependent: false,
        dependent_on: false,
        show_ref_finder: false,
        local: false,
        attributes: "",
        sys_class_name: "",
        uiDisplayType: child.uiDisplayType || child.type || "string",
        uiDisplayTypeLabel: child.type_label || "String",
        internal_link: "",
        value: "",
        display_value: "",
        scriptActive: false,
        parent: out.id || "",
        fieldFacetMap: "uiTypeLabel=" + (child.type_label || "String") + ",",
        children: [],
        script: null,
      }
    })
  }
  parameter.children = paramChildren

  return {
    name: name,
    value: "",
    displayValue: "",
    type: paramType,
    order: out.order || 0,
    label: label,
    children: children,
    parameter: parameter,
  }
}

/**
 * Hardcoded record trigger inputs — used as ultimate fallback when API and Table lookups fail.
 * These definitions match the exact format captured from the Flow Designer UI for record-based triggers
 * (record_create, record_update, record_create_or_update). Field names and types are consistent across instances.
 */
function getRecordTriggerFallbackInputs(): any[] {
  return [
    {
      name: "table",
      label: "Table",
      type: "table_name",
      type_label: "Table Name",
      mandatory: true,
      order: 1,
      maxsize: 80,
      attributes: "filter_table_source=RECORD_WATCHER_RESTRICTED,",
    },
    {
      name: "condition",
      label: "Condition",
      type: "conditions",
      type_label: "Conditions",
      mandatory: false,
      order: 100,
      maxsize: 4000,
      use_dependent: true,
      dependent_on: "table",
      attributes:
        "extended_operators=VALCHANGES;CHANGESFROM;CHANGESTO,wants_to_add_conditions=true,modelDependent=trigger_inputs,",
    },
    {
      name: "run_on_extended",
      label: "run_on_extended",
      type: "choice",
      type_label: "Choice",
      mandatory: false,
      order: 100,
      maxsize: 40,
      defaultValue: "false",
      defaultDisplayValue: "Run only on current table",
      choiceOption: "3",
      attributes: "advanced=true,",
      choices: [
        { label: "Run only on current table", value: "false", order: 0 },
        { label: "Run on current and extended tables", value: "true", order: 1 },
      ],
      defaultChoices: [
        { label: "Run only on current table", value: "false", order: 1 },
        { label: "Run on current and extended tables", value: "true", order: 2 },
      ],
    },
    {
      name: "run_flow_in",
      label: "run_flow_in",
      type: "choice",
      type_label: "Choice",
      mandatory: false,
      order: 100,
      maxsize: 40,
      defaultValue: "any",
      defaultDisplayValue: "any",
      choiceOption: "3",
      attributes: "advanced=true,",
      choices: [
        { label: "Run flow in background (default)", value: "background", order: 0 },
        { label: "Run flow in foreground", value: "foreground", order: 1 },
      ],
      defaultChoices: [
        { label: "Run flow in background (default)", value: "background", order: 1 },
        { label: "Run flow in foreground", value: "foreground", order: 2 },
      ],
    },
    {
      name: "run_when_user_list",
      label: "run_when_user_list",
      type: "glide_list",
      type_label: "List",
      mandatory: false,
      order: 100,
      maxsize: 4000,
      reference: "sys_user",
      reference_display: "User",
      attributes: "advanced=true,",
    },
    {
      name: "run_when_setting",
      label: "run_when_setting",
      type: "choice",
      type_label: "Choice",
      mandatory: false,
      order: 100,
      maxsize: 40,
      defaultValue: "both",
      defaultDisplayValue: "Run for Both Interactive and Non-Interactive Sessions",
      choiceOption: "3",
      attributes: "advanced=true,",
      choices: [
        { label: "Only Run for Non-Interactive Session", value: "non_interactive", order: 0 },
        { label: "Only Run for User Interactive Session", value: "interactive", order: 1 },
        { label: "Run for Both Interactive and Non-Interactive Sessions", value: "both", order: 2 },
      ],
      defaultChoices: [
        { label: "Only Run for Non-Interactive Session", value: "non_interactive", order: 1 },
        { label: "Only Run for User Interactive Session", value: "interactive", order: 2 },
        { label: "Run for Both Interactive and Non-Interactive Sessions", value: "both", order: 3 },
      ],
    },
    {
      name: "run_when_user_setting",
      label: "run_when_user_setting",
      type: "choice",
      type_label: "Choice",
      mandatory: false,
      order: 100,
      maxsize: 40,
      defaultValue: "any",
      defaultDisplayValue: "Run for any user",
      choiceOption: "3",
      attributes: "advanced=true,",
      choices: [
        { label: "Do not run if triggered by the following users", value: "not_one_of", order: 0 },
        { label: "Only Run if triggered by the following users", value: "one_of", order: 1 },
        { label: "Run for any user", value: "any", order: 2 },
      ],
      defaultChoices: [
        { label: "Do not run if triggered by the following users", value: "not_one_of", order: 1 },
        { label: "Only Run if triggered by the following users", value: "one_of", order: 2 },
        { label: "Run for any user", value: "any", order: 3 },
      ],
    },
    {
      name: "trigger_strategy",
      label: "Run Trigger",
      type: "choice",
      type_label: "Choice",
      mandatory: false,
      order: 200,
      maxsize: 40,
      defaultValue: "once",
      defaultDisplayValue: "Once",
      choiceOption: "3",
      hint: "Run Trigger every time the condition matches, or only the first time.",
      choices: [
        { label: "Once", value: "once", order: 0 },
        { label: "For each unique change", value: "unique_changes", order: 1 },
        { label: "Only if not currently running", value: "always", order: 2 },
        { label: "For every update", value: "every", order: 3 },
      ],
      defaultChoices: [
        { label: "Once", value: "once", order: 1 },
        { label: "For each unique change", value: "unique_changes", order: 2 },
        { label: "Only if not currently running", value: "always", order: 3 },
        { label: "For every update", value: "every", order: 4 },
      ],
    },
  ]
}

function getRecordTriggerFallbackOutputs(): any[] {
  return [
    {
      name: "current",
      label: "Record",
      type: "document_id",
      type_label: "Document ID",
      mandatory: true,
      order: 100,
      maxsize: 200,
      use_dependent: true,
      dependent_on: "table_name",
      internal_link: "table",
    },
    {
      name: "changed_fields",
      label: "Changed Fields",
      type: "array.object",
      type_label: "Array.Object",
      mandatory: false,
      order: 100,
      maxsize: 4000,
      attributes:
        "uiTypeLabel=Array.Object,co_type_name=FDCollection,child_label=FDChangeDetails,child_type_label=Object,element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,pwd2droppable=true,uiType=array.object,child_type=object,child_name=FDChangeDetails,",
      children: [
        { name: "field_name", label: "Field Name", type: "string", type_label: "String", order: 1 },
        { name: "previous_value", label: "Previous Value", type: "string", type_label: "String", order: 2 },
        { name: "current_value", label: "Current Value", type: "string", type_label: "String", order: 3 },
        {
          name: "previous_display_value",
          label: "Previous Display Value",
          type: "string",
          type_label: "String",
          order: 4,
        },
        {
          name: "current_display_value",
          label: "Current Display Value",
          type: "string",
          type_label: "String",
          order: 5,
        },
      ],
    },
    {
      name: "table_name",
      label: "Table Name",
      type: "table_name",
      type_label: "Table Name",
      mandatory: false,
      order: 101,
      maxsize: 200,
      internal_link: "table",
      attributes: "test_input_hidden=true,",
    },
    {
      name: "run_start_time",
      label: "Run Start Time UTC",
      type: "glide_date_time",
      type_label: "Date/Time",
      mandatory: false,
      order: 110,
      maxsize: 200,
      attributes: "test_input_hidden=true,",
    },
    {
      name: "run_start_date_time",
      label: "Run Start Date/Time",
      type: "glide_date_time",
      type_label: "Date/Time",
      mandatory: false,
      order: 110,
      maxsize: 200,
      attributes: "test_input_hidden=true,",
    },
  ]
}

async function buildTriggerInputsForInsert(
  client: any,
  trigDefId: string,
  trigType: string,
  userTable?: string,
  userCondition?: string,
): Promise<{ inputs: any[]; outputs: any[]; source: string; error?: string }> {
  var apiInputs: any[] = []
  var apiOutputs: any[] = []
  var fetchError = ""
  var source = ""

  // Strategy 1: triggerpicker API (primary — same as Flow Designer UI)
  try {
    var tpResp = await client.get("/api/now/hub/triggerpicker/" + trigDefId, {
      params: { sysparm_transaction_scope: "global" },
      headers: { Accept: "application/json" },
    })
    var tpRaw = tpResp.data
    var tpData = tpRaw?.result || tpRaw

    // Handle JSON object response
    if (tpData && typeof tpData === "object" && !Array.isArray(tpData)) {
      // Try common field name variations
      var foundInputs = Array.isArray(tpData.inputs)
        ? tpData.inputs
        : Array.isArray(tpData.trigger_inputs)
          ? tpData.trigger_inputs
          : Array.isArray(tpData.input)
            ? tpData.input
            : null
      var foundOutputs = Array.isArray(tpData.outputs)
        ? tpData.outputs
        : Array.isArray(tpData.trigger_outputs)
          ? tpData.trigger_outputs
          : Array.isArray(tpData.output)
            ? tpData.output
            : null
      if (foundInputs) {
        apiInputs = foundInputs
        source = "triggerpicker_json"
      }
      if (foundOutputs) apiOutputs = foundOutputs

      // If no arrays found, try to explore nested structure
      if (!foundInputs && !foundOutputs) {
        for (var key of Object.keys(tpData)) {
          var val = tpData[key]
          if (val && typeof val === "object" && !Array.isArray(val)) {
            if (Array.isArray(val.inputs)) {
              apiInputs = val.inputs
              source = "triggerpicker_json." + key
            }
            if (Array.isArray(val.outputs)) apiOutputs = val.outputs
          }
        }
      }
    }

    // Handle XML string response
    if (apiInputs.length === 0 && typeof tpData === "string" && tpData.includes("<")) {
      var xmlResult = parseTriggerpickerXml(tpData)
      if (xmlResult.inputs.length > 0) {
        apiInputs = xmlResult.inputs
        apiOutputs = xmlResult.outputs
        source = "triggerpicker_xml"
      }
    }
    // Also check if the raw response itself is XML (not wrapped in result)
    if (apiInputs.length === 0 && typeof tpRaw === "string" && tpRaw.includes("<")) {
      var xmlResult2 = parseTriggerpickerXml(tpRaw)
      if (xmlResult2.inputs.length > 0) {
        apiInputs = xmlResult2.inputs
        apiOutputs = xmlResult2.outputs
        source = "triggerpicker_xml_raw"
      }
    }
  } catch (tpErr: any) {
    fetchError = "triggerpicker: " + (tpErr.message || "unknown")
  }

  // Strategy 2: Table API fallback (query sys_hub_trigger_input / sys_hub_trigger_output)
  if (apiInputs.length === 0) {
    try {
      var tiResp = await client.get("/api/now/table/sys_hub_trigger_input", {
        params: {
          sysparm_query: "model=" + trigDefId,
          sysparm_fields:
            "sys_id,element,label,internal_type,mandatory,default_value,order,max_length,hint,read_only,attributes,reference,reference_display,choice,dependent_on_field,use_dependent_field",
          sysparm_display_value: "false",
          sysparm_limit: 50,
        },
      })
      var tableInputs = tiResp.data.result || []
      if (tableInputs.length > 0) {
        apiInputs = tableInputs.map(function (rec: any) {
          return {
            id: str(rec.sys_id),
            name: str(rec.element),
            label: str(rec.label) || str(rec.element),
            type: str(rec.internal_type) || "string",
            type_label: TYPE_LABELS[str(rec.internal_type) || "string"] || str(rec.internal_type),
            mandatory: str(rec.mandatory) === "true",
            order: parseInt(str(rec.order) || "0", 10),
            maxsize: parseInt(str(rec.max_length) || "4000", 10),
            hint: str(rec.hint),
            defaultValue: str(rec.default_value),
            reference: str(rec.reference),
            reference_display: str(rec.reference_display),
            use_dependent: str(rec.use_dependent_field) === "true",
            dependent_on: str(rec.dependent_on_field),
            attributes: str(rec.attributes),
          }
        })
        source = "table_api"
        fetchError = ""
      }
    } catch (tiErr: any) {
      fetchError += "; table_api_inputs: " + (tiErr.message || "unknown")
    }
  }
  if (apiOutputs.length === 0) {
    try {
      var toResp = await client.get("/api/now/table/sys_hub_trigger_output", {
        params: {
          sysparm_query: "model=" + trigDefId,
          sysparm_fields:
            "sys_id,element,label,internal_type,mandatory,order,max_length,hint,attributes,reference,reference_display,use_dependent_field,dependent_on_field",
          sysparm_display_value: "false",
          sysparm_limit: 50,
        },
      })
      var tableOutputs = toResp.data.result || []
      if (tableOutputs.length > 0) {
        apiOutputs = tableOutputs.map(function (rec: any) {
          return {
            id: str(rec.sys_id),
            name: str(rec.element),
            label: str(rec.label) || str(rec.element),
            type: str(rec.internal_type) || "string",
            type_label: TYPE_LABELS[str(rec.internal_type) || "string"] || str(rec.internal_type),
            mandatory: str(rec.mandatory) === "true",
            order: parseInt(str(rec.order) || "0", 10),
            maxsize: parseInt(str(rec.max_length) || "200", 10),
            hint: str(rec.hint),
            reference: str(rec.reference),
            reference_display: str(rec.reference_display),
            use_dependent: str(rec.use_dependent_field) === "true",
            dependent_on: str(rec.dependent_on_field),
            attributes: str(rec.attributes),
          }
        })
      }
    } catch (_) {}
  }

  // Strategy 3: Hardcoded fallback for record-based triggers (ultimate safety net)
  // Uses exact definitions captured from the Flow Designer UI
  var isRecordTrigger = /record/.test(trigType.toLowerCase())
  if (apiInputs.length === 0 && isRecordTrigger) {
    apiInputs = getRecordTriggerFallbackInputs()
    source = "hardcoded_fallback"
  }
  if (apiOutputs.length === 0 && isRecordTrigger) {
    apiOutputs = getRecordTriggerFallbackOutputs()
  }

  // Transform to GraphQL mutation format
  var inputs = apiInputs.map(function (inp: any) {
    return buildTriggerInputObj(inp, userTable, userCondition)
  })
  var outputs = apiOutputs.map(function (out: any) {
    return buildTriggerOutputObj(out)
  })

  // Final safety net: ensure table and condition inputs are ALWAYS present for record triggers
  if (isRecordTrigger) {
    var hasTable = inputs.some(function (i: any) {
      return i.name === "table"
    })
    var hasCondition = inputs.some(function (i: any) {
      return i.name === "condition"
    })
    if (!hasTable) {
      inputs.unshift(
        buildTriggerInputObj(
          {
            name: "table",
            label: "Table",
            type: "table_name",
            type_label: "Table Name",
            mandatory: true,
            order: 1,
            maxsize: 80,
            attributes: "filter_table_source=RECORD_WATCHER_RESTRICTED,",
          },
          userTable,
          userCondition,
        ),
      )
      source += "+table_injected"
    }
    if (!hasCondition) {
      var condIdx = inputs.findIndex(function (i: any) {
        return i.name === "table"
      })
      inputs.splice(
        condIdx + 1,
        0,
        buildTriggerInputObj(
          {
            name: "condition",
            label: "Condition",
            type: "conditions",
            type_label: "Conditions",
            mandatory: false,
            order: 100,
            maxsize: 4000,
            use_dependent: true,
            dependent_on: "table",
            attributes:
              "extended_operators=VALCHANGES;CHANGESFROM;CHANGESTO,wants_to_add_conditions=true,modelDependent=trigger_inputs,",
          },
          userTable,
          userCondition,
        ),
      )
      source += "+condition_injected"
    }
  }

  return { inputs, outputs, source: source || "none", error: fetchError || undefined }
}

async function addTriggerViaGraphQL(
  client: any,
  flowId: string,
  triggerType: string,
  table?: string,
  condition?: string,
  annotation?: string,
): Promise<{ success: boolean; triggerId?: string; steps?: any; error?: string }> {
  const steps: any = {}

  // Dynamically look up trigger definition in sys_hub_trigger_definition
  let trigDefId: string | null = null
  let trigName = ""
  let trigType = triggerType
  let trigCategory = ""

  // Build search variations: record_updated → also try record_update, and vice versa
  const variations = [triggerType]
  if (triggerType.endsWith("ed")) variations.push(triggerType.slice(0, -1), triggerType.slice(0, -2))
  else if (triggerType.endsWith("e")) variations.push(triggerType + "d")
  else variations.push(triggerType + "ed", triggerType + "d")

  const assignFound = (found: any, matched: string) => {
    trigDefId = found.sys_id
    trigName = str(found.name) || triggerType
    trigType = str(found.type) || triggerType
    trigCategory = str(found.category)
    steps.def_lookup = {
      id: found.sys_id,
      type: str(found.type),
      name: str(found.name),
      category: str(found.category),
      matched,
    }
  }

  // Try exact match on type and name for each variation
  for (const variant of variations) {
    if (trigDefId) break
    for (const field of ["type", "name"]) {
      if (trigDefId) break
      try {
        const resp = await client.get("/api/now/table/sys_hub_trigger_definition", {
          params: {
            sysparm_query: field + "=" + variant,
            sysparm_fields: "sys_id,type,name,category",
            sysparm_display_value: "true",
            sysparm_limit: 1,
          },
        })
        const found = resp.data.result?.[0]
        if (found?.sys_id) assignFound(found, field + "=" + variant)
      } catch (_) {}
    }
  }
  // Fallback: LIKE search using shortest variation (most likely to match)
  if (!trigDefId) {
    const shortest = variations.reduce((a, b) => (a.length <= b.length ? a : b))
    try {
      const resp = await client.get("/api/now/table/sys_hub_trigger_definition", {
        params: {
          sysparm_query: "typeLIKE" + shortest + "^ORnameLIKE" + shortest,
          sysparm_fields: "sys_id,type,name,category",
          sysparm_display_value: "true",
          sysparm_limit: 5,
        },
      })
      const results = resp.data.result || []
      steps.def_lookup_fallback_candidates = results.map((r: any) => ({
        sys_id: r.sys_id,
        type: r.type,
        name: r.name,
        category: r.category,
      }))
      if (results[0]?.sys_id) assignFound(results[0], "LIKE " + shortest)
    } catch (_) {}
  }
  if (!trigDefId) return { success: false, error: "Trigger definition not found for: " + triggerType, steps }

  // Validate: record-based triggers REQUIRE a table parameter
  var trigNameLC = trigName.toLowerCase()
  var trigTypeLC = trigType.toLowerCase()
  var trigCategoryLC = trigCategory.toLowerCase()
  var isRecordTrigger = ["record", "crud"].some(function (kw) {
    return trigNameLC.includes(kw) || trigTypeLC.includes(kw) || trigCategoryLC.includes(kw)
  })
  if (isRecordTrigger && !table) {
    return {
      success: false,
      error:
        'Trigger type "' +
        trigName +
        '" requires a table parameter (e.g. table: "incident"). Record-based triggers must know which table to watch.',
      steps,
    }
  }

  // Validate that the trigger table exists in ServiceNow
  if (table) {
    var trigTblCheck = await validateTableExists(client, table)
    if (!trigTblCheck.exists) {
      return {
        success: false,
        error: "Table '" + table + "' does not exist in ServiceNow. Cannot create trigger for non-existent table.",
        steps: steps,
      }
    }
  }

  // Build full trigger inputs and outputs from triggerpicker API (matching UI format)
  // Pass empty table/condition — values are set via separate UPDATE (two-step, matching UI)
  var triggerData = await buildTriggerInputsForInsert(client, trigDefId!, trigType, undefined, undefined)
  steps.trigger_data = {
    inputCount: triggerData.inputs.length,
    outputCount: triggerData.outputs.length,
    source: triggerData.source,
    error: triggerData.error,
  }

  const triggerResponseFields =
    "triggerInstances { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }"
  try {
    // Step 1: INSERT with empty table/condition values (matching UI behavior from trigger-query.txt)
    // The UI always inserts the trigger with empty inputs first, then updates with actual values.
    var insertInputs = triggerData.inputs.map(function (inp: any) {
      if (inp.name === "table") {
        // UI sends table with plain empty value format
        return { ...inp, value: { value: "" }, displayValue: { value: "" } }
      }
      if (inp.name === "condition") {
        // UI sends condition with schemaless wrapper and "^EQ" default (not empty string)
        return { ...inp, value: { schemaless: false, schemalessValue: "", value: "^EQ" }, displayValue: { value: "" } }
      }
      return inp
    })

    const insertResult = await executeFlowPatchMutation(
      client,
      {
        flowId: flowId,
        triggerInstances: {
          insert: [
            {
              flowSysId: flowId,
              name: trigName,
              triggerType: trigCategory,
              triggerDefinitionId: trigDefId,
              type: trigType,
              hasDynamicOutputs: false,
              metadata: '{"predicates":[]}',
              inputs: insertInputs,
              outputs: triggerData.outputs,
              comment: annotation || "",
            },
          ],
        },
      },
      triggerResponseFields,
    )

    const triggerId = insertResult?.triggerInstances?.inserts?.[0]?.sysId
    const triggerUiId = insertResult?.triggerInstances?.inserts?.[0]?.uiUniqueIdentifier
    steps.insert = { success: !!triggerId, triggerId, triggerUiId }
    if (!triggerId) return { success: false, steps, error: "GraphQL trigger INSERT returned no trigger ID" }

    // Step 2: UPDATE with actual table and condition values (matching UI behavior)
    // The UI sends: table with displayField+displayValue+value, condition with displayField+displayValue(empty)+value, metadata with predicates
    if (table) {
      try {
        var tableDisplayName = ""
        try {
          var tblResp = await client.get("/api/now/table/sys_db_object", {
            params: {
              sysparm_query: "name=" + table,
              sysparm_fields: "label",
              sysparm_display_value: "true",
              sysparm_limit: 1,
            },
          })
          tableDisplayName = str(tblResp.data.result?.[0]?.label) || ""
        } catch (_) {}
        if (!tableDisplayName) {
          tableDisplayName = table.charAt(0).toUpperCase() + table.slice(1).replace(/_/g, " ")
        }

        // Build condition predicates via query_parse API (same as UI)
        var conditionValue = condition || "^EQ"
        var predicatesJson = "[]"
        if (conditionValue && conditionValue !== "^EQ") {
          try {
            var qpResp = await client.get("/api/now/ui/query_parse/" + table + "/map", {
              params: { sysparm_transaction_scope: "global", table: table, sysparm_query: conditionValue },
            })
            var qpResult = qpResp.data?.result
            if (qpResult) {
              predicatesJson = typeof qpResult === "string" ? qpResult : JSON.stringify(qpResult)
            }
          } catch (qpErr: any) {
            steps.condition_predicates_error = qpErr.message || "query_parse API failed"
            // Fallback: build minimal predicates from parsed condition
            var parsedClauses = parseEncodedQuery(conditionValue)
            if (parsedClauses.length > 0) {
              var minPredicates = parsedClauses.map(function (c) {
                return { field: c.field, operator: c.operator, value: c.value }
              })
              predicatesJson = JSON.stringify(minPredicates)
            }
          }
        }

        var trigUpdateInputs: any[] = [
          {
            name: "table",
            displayField: "number",
            displayValue: { schemaless: false, schemalessValue: "", value: tableDisplayName },
            value: { schemaless: false, schemalessValue: "", value: table },
          },
          {
            name: "condition",
            displayField: "",
            displayValue: { value: "" },
            value: { schemaless: false, schemalessValue: "", value: conditionValue },
          },
        ]

        await executeFlowPatchMutation(
          client,
          {
            flowId: flowId,
            triggerInstances: {
              update: [
                {
                  id: triggerId,
                  inputs: trigUpdateInputs,
                  metadata: '{"predicates":' + predicatesJson + "}",
                  comment: annotation || "",
                },
              ],
            },
          },
          triggerResponseFields,
        )
        steps.trigger_update = {
          success: true,
          table: table,
          tableDisplay: tableDisplayName,
          predicates: predicatesJson,
        }
      } catch (updateErr: any) {
        steps.trigger_update = { success: false, error: updateErr.message }
        // Rollback: delete the just-inserted trigger to avoid a broken element
        try {
          await executeFlowPatchMutation(
            client,
            { flowId: flowId, triggerInstances: { delete: [triggerId] } },
            "triggerInstances { deletes __typename }",
          )
          steps.trigger_rollback = { success: true, deleted: triggerId }
        } catch (rollbackErr: any) {
          steps.trigger_rollback = { success: false, error: rollbackErr.message }
        }
        return { success: false, steps, error: "Trigger created but UPDATE failed (rolled back): " + updateErr.message }
      }
    }

    return { success: true, triggerId, steps }
  } catch (e: any) {
    steps.insert = { success: false, error: e.message }
    return { success: false, steps, error: "GraphQL trigger INSERT failed: " + e.message }
  }
}

// Common short-name aliases for action types — maps user-friendly names to ServiceNow internal names
const ACTION_TYPE_ALIASES: Record<string, string[]> = {
  log: ["log_message", "Log Message", "Log"],
  create_record: ["Create Record"],
  update_record: ["Update Record"],
  lookup_record: ["look_up_record", "Look Up Record"],
  look_up: ["look_up_record", "Look Up Record"],
  delete_record: ["Delete Record"],
  notification: ["send_notification", "send_email", "Send Notification", "Send Email"],
  send_email: ["send_notification", "Send Notification", "Send Email"],
  field_update: ["set_field_values", "Set Field Values"],
  set_field_values: ["field_update", "Field Update", "Set Field Values"],
  wait: ["wait_for", "Wait For Duration", "Wait"],
  wait_for_condition: ["Wait for Condition"],
  approval: ["ask_for_approval", "create_approval", "Ask for Approval"],
  ask_for_approval: ["create_approval", "Ask for Approval"],
  lookup: ["look_up_record", "lookup_record", "Look Up Record"],
  "update record": ["update_record", "Update Record"],
  "create record": ["create_record", "Create Record"],
  "delete record": ["delete_record", "Delete Record"],
  "look up record": ["look_up_record", "Look Up Record"],
  "look up records": ["look_up_records", "Look Up Records"],
  "ask for approval": ["ask_for_approval", "Ask For Approval"],
  "send notification": ["send_notification", "Send Notification"],
  "send email": ["send_notification", "send_email", "Send Notification", "Send Email"],
  "log message": ["log", "log_message", "Log"],
  "set field values": ["set_field_values", "field_update", "Set Field Values"],
  "wait for condition": ["wait_for_condition", "Wait for Condition"],
}

// Flow logic types that should NOT be used as action types — redirect to add_flow_logic
const FLOW_LOGIC_NOT_ACTION: Record<string, string> = {
  if: "IF",
  else: "ELSE",
  elseif: "ELSEIF",
  else_if: "ELSEIF",
  for_each: "FOREACH",
  foreach: "FOREACH",
  do_until: "DOUNTIL",
  dountil: "DOUNTIL",
  switch: "SWITCH",
  parallel: "PARALLEL",
  try: "TRY",
  end: "END",
  break: "BREAK",
  continue: "CONTINUE",
  while: "DOUNTIL",
  set_flow_variable: "SETFLOWVARIABLES",
  set_flow_variables: "SETFLOWVARIABLES",
  setflowvariables: "SETFLOWVARIABLES",
  set_variable: "SETFLOWVARIABLES",
  append_flow_variable: "APPENDFLOWVARIABLES",
  append_flow_variables: "APPENDFLOWVARIABLES",
  appendflowvariables: "APPENDFLOWVARIABLES",
  get_flow_output: "GETFLOWOUTPUT",
  get_flow_outputs: "GETFLOWOUTPUT",
  getflowoutput: "GETFLOWOUTPUT",
}

async function addActionViaGraphQL(
  client: any,
  flowId: string,
  actionType: string,
  actionName: string,
  inputs?: Record<string, string>,
  parentUiId?: string,
  order?: number,
  spoke?: string,
  annotation?: string,
  displayText?: string,
): Promise<{
  success: boolean
  actionId?: string
  uiUniqueIdentifier?: string
  resolvedOrder?: number
  steps?: any
  error?: string
}> {
  const steps: any = {}

  // Block flow logic types from being used as actions — redirect to add_flow_logic
  var flowLogicType = FLOW_LOGIC_NOT_ACTION[actionType.toLowerCase()]
  if (flowLogicType) {
    return {
      success: false,
      error:
        '"' +
        actionType +
        '" is a flow logic type, not an action. Use add_flow_logic with logic_type: "' +
        flowLogicType +
        '" instead of add_action. Flow logic (If/Else, For Each, Do Until, Switch, etc.) creates branching/looping blocks in the flow, while actions are individual steps like Log, Update Record, Send Email.',
      steps,
    }
  }

  // Strip scope prefix from action type (e.g. "sn_fd.log" → "log", "global.update_record" → "update_record")
  // Agents sometimes pass fully-qualified action names with scope prefix
  if (actionType.includes(".")) {
    var dotIdx = actionType.lastIndexOf(".")
    var stripped = actionType.substring(dotIdx + 1)
    if (stripped.length > 0) {
      steps.scope_prefix_stripped = { original: actionType, stripped: stripped }
      actionType = stripped
    }
  }

  // Auto-default spoke to 'global' for well-known core action types to avoid picking spoke-specific variants
  var CORE_GLOBAL_ACTIONS = [
    "update_record",
    "create_record",
    "lookup_record",
    "delete_record",
    "log",
    "create_task",
    "update_task",
    "create_approval",
    "send_notification",
    "notification",
    "field_update",
    "wait",
    "ask_for_approval",
    "lookup_records",
    "create_catalog_task",
  ]
  if (!spoke && CORE_GLOBAL_ACTIONS.includes(actionType.toLowerCase())) {
    spoke = "global"
    steps.spoke_defaulted = "global"
  }

  // Dynamically look up action definition in sys_hub_action_type_snapshot and sys_hub_action_type_definition
  // Prefer global/core actions over spoke-specific ones (e.g. core "Update Record" vs spoke-specific "Update Record")
  const snapshotFields = "sys_id,internal_name,name,sys_scope,sys_package"
  let actionDefId: string | null = null

  // Helper: pick the best match from candidates — filter by spoke FIRST, then prefer global scope
  const pickBest = (candidates: any[]): any => {
    if (!candidates || candidates.length === 0) return null
    // If spoke filter is specified, filter candidates BEFORE the single-result shortcut
    if (spoke) {
      var spokeLC = spoke.toLowerCase()
      var spokeFiltered = candidates.filter(
        (c: any) =>
          str(c.sys_scope).toLowerCase().includes(spokeLC) ||
          str(c.sys_package).toLowerCase().includes(spokeLC) ||
          str(c.internal_name)
            .toLowerCase()
            .startsWith(spokeLC + "."),
      )
      if (spokeFiltered.length > 0) {
        steps.spoke_filter = { spoke: spoke, before: candidates.length, after: spokeFiltered.length }
        return spokeFiltered[0]
      }
      // Spoke filter didn't match anything — fall through to general preference
      steps.spoke_filter = {
        spoke: spoke,
        before: candidates.length,
        after: 0,
        warning: "No candidates matched spoke filter, falling back to general preference",
      }
    }
    if (candidates.length === 1) return candidates[0]
    // Prefer global scope
    var global = candidates.find((c: any) => str(c.sys_scope) === "global" || str(c.sys_scope) === "rhino.global")
    if (global) return global
    // Prefer records without "spoke" in the package name
    var nonSpoke = candidates.find((c: any) => !str(c.sys_package).toLowerCase().includes("spoke"))
    if (nonSpoke) return nonSpoke
    return candidates[0]
  }

  // Helper: check if a search term is a relevant match for an action definition.
  // Rejects matches where the term only appears INSIDE another word (e.g. "script" in "description").
  // Accepts matches where the term appears as a standalone word or at word boundaries.
  const isRelevantMatch = (record: any, term: string): boolean => {
    var termLC = term.toLowerCase().replace(/[_\s]+/g, "[_\\s]*")
    var wordBoundaryRe = new RegExp("(?:^|[_\\s])" + termLC + "(?:$|[_\\s])", "i")
    var internalName = str(record.internal_name).toLowerCase()
    var name = str(record.name).toLowerCase()
    // Accept if internal_name or name contains the term at a word boundary
    if (wordBoundaryRe.test(internalName) || wordBoundaryRe.test(name)) return true
    // Accept if internal_name starts with or equals the term
    if (internalName === term.toLowerCase() || internalName.startsWith(term.toLowerCase() + "_")) return true
    // Accept if name starts with or equals the term (case-insensitive)
    var termLCPlain = term.toLowerCase()
    if (name === termLCPlain || name.startsWith(termLCPlain + " ") || name.startsWith(termLCPlain + "_")) return true
    return false
  }

  // Helper: search a table for action definitions by exact match and LIKE
  const searchTable = async (tableName: string, searchTerms: string[]): Promise<void> => {
    for (var si = 0; si < searchTerms.length && !actionDefId; si++) {
      var term = searchTerms[si]
      // Exact match on internal_name and name
      for (const field of ["internal_name", "name"]) {
        if (actionDefId) break
        try {
          const resp = await client.get("/api/now/table/" + tableName, {
            params: { sysparm_query: field + "=" + term, sysparm_fields: snapshotFields, sysparm_limit: 10 },
          })
          const results = resp.data.result || []
          if (results.length > 1) {
            steps.def_lookup_candidates = results.map((r: any) => ({
              sys_id: r.sys_id,
              internal_name: str(r.internal_name),
              name: str(r.name),
              scope: str(r.sys_scope),
              package: str(r.sys_package),
            }))
          }
          const found = pickBest(results)
          if (found?.sys_id) {
            actionDefId = found.sys_id
            steps.def_lookup = {
              id: found.sys_id,
              internal_name: str(found.internal_name),
              name: str(found.name),
              scope: str(found.sys_scope),
              package: str(found.sys_package),
              matched: tableName + ":" + field + "=" + term,
            }
          }
        } catch (_) {}
      }
      // LIKE search — filter out irrelevant matches where the term is part of another word
      if (!actionDefId) {
        try {
          const resp = await client.get("/api/now/table/" + tableName, {
            params: {
              sysparm_query: "internal_nameLIKE" + term + "^ORnameLIKE" + term,
              sysparm_fields: snapshotFields,
              sysparm_limit: 10,
            },
          })
          const rawResults = resp.data.result || []
          // Filter: only keep results where the term appears as a real word, not inside another word
          const results = rawResults.filter(function (r: any) {
            return isRelevantMatch(r, term)
          })
          if (rawResults.length > 0 && !steps.def_lookup_fallback_candidates) {
            steps.def_lookup_fallback_candidates = rawResults.map((r: any) => ({
              sys_id: r.sys_id,
              internal_name: str(r.internal_name),
              name: str(r.name),
              scope: str(r.sys_scope),
              package: str(r.sys_package),
              relevant: isRelevantMatch(r, term),
            }))
          }
          const found = pickBest(results)
          if (found?.sys_id) {
            actionDefId = found.sys_id
            steps.def_lookup = {
              id: found.sys_id,
              internal_name: str(found.internal_name),
              name: str(found.name),
              scope: str(found.sys_scope),
              package: str(found.sys_package),
              matched: tableName + ":LIKE " + term,
            }
          }
        } catch (_) {}
      }
    }
  }

  // Build search terms: original actionType + any alias variations
  var searchTerms = [actionType]
  var aliases = ACTION_TYPE_ALIASES[actionType.toLowerCase()]
  if (aliases) searchTerms = searchTerms.concat(aliases)

  // Search 1: sys_hub_action_type_snapshot (published action snapshots)
  await searchTable("sys_hub_action_type_snapshot", searchTerms)

  // Search 2: sys_hub_action_type_definition (action definitions — includes built-in/native actions)
  if (!actionDefId) {
    steps.snapshot_not_found = true
    await searchTable("sys_hub_action_type_definition", searchTerms)
  }

  if (!actionDefId) {
    var notFoundMsg =
      "Action definition not found for: " +
      actionType +
      " (searched snapshot + definition tables with terms: " +
      searchTerms.join(", ") +
      ")"
    if (steps.def_lookup_fallback_candidates) {
      var rejected = steps.def_lookup_fallback_candidates.filter(function (c: any) {
        return !c.relevant
      })
      if (rejected.length > 0) {
        notFoundMsg +=
          ". LIKE search found " +
          rejected.length +
          ' result(s) but they were rejected as irrelevant (term "' +
          actionType +
          '" only matched inside other words). Rejected: ' +
          rejected
            .map(function (c: any) {
              return c.name + " (" + c.internal_name + ")"
            })
            .join(", ") +
          ". Use the exact internal_name or name of the action you want."
      }
    }
    return { success: false, error: notFoundMsg, steps }
  }

  // Build full input objects with parameter definitions (matching UI format)
  const inputResult = await buildActionInputsForInsert(client, actionDefId, inputs)
  steps.available_inputs = inputResult.actionParams.map((p: any) => ({ element: p.element, label: p.label }))
  steps.resolved_inputs = inputResult.resolvedInputs

  // Validate mandatory fields
  if (inputResult.missingMandatory && inputResult.missingMandatory.length > 0) {
    steps.missing_mandatory = inputResult.missingMandatory
    return {
      success: false,
      error:
        "Missing required inputs for " +
        actionType +
        ": " +
        inputResult.missingMandatory.join(", ") +
        ". These fields are mandatory in Flow Designer.",
      steps,
    }
  }

  // Validate table inputs (e.g. task_table must be a child of 'task', not the base table itself)
  if (inputResult.invalidTable) {
    steps.invalid_table = inputResult.invalidTable
    return {
      success: false,
      error: inputResult.invalidTable.message,
      steps,
      valid_table_options: inputResult.invalidTable.validOptions,
    }
  }

  // Calculate insertion order (with TRY/CATCH-aware nesting)
  var resolvedOrder = await calculateInsertOrder(client, flowId, parentUiId, order)
  var nestedReorder: { actions: any[]; flowLogics: any[]; subflows: any[] } | null = null
  var nestedCatchUuid: string | undefined
  if (parentUiId) {
    const nested = await computeNestedOrder(client, flowId, parentUiId, order, steps)
    if (nested) {
      resolvedOrder = nested.order
      nestedReorder = nested.reorder
      nestedCatchUuid = nested.catchUuid
    }
  }
  steps.insert_order = resolvedOrder

  const uuid = generateUUID()

  // ── Data pill transformation for record actions (Update/Create Record) ──
  // These actions need: record → data pill, table_name → displayValue, field values → packed into values string
  var recordActionResult = await transformActionInputsForRecordAction(
    client,
    flowId,
    inputResult.inputs,
    inputResult.resolvedInputs,
    inputResult.actionParams,
    uuid,
  )
  steps.record_action = recordActionResult.steps

  // Validate table_name exists (for record actions like Update Record, Create Record)
  if (recordActionResult.tableError) {
    steps.table_error = recordActionResult.tableError
    return { success: false, error: recordActionResult.tableError, steps }
  }

  var hasRecordPills = recordActionResult.labelCacheUpdates.length + recordActionResult.labelCacheInserts.length > 0

  // ── Rewrite shorthand pills in generic action inputs (e.g. Log "message") ────
  // Non-record inputs (anything other than record/table_name/values) that contain
  // {{trigger.current.X}} need rewriting to {{Created or Updated_1.current.X}} + labelCache.
  // Also handle inputs that already have full pill references (e.g. {{Created or Updated_1.current.caller_id}})
  // — these still need labelCache entries or they render as empty grey pills.
  var RECORD_INPUTS = ["record", "table_name", "values"]
  var genericPillInputs: { name: string; fields: string[]; isRecordLevel: boolean }[] = []
  var actionTriggerInfo: any = null

  for (var gpi = 0; gpi < recordActionResult.inputs.length; gpi++) {
    var gpInput = recordActionResult.inputs[gpi]
    if (RECORD_INPUTS.includes(gpInput.name)) continue
    var gpVal = validateAndFixPills(gpInput.value?.value || "")
    if (!gpVal.includes("{{")) continue

    var gpHasShorthand = hasShorthandPills(gpVal)

    // If it has shorthand pills, we need trigger info to rewrite them.
    // If it has ANY pill references (even non-shorthand), we still need trigger info for labelCache.
    if (gpHasShorthand || gpVal.includes("{{")) {
      // Get trigger info if not already fetched
      if (!actionTriggerInfo) {
        actionTriggerInfo = await getFlowTriggerInfo(client, flowId)
        steps.action_trigger_info = {
          dataPillBase: actionTriggerInfo.dataPillBase,
          triggerName: actionTriggerInfo.triggerName,
          table: actionTriggerInfo.table,
          tableLabel: actionTriggerInfo.tableLabel,
        }
      }
      if (!actionTriggerInfo.dataPillBase) continue
    }

    var gpPillBase = actionTriggerInfo.dataPillBase
    var gpOrigVal = gpVal

    // Rewrite shorthand pills to full dataPillBase
    if (gpHasShorthand) {
      gpVal = rewriteShorthandPills(gpVal, gpPillBase)
      gpInput.value.value = gpVal
    }

    // Extract field names from ALL pills in the value for labelCache
    var gpPillFields: string[] = []
    var gpIsRecordLevel = false
    var gpPillRx = /\{\{([^}]+)\}\}/g
    var gpm: RegExpExecArray | null
    while ((gpm = gpPillRx.exec(gpVal)) !== null) {
      var gpParts = gpm[1].split(".")
      if (gpParts.length > 2) {
        gpPillFields.push(gpParts.slice(2).join("."))
      } else {
        gpIsRecordLevel = true
      }
    }

    if (gpPillFields.length > 0 || gpIsRecordLevel) {
      genericPillInputs.push({ name: gpInput.name, fields: gpPillFields, isRecordLevel: gpIsRecordLevel })
      if (gpOrigVal !== gpVal) {
        steps["pill_rewrite_" + gpInput.name] = { original: gpOrigVal, rewritten: gpVal }
      } else {
        steps["pill_labelcache_" + gpInput.name] = { fields: gpPillFields, isRecordLevel: gpIsRecordLevel }
      }
    }
  }

  // For record actions: clear data pill values from INSERT — they'll be set via separate UPDATE
  // (Flow Designer's GraphQL API ignores labelCache during INSERT, it only works with UPDATE)
  var insertInputs = recordActionResult.inputs
  if (hasRecordPills) {
    // Clone inputs and clear data pill values for INSERT
    insertInputs = recordActionResult.inputs.map(function (inp: any) {
      if (inp.name === "record" && inp.value?.value?.startsWith("{{")) {
        return { ...inp, value: { schemaless: false, schemalessValue: "", value: "" } }
      }
      if (inp.name === "values" && inp.value?.value?.includes("{{")) {
        return { ...inp, value: { schemaless: false, schemalessValue: "", value: "" } }
      }
      return inp
    })
    steps.record_action_strategy = "two_step"
  }

  const actionResponseFields =
    "actions { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }" +
    " flowLogics { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }" +
    " subflows { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }"

  const flowPatch: any = {
    flowId: flowId,
    actions: {
      insert: [
        {
          actionTypeSysId: actionDefId,
          metadata: '{"predicates":[]}',
          flowSysId: flowId,
          generationSource: "",
          order: String(resolvedOrder),
          parent: parentUiId || "",
          uiUniqueIdentifier: uuid,
          type: "action",
          parentUiId: parentUiId || "",
          inputs: insertInputs,
          comment: annotation || "",
          ...(displayText ? { displayText: displayText } : {}),
          ...(nestedCatchUuid ? { connectedTo: nestedCatchUuid } : {}),
        },
      ],
    },
  }

  if (nestedReorder) {
    if (nestedReorder.actions.length > 0) flowPatch.actions.update = nestedReorder.actions
    const logicUpdates = parentUiId ? [{ uiUniqueIdentifier: parentUiId, type: "flowlogic" }] : []
    for (const u of nestedReorder.flowLogics) logicUpdates.push(u)
    if (logicUpdates.length > 0) flowPatch.flowLogics = { update: logicUpdates }
    if (nestedReorder.subflows.length > 0) flowPatch.subflows = { update: nestedReorder.subflows }
  } else if (parentUiId) {
    flowPatch.flowLogics = { update: [{ uiUniqueIdentifier: parentUiId, type: "flowlogic" }] }
  }

  try {
    // Step 1: INSERT the action element
    const result = await executeFlowPatchMutation(client, flowPatch, actionResponseFields)
    const actionId = result?.actions?.inserts?.[0]?.sysId
    steps.insert = { success: !!actionId, actionId, uuid }
    if (!actionId) return { success: false, steps, error: "GraphQL action INSERT returned no ID" }

    // Step 2: UPDATE with data pill values + labelCache (separate mutation, matching UI behavior)
    // The Flow Designer UI uses labelCache UPDATE for existing pills (record-level)
    // and labelCache INSERT for new pills (field-level in values).
    if (hasRecordPills) {
      var updateInputs: any[] = []
      // Collect inputs for the UPDATE mutation
      for (var ri = 0; ri < recordActionResult.inputs.length; ri++) {
        var inp = recordActionResult.inputs[ri]
        var val = inp.value?.value || ""
        if (inp.name === "record" && val.startsWith("{{")) {
          // UI only sends `value` for the record pill (no displayValue)
          updateInputs.push({
            name: "record",
            value: { schemaless: false, schemalessValue: "", value: val },
          })
        } else if (inp.name === "table_name") {
          // displayValue must use full schemaless format: {schemaless, schemalessValue, value}
          updateInputs.push({
            name: "table_name",
            displayValue: inp.displayValue || { schemaless: false, schemalessValue: "", value: "" },
            value: inp.value || { schemaless: false, schemalessValue: "", value: "" },
          })
        } else if (inp.name === "values") {
          // UI sends {name: "values"} without value property when empty, with value when set
          if (val) {
            updateInputs.push({ name: "values", value: { schemaless: false, schemalessValue: "", value: val } })
          } else {
            updateInputs.push({ name: "values" })
          }
        }
      }

      if (updateInputs.length > 0) {
        try {
          var updatePatch: any = {
            flowId: flowId,
            labelCache: {} as any,
            actions: {
              update: [
                {
                  uiUniqueIdentifier: uuid,
                  type: "action",
                  inputs: updateInputs,
                },
              ],
            },
          }
          // Split pills into INSERT (new) vs UPDATE (already in flow's labelCache)
          if (recordActionResult.labelCacheInserts.length > 0) {
            var existingPills = await getExistingLabelCachePills(client, flowId)
            var splitResult = splitLabelCacheEntries(recordActionResult.labelCacheInserts, existingPills)
            if (splitResult.inserts.length > 0) updatePatch.labelCache.insert = splitResult.inserts
            if (splitResult.updates.length > 0) updatePatch.labelCache.update = splitResult.updates
            steps.label_cache_split = { inserts: splitResult.inserts.length, updates: splitResult.updates.length }
          }
          // Log the exact GraphQL mutation for debugging
          steps.record_update_mutation = jsToGraphQL(updatePatch)
          var actionUpdateResult = await executeFlowPatchMutation(client, updatePatch, actionResponseFields)
          steps.record_update = { success: true, inputCount: updateInputs.length, response: actionUpdateResult }
        } catch (ue: any) {
          steps.record_update = { success: false, error: ue.message }
          // Rollback: delete the just-inserted action to avoid a broken element
          try {
            await executeFlowPatchMutation(
              client,
              { flowId: flowId, actions: { delete: [uuid] } },
              "actions { deletes __typename }",
            )
            steps.action_rollback = { success: true, deleted: uuid }
          } catch (rollbackErr: any) {
            steps.action_rollback = { success: false, error: rollbackErr.message }
          }
          return { success: false, steps, error: "Action created but UPDATE failed (rolled back): " + ue.message }
        }
      }
    }

    // Step 3: UPDATE labelCache for generic action inputs with data pills (e.g. Log "message")
    if (genericPillInputs.length > 0 && actionTriggerInfo?.dataPillBase) {
      try {
        var gpLabelInserts: any[] = []
        var gpBase = actionTriggerInfo.dataPillBase
        var gpTrigName = actionTriggerInfo.triggerName
        var gpTable = actionTriggerInfo.tableRef || actionTriggerInfo.table
        var gpTableLabel = actionTriggerInfo.tableLabel

        for (var gli = 0; gli < genericPillInputs.length; gli++) {
          var gpi2 = genericPillInputs[gli]

          // Field-level pills: build labelCache with metadata from sys_dictionary
          if (gpi2.fields.length > 0) {
            var gpFieldEntries = await buildConditionLabelCache(
              client,
              "",
              gpBase,
              gpTrigName,
              gpTable,
              gpTableLabel,
              uuid,
              gpi2.fields,
              gpi2.name,
            )
            gpLabelInserts = gpLabelInserts.concat(gpFieldEntries)
          }

          // Record-level pill
          if (gpi2.isRecordLevel) {
            gpLabelInserts.push(
              buildLabelCacheEntry({
                name: gpBase,
                label: "Trigger - Record " + gpTrigName + "\u279b" + gpTableLabel + " Record\u279b" + gpTableLabel,
                reference: gpTable,
                reference_display: gpTableLabel,
                type: "reference",
                base_type: "reference",
                parent_table_name: gpTable,
                column_name: "",
                usedInstances: [{ uiUniqueIdentifier: uuid, inputName: gpi2.name }],
              }),
            )
          }
        }

        // Deduplicate: same pill used in multiple inputs (e.g. number in both subject and body)
        gpLabelInserts = deduplicateLabelCache(gpLabelInserts)

        if (gpLabelInserts.length > 0) {
          var gpExisting = await getExistingLabelCachePills(client, flowId)
          var gpSplit = splitLabelCacheEntries(gpLabelInserts, gpExisting)
          var gpUpdatePatch: any = {
            flowId: flowId,
            actions: {
              update: [
                {
                  uiUniqueIdentifier: uuid,
                  type: "action",
                },
              ],
            },
            labelCache: {} as any,
          }
          if (gpSplit.inserts.length > 0) gpUpdatePatch.labelCache.insert = gpSplit.inserts
          if (gpSplit.updates.length > 0) gpUpdatePatch.labelCache.update = gpSplit.updates
          steps.generic_pill_label_cache_mutation = jsToGraphQL(gpUpdatePatch)
          await executeFlowPatchMutation(client, gpUpdatePatch, actionResponseFields)
          steps.generic_pill_label_cache_update = {
            success: true,
            inserts: gpSplit.inserts.length,
            updates: gpSplit.updates.length,
          }
        }
      } catch (gpe: any) {
        steps.generic_pill_label_cache_update = { success: false, error: gpe.message }
      }
    }

    return { success: true, actionId: actionId || undefined, uiUniqueIdentifier: uuid, resolvedOrder, steps }
  } catch (e: any) {
    steps.insert = { success: false, error: e.message }
    return { success: false, steps, error: "GraphQL action INSERT failed: " + e.message }
  }
}

// ── DATA PILL CONDITION HELPERS ────────────────────────────────────────

/**
 * Get trigger info from a flow for constructing data pill references.
 * Reads the flow version payload to find the trigger name, table, and outputs.
 *
 * Returns the data pill base (e.g., "Created or Updated_1") and table (e.g., "incident").
 * The data pill base is used as: {{dataPillBase.fieldName}} in condition values.
 */
async function getFlowTriggerInfo(
  client: any,
  flowId: string,
): Promise<{
  dataPillBase: string
  triggerName: string
  table: string
  tableLabel: string
  tableRef: string
  error?: string
  debug?: any
}> {
  var triggerName = ""
  var table = ""
  var tableLabel = ""
  var debug: any = {}

  // PRIMARY: Read flow via ProcessFlow REST API (same endpoint as Flow Designer UI)
  // This API returns XML (not JSON). We parse trigger info from the XML string.
  try {
    debug.processflow_api = "attempting"
    // Note: do NOT pass custom headers in config — some Axios interceptors freeze the config
    // object, causing "Attempted to assign to readonly property" errors.
    var pfResp = await client.get("/api/now/processflow/flow/" + flowId)
    var pfRaw = pfResp.data
    debug.processflow_api = "success"
    debug.processflow_type = typeof pfRaw

    if (typeof pfRaw === "string" && pfRaw.indexOf("<triggerInstances>") >= 0) {
      // Response is XML — parse trigger info with regex
      debug.processflow_format = "xml"

      // Extract the triggerInstances block
      var trigBlockMatch = pfRaw.match(/<triggerInstances>([\s\S]*?)<\/triggerInstances>/)
      if (trigBlockMatch) {
        var trigBlock = trigBlockMatch[1]

        // Trigger name: <name>X</name> that appears near <triggerType> at end of block
        // Structure: ...<name>Created or Updated</name><comment/>...<triggerType>Record</triggerType>
        var trigNameMatch = trigBlock.match(/<name>([^<]+)<\/name>[\s\S]{0,300}<triggerType>/)
        if (trigNameMatch) {
          triggerName = trigNameMatch[1]
          debug.processflow_trigger_name = triggerName
        }

        // Table: find <name>table</name> ... <value>X</value> inside trigger inputs
        var tableMatch = trigBlock.match(/<name>table<\/name>[\s\S]*?<value>([^<]+)<\/value>/)
        if (tableMatch) {
          table = tableMatch[1]
          debug.processflow_table = table
        }
      }
    } else if (pfRaw && typeof pfRaw === "object") {
      // Response is JSON — traverse object structure
      debug.processflow_format = "json"
      var pfData = pfRaw.result || pfRaw
      debug.processflow_keys = pfData && typeof pfData === "object" ? Object.keys(pfData).slice(0, 20) : null

      // ProcessFlow API wraps actual flow data inside a "data" property
      // e.g. {data: {triggerInstances: [...]}, errorMessage, errorCode, integrationsPluginActive}
      if (pfData.data && typeof pfData.data === "object" && !pfData.triggerInstances) {
        pfData = pfData.data
        debug.processflow_unwrapped = true
        debug.processflow_data_keys = typeof pfData === "object" ? Object.keys(pfData).slice(0, 20) : null
      }

      var pfTriggers = pfData?.triggerInstances || pfData?.trigger_instances || pfData?.triggers || []
      if (!Array.isArray(pfTriggers) && pfData?.model?.triggerInstances) {
        pfTriggers = pfData.model.triggerInstances
      }
      if (!Array.isArray(pfTriggers) && pfData?.definition?.triggerInstances) {
        pfTriggers = pfData.definition.triggerInstances
      }

      if (Array.isArray(pfTriggers) && pfTriggers.length > 0) {
        var pfTrig = pfTriggers[0]
        triggerName = pfTrig.name || pfTrig.triggerName || ""
        if (pfTrig.inputs && Array.isArray(pfTrig.inputs)) {
          for (var pfi = 0; pfi < pfTrig.inputs.length; pfi++) {
            if (pfTrig.inputs[pfi].name === "table") {
              table = pfTrig.inputs[pfi].value?.value || str(pfTrig.inputs[pfi].value) || ""
              break
            }
          }
        }
      }
    }
  } catch (pfErr: any) {
    debug.processflow_api = "error: " + pfErr.message
  }

  // Fallback 1: Read version payload (legacy approach)
  if (!triggerName || !table) {
    debug.version_fallback = "attempting"
    try {
      var resp = await client.get("/api/now/table/sys_hub_flow_version", {
        params: {
          sysparm_query: "flow=" + flowId + "^ORDERBYDESCsys_created_on",
          sysparm_fields: "sys_id,payload",
          sysparm_limit: 1,
        },
      })
      var payload = resp.data.result?.[0]?.payload
      if (payload) {
        var parsed = typeof payload === "string" ? JSON.parse(payload) : payload
        debug.version_payload_keys = Object.keys(parsed)
        var trigInst = parsed.triggerInstances || parsed.trigger_instances || []
        debug.version_trigger_count = Array.isArray(trigInst) ? trigInst.length : typeof trigInst
        if (Array.isArray(trigInst) && trigInst.length > 0) {
          var t0 = trigInst[0]
          debug.version_trigger_keys = Object.keys(t0)
          debug.version_trigger_name_field = t0.name || t0.triggerName || t0.triggerDefinitionName || ""
          if (!triggerName) triggerName = t0.name || t0.triggerName || t0.triggerDefinitionName || ""
          // Also try getting the trigger definition name (e.g. "Created or Updated")
          if (!triggerName && t0.triggerDefinition) {
            triggerName = t0.triggerDefinition.name || ""
          }
          if (!table && t0.inputs) {
            var t0Inputs = Array.isArray(t0.inputs) ? t0.inputs : []
            for (var vi = 0; vi < t0Inputs.length; vi++) {
              if (t0Inputs[vi].name === "table") {
                table = t0Inputs[vi].value?.value || str(t0Inputs[vi].value) || ""
                debug.version_table_input = t0Inputs[vi]
                break
              }
            }
          }
          // Fallback: try reading table directly from trigger object
          if (!table && t0.table) table = str(t0.table)
        }
      }
    } catch (_) {}
  }

  // Fallback 2: query sys_hub_flow for table + trigger definition for name
  if (!triggerName || !table) {
    debug.flow_record_fallback = "attempting"
    try {
      var flowResp = await client.get("/api/now/table/sys_hub_flow", {
        params: {
          sysparm_query: "sys_id=" + flowId,
          sysparm_fields: "sys_id,name,table,trigger_type",
          sysparm_limit: 1,
        },
      })
      var flowRec = flowResp.data.result?.[0]
      debug.flow_record = { table: str(flowRec?.table), trigger_type: str(flowRec?.trigger_type) }
      if (!table && flowRec?.table) table = str(flowRec.table)
      var trigTypeId = str(flowRec?.trigger_type)
      if (!triggerName && trigTypeId) {
        try {
          var trigDefResp = await client.get("/api/now/table/sys_hub_trigger_definition", {
            params: { sysparm_query: "sys_id=" + trigTypeId, sysparm_fields: "name,type", sysparm_limit: 1 },
          })
          var trigDef = trigDefResp.data.result?.[0]
          if (trigDef?.name) triggerName = str(trigDef.name)
          debug.trigger_def = { name: str(trigDef?.name), type: str(trigDef?.type) }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // Look up table label for display in label cache
  if (table && !tableLabel) {
    try {
      var labelResp = await client.get("/api/now/table/sys_db_object", {
        params: {
          sysparm_query: "name=" + table,
          sysparm_fields: "label",
          sysparm_display_value: "true",
          sysparm_limit: 1,
        },
      })
      tableLabel = str(labelResp.data.result?.[0]?.label) || ""
    } catch (_) {}
    if (!tableLabel) {
      tableLabel = table.charAt(0).toUpperCase() + table.slice(1).replace(/_/g, " ")
    }
  }

  if (!triggerName) {
    return {
      dataPillBase: "",
      triggerName: "",
      table: table,
      tableLabel: tableLabel,
      tableRef: table,
      error: "Could not determine trigger name from flow version payload or GraphQL",
      debug,
    }
  }

  var dataPillBase = triggerName + "_1.current"
  return { dataPillBase, triggerName, table, tableLabel, tableRef: table, debug }
}

/**
 * Parse a ServiceNow encoded query into individual condition clauses.
 * Each clause has: prefix (^ or ^OR), field, operator, value.
 *
 * Example: "category=inquiry^priority!=1^ORshort_descriptionLIKEtest"
 * → [
 *     { prefix: '', field: 'category', operator: '=', value: 'inquiry' },
 *     { prefix: '^', field: 'priority', operator: '!=', value: '1' },
 *     { prefix: '^OR', field: 'short_description', operator: 'LIKE', value: 'test' }
 *   ]
 */
function parseEncodedQuery(query: string): { prefix: string; field: string; operator: string; value: string }[] {
  if (!query || query === "^EQ") return []

  // Remove trailing ^EQ
  var q = query.replace(/\^EQ$/, "")
  if (!q) return []

  // Split on ^OR and ^ while keeping the separators
  var clauses: { prefix: string; raw: string }[] = []
  var parts = q.split(/(\^OR|\^NQ|\^)/)
  var currentPrefix = ""

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i]
    if (part === "^" || part === "^OR" || part === "^NQ") {
      currentPrefix = part
    } else if (part.length > 0) {
      clauses.push({ prefix: currentPrefix, raw: part })
      currentPrefix = ""
    }
  }

  // Operators sorted by length descending to match longest first
  var operators = [
    "VALCHANGES",
    "CHANGESFROM",
    "CHANGESTO",
    "ISNOTEMPTY",
    "ISEMPTY",
    "EMPTYSTRING",
    "ANYTHING",
    "NOT LIKE",
    "NOT IN",
    "NSAMEAS",
    "STARTSWITH",
    "ENDSWITH",
    "BETWEEN",
    "INSTANCEOF",
    "DYNAMIC",
    "SAMEAS",
    "LIKE",
    "IN",
    "!=",
    ">=",
    "<=",
    ">",
    "<",
    "=",
  ]

  var result: { prefix: string; field: string; operator: string; value: string }[] = []
  for (var j = 0; j < clauses.length; j++) {
    var clause = clauses[j]
    var raw = clause.raw
    var matched = false

    for (var k = 0; k < operators.length; k++) {
      var op = operators[k]
      var opIdx = raw.indexOf(op)
      if (opIdx > 0) {
        result.push({
          prefix: clause.prefix,
          field: raw.substring(0, opIdx),
          operator: op,
          value: raw.substring(opIdx + op.length),
        })
        matched = true
        break
      }
    }
    if (!matched) {
      // Unrecognized format — keep as-is
      result.push({ prefix: clause.prefix, field: raw, operator: "", value: "" })
    }
  }

  return result
}

/**
 * Check if a condition value looks like a standard ServiceNow encoded query.
 * Standard encoded queries use: field_name=value^field_name2!=value2
 *
 * Returns false for JavaScript expressions, scripts, fd_data references, etc.
 * which should be passed through as-is without data pill transformation.
 */
function isStandardEncodedQuery(condition: string): boolean {
  if (!condition) return false
  // Parentheses indicate function calls or grouping expressions
  if (/[()]/.test(condition)) return false
  // Method calls like .toString(, .replace(, .match(
  if (/\.\w+\(/.test(condition)) return false
  // Regex patterns like /[
  if (/\/\[/.test(condition)) return false
  // JS equality operators == or ===
  if (/===?/.test(condition)) return false
  // JS modulo, logical AND/OR
  if (/%/.test(condition)) return false
  if (/&&|\|\|/.test(condition)) return false
  // Flow Designer internal variable references
  if (condition.startsWith("fd_data.")) return false
  // Already contains data pill references (already transformed)
  if (condition.includes("{{")) return false
  // Final check: try to parse as encoded query — if it produces valid clauses, it's a standard query
  var clauses = parseEncodedQuery(condition)
  if (clauses.length === 0 && condition.length > 0) return false
  return true
}

/**
 * Transform an encoded query condition into Flow Designer data pill format.
 *
 * Uses FIELD-LEVEL data pills — each field reference in the encoded query gets
 * wrapped with the data pill base:
 *   "category=software" → "{{Created or Updated_1.current.category}}=software"
 *   "category=software^priority=1" → "{{Created or Updated_1.current.category}}=software^{{Created or Updated_1.current.priority}}=1"
 *
 * The field-level pill tells Flow Designer exactly which field the condition applies to.
 */
function transformConditionToDataPills(conditionValue: string, dataPillBase: string): string {
  if (!conditionValue || !dataPillBase) return conditionValue

  var clauses = parseEncodedQuery(conditionValue)
  if (clauses.length === 0) return conditionValue

  var result = ""
  for (var i = 0; i < clauses.length; i++) {
    var clause = clauses[i]
    result += clause.prefix
    result += "{{" + dataPillBase + "." + clause.field + "}}"
    result += clause.operator
    result += clause.value
  }

  return result
}

/**
 * Walk a table's class hierarchy (table → super_class → …) so fields inherited
 * from a parent table resolve. e.g. incident.priority is defined on `task`, so a
 * sys_dictionary query restricted to `name=incident` misses it entirely and the
 * field falls back to type "string" — which renders the condition value as a
 * plain text box instead of the field's real (choice/reference) widget.
 */
async function getTableHierarchy(client: any, table: string): Promise<string[]> {
  var chain: string[] = []
  var name = table
  for (var i = 0; i < 12 && name && chain.indexOf(name) < 0; i++) {
    chain.push(name)
    try {
      var resp = await client.get("/api/now/table/sys_db_object", {
        params: { sysparm_query: "name=" + name, sysparm_fields: "super_class.name", sysparm_limit: 1 },
      })
      name = str(resp.data.result?.[0]?.["super_class.name"]) || ""
    } catch (_) {
      break
    }
  }
  return chain
}

/**
 * Map a sys_dictionary row to the Flow Designer labelCache pill type. A field
 * with a choice list (choice 1/2/3) renders as "choice" in the condition builder
 * even when its internal_type is integer/string (e.g. task.priority is an integer
 * with choices) — matching what the UI persists.
 */
function dictPillType(internalType: string, choice: string): string {
  return choice && choice !== "0" && choice !== "false" ? "choice" : internalType || "string"
}

/**
 * Build labelCache INSERT entries for field-level data pills used in flow logic conditions.
 *
 * Returns an array of labelCache INSERT entries with full metadata, matching the UI's exact
 * mutation format (captured from Flow Designer network tab when editing a programmatic flow):
 *
 *   labelCache: { insert: [{
 *     name: "Created or Updated_1.current.category",
 *     label: "Trigger - Record Created or Updated➛Incident Record➛Category",
 *     reference: "", reference_display: "Category",
 *     type: "choice", base_type: "choice",
 *     parent_table_name: "incident", column_name: "category",
 *     usedInstances: [{uiUniqueIdentifier: "...", inputName: "condition"}],
 *     choices: {}
 *   }] }
 */
async function buildConditionLabelCache(
  client: any,
  conditionValue: string,
  dataPillBase: string,
  triggerName: string,
  table: string,
  tableLabel: string,
  logicUiId: string,
  explicitFields?: string[],
  inputName?: string,
): Promise<any[]> {
  if (!dataPillBase) return []

  // Collect unique field names — either from explicit list or by parsing encoded query
  if (!explicitFields) {
    var clauses = parseEncodedQuery(conditionValue)
    if (clauses.length === 0) return []
    explicitFields = clauses
      .map(function (c) {
        return c.field
      })
      .filter(function (f) {
        return !!f
      })
  }
  if (explicitFields.length === 0) return []

  // De-duplicate field names
  var uniqueFields: string[] = []
  var seen: Record<string, boolean> = {}
  for (var i = 0; i < explicitFields.length; i++) {
    var field = explicitFields[i]
    if (field && !seen[field]) {
      seen[field] = true
      uniqueFields.push(field)
    }
  }
  if (uniqueFields.length === 0) return []

  // Split fields into simple fields and dot-walk fields
  var simpleFields: string[] = []
  var dotWalkFields: string[] = []
  for (var si = 0; si < uniqueFields.length; si++) {
    if (uniqueFields[si].includes(".")) {
      dotWalkFields.push(uniqueFields[si])
    } else {
      simpleFields.push(uniqueFields[si])
    }
  }

  // Batch-query sys_dictionary for simple field metadata (type, label, reference).
  // Query across the table's class hierarchy so inherited fields (e.g. priority/
  // state on the `task` parent of incident) resolve instead of falling back to
  // "string"; pick the most-derived definition when a field is overridden.
  var fieldMeta: Record<string, { type: string; label: string; reference: string }> = {}
  if (simpleFields.length > 0) {
    try {
      var hierarchy = await getTableHierarchy(client, table)
      var dictResp = await client.get("/api/now/table/sys_dictionary", {
        params: {
          sysparm_query: "elementIN" + simpleFields.join(",") + "^nameIN" + hierarchy.join(","),
          sysparm_fields: "name,element,column_label,internal_type,reference,choice",
          sysparm_display_value: "false",
          sysparm_limit: simpleFields.length * hierarchy.length + 5,
        },
      })
      var dictResults = dictResp.data.result || []
      var bestRank: Record<string, number> = {}
      for (var d = 0; d < dictResults.length; d++) {
        var rec = dictResults[d]
        var elName = str(rec.element)
        if (!elName) continue
        // Prefer the most-derived table's definition (lowest hierarchy index).
        var rank = hierarchy.indexOf(str(rec.name))
        if (rank < 0) rank = 999
        if (elName in bestRank && bestRank[elName] <= rank) continue
        bestRank[elName] = rank
        var intType = str(rec.internal_type?.value || rec.internal_type || "string")
        var choiceVal = str(rec.choice?.value || rec.choice || "0")
        var refTable = str(rec.reference?.value || rec.reference || "")
        fieldMeta[elName] = { type: dictPillType(intType, choiceVal), label: str(rec.column_label), reference: refTable }
      }
    } catch (_) {
      // Fallback: use "string" type and generated labels if dictionary lookup fails
    }
  }

  // Build labelCache INSERT entries with full metadata for each field-level pill.
  // This matches the UI's mutation format when editing a programmatically-created flow.
  var inserts: any[] = []

  // Simple fields — use batch query results
  for (var j = 0; j < simpleFields.length; j++) {
    var f = simpleFields[j]
    var pillName = dataPillBase + "." + f
    var meta = fieldMeta[f] || {
      type: "string",
      label: f.replace(/_/g, " ").replace(/\b\w/g, function (c: string) {
        return c.toUpperCase()
      }),
      reference: "",
    }

    inserts.push(
      buildLabelCacheEntry({
        name: pillName,
        label: "Trigger - Record " + triggerName + "\u279b" + tableLabel + " Record\u279b" + meta.label,
        reference: meta.reference,
        reference_display: meta.label,
        type: meta.type,
        base_type: meta.type,
        parent_table_name: table,
        column_name: f,
        usedInstances: [{ uiUniqueIdentifier: logicUiId, inputName: inputName || "condition" }],
      }),
    )
  }

  // Dot-walk fields — resolve each segment through reference chain
  // e.g. "caller_id.vip" → query caller_id on incident → get ref sys_user → query vip on sys_user
  for (var dw = 0; dw < dotWalkFields.length; dw++) {
    var dwField = dotWalkFields[dw]
    var dwPillName = dataPillBase + "." + dwField
    var segments = dwField.split(".")
    var currentTbl = table
    var labelParts: string[] = []
    var dwMeta = { type: "string", label: "", reference: "" }

    for (var sg = 0; sg < segments.length; sg++) {
      var seg = segments[sg]
      var titleSeg = seg.replace(/_/g, " ").replace(/\b\w/g, function (c: string) {
        return c.toUpperCase()
      })
      try {
        // Query across the current table's class hierarchy so inherited segments resolve.
        var segHierarchy = await getTableHierarchy(client, currentTbl)
        var segResp = await client.get("/api/now/table/sys_dictionary", {
          params: {
            sysparm_query: "element=" + seg + "^nameIN" + segHierarchy.join(","),
            sysparm_fields: "name,element,column_label,internal_type,reference,choice",
            sysparm_display_value: "false",
            sysparm_limit: segHierarchy.length,
          },
        })
        var segRows = segResp.data.result || []
        segRows.sort(function (a: any, b: any) {
          var ra = segHierarchy.indexOf(str(a.name))
          var rb = segHierarchy.indexOf(str(b.name))
          return (ra < 0 ? 999 : ra) - (rb < 0 ? 999 : rb)
        })
        var segRec = segRows[0]
        if (segRec) {
          var segLabel = str(segRec.column_label) || titleSeg
          var segType = dictPillType(
            str(segRec.internal_type?.value || segRec.internal_type || "string"),
            str(segRec.choice?.value || segRec.choice || "0"),
          )
          var segRef = str(segRec.reference?.value || segRec.reference || "")
          labelParts.push(segLabel)
          if (sg === segments.length - 1) {
            dwMeta = { type: segType, label: segLabel, reference: segRef }
          } else if (segRef) {
            currentTbl = segRef
          }
        } else {
          labelParts.push(titleSeg)
        }
      } catch (_) {
        labelParts.push(titleSeg)
      }
    }

    var dwLabel = labelParts.join("\u279b")
    inserts.push(
      buildLabelCacheEntry({
        name: dwPillName,
        label: "Trigger - Record " + triggerName + "\u279b" + tableLabel + " Record\u279b" + dwLabel,
        reference: dwMeta.reference,
        reference_display: dwMeta.label || segments[segments.length - 1],
        type: dwMeta.type,
        base_type: dwMeta.type,
        parent_table_name: currentTbl,
        column_name: segments[segments.length - 1],
        usedInstances: [{ uiUniqueIdentifier: logicUiId, inputName: inputName || "condition" }],
      }),
    )
  }

  return inserts
}

// ── DATA PILL SUPPORT FOR RECORD ACTIONS (Update/Create Record) ──────

/**
 * Post-process action inputs for record-modifying actions (Update Record, Create Record).
 *
 * These actions have 3 key inputs:
 * - `record`: reference to the record → needs data pill format {{TriggerName_1.current}}
 * - `table_name`: target table → needs displayValue (e.g. "Incident")
 * - `values`: packed field=value pairs → e.g. "priority=2^state=3"
 *
 * User-provided field-value pairs that don't match defined action parameters are
 * automatically packed into the `values` string.
 *
 * Returns the transformed inputs and labelCache entries.
 */
async function transformActionInputsForRecordAction(
  client: any,
  flowId: string,
  actionInputs: any[],
  resolvedInputs: Record<string, string>,
  actionParams: any[],
  uuid: string,
): Promise<{ inputs: any[]; labelCacheUpdates: any[]; labelCacheInserts: any[]; steps: any; tableError?: string }> {
  var steps: any = {}

  // Detect if this is a record action: must have both `record` and `table_name` parameters
  var definedParamNames = actionParams.map(function (p: any) {
    return str(p.element)
  })
  var hasRecord = definedParamNames.includes("record")
  var hasTableName = definedParamNames.includes("table_name")
  var hasValues = definedParamNames.includes("values")

  if (!hasRecord || !hasTableName) {
    steps.record_action = false
    return { inputs: actionInputs, labelCacheUpdates: [], labelCacheInserts: [], steps }
  }
  steps.record_action = true

  // Get trigger info for data pill construction
  var triggerInfo = await getFlowTriggerInfo(client, flowId)
  steps.trigger_info = {
    dataPillBase: triggerInfo.dataPillBase,
    triggerName: triggerInfo.triggerName,
    table: triggerInfo.table,
    tableLabel: triggerInfo.tableLabel,
    error: triggerInfo.error,
    debug: triggerInfo.debug,
  }

  var dataPillBase = triggerInfo.dataPillBase // e.g. "Created or Updated_1.current"
  var labelCacheEntries: any[] = []
  var usedInstances: { uiUniqueIdentifier: string; inputName: string }[] = []

  // ── 1. Transform `record` input to data pill ──────────────────────
  var recordInput = actionInputs.find(function (inp: any) {
    return inp.name === "record"
  })
  if (recordInput && dataPillBase) {
    var recordVal = validateAndFixPills(recordInput.value?.value || "")
    var isShorthand = PILL_SHORTHANDS.includes(recordVal.toLowerCase())
    var isAlreadyPill = recordVal.startsWith("{{")

    if (isShorthand || !recordVal) {
      // Auto-fill with trigger's current record data pill
      // UI only sends the pill in `value`; displayValue stays empty
      var pillRef = "{{" + dataPillBase + "}}"
      recordInput.value = { schemaless: false, schemalessValue: "", value: pillRef }
      recordInput.displayValue = { value: "" }
      usedInstances.push({ uiUniqueIdentifier: uuid, inputName: "record" })
      steps.record_transform = { original: recordVal, pill: pillRef }
    } else if (isAlreadyPill) {
      // Check if the pill contains a shorthand that needs rewriting to the full dataPillBase
      var innerVal = recordVal.replace(/^\{\{/, "").replace(/\}\}$/, "").trim()
      var innerLC = innerVal.toLowerCase()
      if (PILL_SHORTHANDS.includes(innerLC)) {
        // Exact record-level shorthand: {{trigger.current}} → {{Updated_1.current}}
        var pillRef2 = "{{" + dataPillBase + "}}"
        recordInput.value = { schemaless: false, schemalessValue: "", value: pillRef2 }
        steps.record_transform = { original: recordVal, pill: pillRef2 }
      } else {
        // Field-level shorthand: {{trigger.current.sys_id}} → rewrite to record-level pill
        // The `record` input expects a record reference, not a field reference
        var fieldShortMatch = PILL_SHORTHANDS.find(function (sh) {
          return innerLC.startsWith(sh + ".")
        })
        if (fieldShortMatch) {
          var pillRef3 = "{{" + dataPillBase + "}}"
          recordInput.value = { schemaless: false, schemalessValue: "", value: pillRef3 }
          steps.record_transform = {
            original: recordVal,
            pill: pillRef3,
            note: "field-level shorthand rewritten to record-level",
          }
        }
      }
      // UI keeps displayValue empty for pill references
      recordInput.displayValue = { value: "" }
      usedInstances.push({ uiUniqueIdentifier: uuid, inputName: "record" })
    }
  }

  // ── 2. Transform `table_name` input with displayValue ─────────────
  var tableNameInput = actionInputs.find(function (inp: any) {
    return inp.name === "table_name"
  })
  if (tableNameInput) {
    var tableVal = tableNameInput.value?.value || ""
    // Also accept `table` as user key (maps to table_name)
    if (!tableVal && resolvedInputs["table"]) {
      tableVal = resolvedInputs["table"]
    }
    // If still empty, use trigger's table
    if (!tableVal && triggerInfo.table) {
      tableVal = triggerInfo.table
    }
    if (tableVal) {
      // Validate that the table exists before proceeding
      var tblExists = await validateTableExists(client, tableVal)
      if (!tblExists.exists) {
        steps.table_validation_error = "Table '" + tableVal + "' does not exist in ServiceNow."
        return {
          inputs: actionInputs,
          labelCacheUpdates: [],
          labelCacheInserts: [],
          steps: steps,
          tableError: "Table '" + tableVal + "' does not exist. Check the table name and try again.",
        }
      }
      // Use the validated label (or fallback to trigger's label if same table)
      var tableDisplayName =
        tableVal === triggerInfo.table && triggerInfo.tableLabel
          ? triggerInfo.tableLabel
          : tblExists.label || tableVal.charAt(0).toUpperCase() + tableVal.slice(1).replace(/_/g, " ")
      tableNameInput.value = { schemaless: false, schemalessValue: "", value: tableVal }
      tableNameInput.displayValue = { schemaless: false, schemalessValue: "", value: tableDisplayName }
      steps.table_name_transform = { value: tableVal, displayValue: tableDisplayName }
    }
  }

  // ── 3. Pack non-parameter field values into `values` string ───────
  // Any user-provided key that is NOT a defined action parameter goes into the values string
  var valuesInput = actionInputs.find(function (inp: any) {
    return inp.name === "values"
  })
  if (valuesInput) {
    var fieldPairs: string[] = []
    var existingValues = valuesInput.value?.value || ""

    // If user already passed a pre-built values string, use it
    if (existingValues && existingValues.includes("=")) {
      fieldPairs.push(existingValues)
    }

    // Find user-provided keys that are not defined action parameters
    for (var key of Object.keys(resolvedInputs)) {
      if (definedParamNames.includes(key)) continue
      // Also skip table (alias for table_name) and record
      if (key === "table" || key === "record") continue

      var val = resolvedInputs[key]

      // Check if value should be a data pill reference
      if (val && dataPillBase) {
        var valLower = val.toLowerCase()
        if (PILL_SHORTHANDS.includes(valLower)) {
          // Shorthand → record-level data pill
          val = "{{" + dataPillBase + "}}"
          usedInstances.push({ uiUniqueIdentifier: uuid, inputName: key })
        } else if (valLower.startsWith("trigger.current.") || valLower.startsWith("current.")) {
          // Field-level data pill: "trigger.current.assigned_to" → {{dataPillBase.assigned_to}}
          var fieldName = valLower.startsWith("trigger.current.") ? val.substring(16) : val.substring(8)
          val = "{{" + dataPillBase + "." + fieldName + "}}"
          usedInstances.push({ uiUniqueIdentifier: uuid, inputName: key })
        } else if (val.startsWith("{{") || val.includes("{{")) {
          // Already a data pill or inline pills — rewrite shorthands
          val = rewriteShorthandPills(val, dataPillBase)
          usedInstances.push({ uiUniqueIdentifier: uuid, inputName: key })
        }
      }

      fieldPairs.push(key + "=" + val)
    }

    if (fieldPairs.length > 0) {
      var packedValues = fieldPairs.join("^")
      valuesInput.value = { schemaless: false, schemalessValue: "", value: packedValues }
      steps.values_transform = { packed: packedValues, fieldCount: fieldPairs.length }
    }

    // ── 3b. Rewrite any remaining shorthand pills in the packed values string ──
    // Covers pre-built values strings passed by the agent that weren't processed per-field
    if (dataPillBase) {
      var vStr = valuesInput.value?.value || ""
      if (vStr.includes("{{")) {
        var vOriginal = vStr
        vStr = rewriteShorthandPills(vStr, dataPillBase)
        if (vStr !== vOriginal) {
          valuesInput.value.value = vStr
          steps.values_pill_rewrite = { original: vOriginal, rewritten: vStr }
        }
      }
    }
  }

  // ── 4. Build labelCache entries for data pills ────────────────────
  // Based on processflow XML analysis (labelCacheAsJsonString), the record-level pill
  // format is: { name, label, reference (table), reference_display (table label), type: "reference", base_type: "reference", attributes: {} }
  // Since our trigger is created via code (not UI), the labelCache entry may not exist yet.
  // We use INSERT for the record-level pill to ensure it exists.
  var labelCacheUpdates: any[] = []
  var labelCacheInserts: any[] = []

  if (dataPillBase && usedInstances.length > 0) {
    var tableRef = triggerInfo.tableRef || triggerInfo.table || ""
    var tblLabel = triggerInfo.tableLabel || ""

    // Record-level pill — INSERT with full metadata matching processflow XML format:
    // { name: "Created or Updated_1.current", type: "reference", reference: "incident", reference_display: "Incident", ... }
    // UI only puts inputName: "record" entries on the record pill, NOT field-level pill usages
    var recordUsedInstances = usedInstances.filter(function (ui) {
      return ui.inputName === "record"
    })
    labelCacheInserts.push(
      buildLabelCacheEntry({
        name: dataPillBase,
        label: "Trigger - Record " + triggerInfo.triggerName + "\u279b" + tblLabel + " Record",
        reference: tableRef,
        reference_display: tblLabel,
        type: "reference",
        base_type: "reference",
        parent_table_name: tableRef,
        column_name: "",
        usedInstances: recordUsedInstances,
      }),
    )

    // Field-level data pill entries for any field references in the `values` string → INSERT (new pills)
    // Parse values by ^-separated segments so we can track which TARGET field uses each pill
    var valuesStr = ""
    var valuesInp = actionInputs.find(function (inp: any) {
      return inp.name === "values"
    })
    if (valuesInp) valuesStr = valuesInp.value?.value || ""

    if (valuesStr && valuesStr.includes("{{")) {
      var pillEntryMap: Record<string, any> = {}
      var valSegments = valuesStr.split("^")

      for (var vsi2 = 0; vsi2 < valSegments.length; vsi2++) {
        var seg = valSegments[vsi2]
        var eqIdx = seg.indexOf("=")
        if (eqIdx < 0) continue
        var targetField = seg.substring(0, eqIdx)
        var segValue = seg.substring(eqIdx + 1)
        if (!segValue.includes("{{")) continue

        var segPillRx = /\{\{([^}]+)\}\}/g
        var segMatch
        while ((segMatch = segPillRx.exec(segValue)) !== null) {
          var fullPillName = segMatch[1]
          if (fullPillName === dataPillBase) continue

          if (pillEntryMap[fullPillName]) {
            // Same pill used in another field — add usedInstance
            pillEntryMap[fullPillName].usedInstances.push({ uiUniqueIdentifier: uuid, inputName: targetField })
            continue
          }

          var dotParts = fullPillName.split(".")
          var fieldCol = dotParts.length > 2 ? dotParts.slice(2).join(".") : ""

          if (fieldCol) {
            pillEntryMap[fullPillName] = {
              fieldCol: fieldCol,
              targetField: targetField,
              usedInstances: [{ uiUniqueIdentifier: uuid, inputName: targetField }],
            }
          }
        }
      }

      // Batch-collect unique source field columns for sys_dictionary lookup
      var pillNames = Object.keys(pillEntryMap)
      var uniqueCols: string[] = []
      var colSeen: Record<string, boolean> = {}
      for (var pni = 0; pni < pillNames.length; pni++) {
        var col = pillEntryMap[pillNames[pni]].fieldCol
        if (col && !colSeen[col]) {
          colSeen[col] = true
          uniqueCols.push(col)
        }
      }

      // Single batch lookup for field metadata
      var fieldMetaMap: Record<string, { type: string; label: string }> = {}
      if (uniqueCols.length > 0) {
        try {
          var dictResp = await client.get("/api/now/table/sys_dictionary", {
            params: {
              sysparm_query: "name=" + tableRef + "^elementIN" + uniqueCols.join(","),
              sysparm_fields: "element,column_label,internal_type",
              sysparm_display_value: "false",
              sysparm_limit: uniqueCols.length + 5,
            },
          })
          var dictResults = dictResp.data.result || []
          for (var di = 0; di < dictResults.length; di++) {
            var dRec = dictResults[di]
            var dEl = str(dRec.element)
            if (dEl) {
              fieldMetaMap[dEl] = {
                type: str(dRec.internal_type?.value || dRec.internal_type || "string"),
                label:
                  str(dRec.column_label) ||
                  dEl.replace(/_/g, " ").replace(/\b\w/g, function (c: string) {
                    return c.toUpperCase()
                  }),
              }
            }
          }
        } catch (_) {}
      }

      // Build labelCache entries with correct metadata and target field names
      for (var pni2 = 0; pni2 < pillNames.length; pni2++) {
        var pName = pillNames[pni2]
        var pEntry = pillEntryMap[pName]
        var fMeta = fieldMetaMap[pEntry.fieldCol] || {
          type: "string",
          label: pEntry.fieldCol.replace(/_/g, " ").replace(/\b\w/g, function (c: string) {
            return c.toUpperCase()
          }),
        }

        labelCacheInserts.push(
          buildLabelCacheEntry({
            name: pName,
            label: "Trigger - Record " + triggerInfo.triggerName + "\u279b" + tblLabel + " Record\u279b" + fMeta.label,
            reference: "",
            reference_display: fMeta.label,
            type: fMeta.type,
            base_type: fMeta.type,
            parent_table_name: tableRef,
            column_name: pEntry.fieldCol,
            usedInstances: pEntry.usedInstances,
          }),
        )
      }
    }

    steps.label_cache = {
      inserts: labelCacheInserts.map(function (e: any) {
        return e.name
      }),
      usedInstances: usedInstances.length,
    }
  }

  return { inputs: actionInputs, labelCacheUpdates, labelCacheInserts, steps }
}

// ── FLOW LOGIC (If/Else, For Each, etc.) ─────────────────────────────

async function addFlowLogicViaGraphQL(
  client: any,
  flowId: string,
  logicType: string,
  inputs?: Record<string, string>,
  order?: number,
  parentUiId?: string,
  connectedTo?: string,
  annotation?: string,
): Promise<{
  success: boolean
  logicId?: string
  uiUniqueIdentifier?: string
  resolvedOrder?: number
  steps?: any
  error?: string
}> {
  const steps: any = {}

  // Normalize common aliases to actual ServiceNow flow logic type values
  var LOGIC_TYPE_ALIASES: Record<string, string> = {
    FOR_EACH: "FOREACH",
    DO_UNTIL: "DOUNTIL",
    ELSE_IF: "ELSEIF",
    IF_ELSE: "ELSEIF",
    ELIF: "ELSEIF",
    SKIP_ITERATION: "CONTINUE",
    EXIT_LOOP: "BREAK",
    GO_BACK_TO: "GOBACKTO",
    DYNAMIC_FLOW: "DYNAMICFLOW",
    END_FLOW: "END",
    STOP: "END",
    TERMINATE: "END",
    GET_FLOW_OUTPUT: "GETFLOWOUTPUT",
    GET_FLOW_OUTPUTS: "GETFLOWOUTPUT",
    SET_FLOW_VARIABLES: "SETFLOWVARIABLES",
    SET_FLOW_VARIABLE: "SETFLOWVARIABLES",
    SET_VARIABLE: "SETFLOWVARIABLES",
    APPEND_FLOW_VARIABLES: "APPENDFLOWVARIABLES",
    APPEND_FLOW_VARIABLE: "APPENDFLOWVARIABLES",
    APPEND_VARIABLE: "APPENDFLOWVARIABLES",
    WHILE: "DOUNTIL",
    LOOP: "DOUNTIL",
    SWITCH: "DECISION",
    CASE: "DECISION",
    TRY_CATCH: "TRY",
    ERROR_HANDLER: "TRY",
    WAIT: "TIMER",
    DELAY: "TIMER",
  }
  var normalizedType = LOGIC_TYPE_ALIASES[logicType.toUpperCase()] || logicType
  if (normalizedType !== logicType) {
    steps.type_normalized = { from: logicType, to: normalizedType }
    logicType = normalizedType
  }

  // ELSE/ELSEIF blocks sit at the SAME LEVEL as their IF block (same parent), NOT nested inside IF.
  // - parent/parentUiId = the SAME parent as the IF block (e.g. flow scope or enclosing block)
  // - connectedTo = IF's sysId/logicId (the record ID returned by GraphQL, NOT the uiUniqueIdentifier)
  // Actions INSIDE the IF branch use parent_ui_id = IF's uiUniqueIdentifier.
  // ELSE/ELSEIF use parent_ui_id = IF's PARENT. This is a critical distinction.
  var isElseVariant = ["ELSE", "ELSEIF"].includes(logicType.toUpperCase())
  if (isElseVariant && !connectedTo) {
    return {
      success: false,
      error:
        logicType.toUpperCase() +
        " blocks require connected_to set to the If block's logicId (sysId from the add_flow_logic response, NOT the uiUniqueIdentifier). They must also use the SAME parent_ui_id as the IF block (same level), NOT the IF's own uiUniqueIdentifier (that would nest them INSIDE the IF branch).",
      steps,
    }
  }

  // Dynamically look up flow logic definition in sys_hub_flow_logic_definition
  // Do NOT limit sysparm_fields — fetch ALL fields to avoid missing fields with unexpected column names
  // (e.g. compilation_class vs compilationclass). The flowLogicDefinition in the GraphQL mutation
  // requires precise values for compilationClass, connectedTo, attributes, etc.
  let defId: string | null = null
  let defName = ""
  let defType = logicType
  let defRecord: any = {}
  // Try exact match on type (IF, ELSE, ELSEIF, FOREACH, DOUNTIL, etc.), then name
  for (const field of ["type", "name"]) {
    if (defId) break
    try {
      const resp = await client.get("/api/now/table/sys_hub_flow_logic_definition", {
        params: { sysparm_query: field + "=" + logicType, sysparm_limit: 1 },
      })
      const found = resp.data.result?.[0]
      if (found?.sys_id) {
        defId = found.sys_id
        defName = found.name || logicType
        defType = found.type || logicType
        defRecord = found
        steps.def_lookup = { id: found.sys_id, type: found.type, name: found.name, matched: field + "=" + logicType }
      }
    } catch (_) {}
  }
  // Fallback: LIKE search
  if (!defId) {
    try {
      const resp = await client.get("/api/now/table/sys_hub_flow_logic_definition", {
        params: {
          sysparm_query: "typeLIKE" + logicType + "^ORnameLIKE" + logicType,
          sysparm_limit: 5,
        },
      })
      const results = resp.data.result || []
      steps.def_lookup_fallback_candidates = results.map((r: any) => ({ sys_id: r.sys_id, type: r.type, name: r.name }))
      if (results[0]?.sys_id) {
        defId = results[0].sys_id
        defName = results[0].name || logicType
        defType = results[0].type || logicType
        defRecord = results[0]
        steps.def_lookup = {
          id: results[0].sys_id,
          type: results[0].type,
          name: results[0].name,
          matched: "LIKE " + logicType,
        }
      }
    } catch (_) {}
  }
  if (!defId) return { success: false, error: "Flow logic definition not found for: " + logicType, steps }
  // Log raw definition record fields AND values for diagnostics
  steps.def_record_fields = Object.keys(defRecord).filter(function (k) {
    return k !== "sys_id"
  })
  // Log actual values of critical fields (for comparison with UI network traces)
  steps.def_record_values = {
    type: str(defRecord.type),
    name: defRecord.name || "",
    compilation_class: str(defRecord.compilation_class),
    connected_to: str(defRecord.connected_to),
    order: str(defRecord.order),
    quiescence: str(defRecord.quiescence),
    visible: str(defRecord.visible),
    attributes: str(defRecord.attributes),
    category: str(defRecord.category),
    description: str(defRecord.description) ? "(present)" : "(empty)",
  }

  // Build full input objects with parameter definitions (matching UI format)
  const inputResult = await buildFlowLogicInputsForInsert(client, defId, defRecord, inputs)
  steps.available_inputs = inputResult.inputs.map((i: any) => ({ name: i.name, label: i.parameter?.label }))
  steps.resolved_inputs = inputResult.resolvedInputs
  steps.input_query_stats = {
    defParamsFound: inputResult.defParamsCount,
    inputsBuilt: inputResult.inputs.length,
    error: inputResult.inputQueryError,
  }

  // Log the actual flowLogicDefinition VALUES being sent in the GraphQL mutation
  var fld = inputResult.flowLogicDefinition
  steps.flowLogicDefinition_values = {
    id: fld.id,
    type: fld.type,
    name: fld.name,
    compilationClass: fld.compilationClass,
    connectedTo: fld.connectedTo,
    quiescence: fld.quiescence,
    order: fld.order,
    visible: fld.visible,
    attributes: fld.attributes ? "(present, " + String(fld.attributes).length + " chars)" : "(empty)",
    category: fld.category,
    inputsCount: (fld.inputs || []).length,
    variables: fld.variables,
  }

  // Validate mandatory fields (e.g. condition for IF/ELSEIF)
  // ELSE blocks have no condition — skip mandatory check for condition fields
  var effectiveMissing = inputResult.missingMandatory
  if (logicType.toUpperCase() === "ELSE" && effectiveMissing.length > 0) {
    effectiveMissing = effectiveMissing.filter(function (m: string) {
      return !m.startsWith("condition")
    })
  }
  if (effectiveMissing.length > 0) {
    steps.missing_mandatory = effectiveMissing
    return {
      success: false,
      error:
        "Missing required inputs for " +
        logicType +
        ": " +
        effectiveMissing.join(", ") +
        ". These fields are mandatory in Flow Designer.",
      steps,
    }
  }

  // ── Detect condition that needs data pill transformation ────────────
  // Flow Designer sets conditions via a SEPARATE UPDATE after the element is created.
  // Three paths:
  // 1. Standard encoded query (category=software) → transform fields to {{dataPillBase.field}}
  // 2. Contains {{shorthand}} like {{trigger.current.X}} → rewrite to {{dataPillBase.X}} + labelCache
  // 3. Non-standard (JS expression, fd_data ref) → passthrough
  const uuid = generateUUID()
  var conditionInput = inputResult.inputs.find(function (inp: any) {
    return inp.name === "condition"
  })
  var rawCondition = validateAndFixPills(conditionInput?.value?.value || "")
  var needsConditionUpdate = false
  var conditionTriggerInfo: any = null

  // Pre-process: normalize trigger.record / record / trigger_record → trigger.current
  // The agent often uses "trigger.record.X" or "record.X" but Flow Designer internally uses "current"
  // This must happen BEFORE all other condition processing so downstream regexes can match uniformly
  if (rawCondition && !rawCondition.includes("{{")) {
    var prefixNormalized = rawCondition
      .replace(/\btrigger\.record\./g, "trigger.current.")
      .replace(/\btrigger_record\./g, "trigger.current.")
      .replace(/\brecord\./g, "trigger.current.")
    if (prefixNormalized !== rawCondition) {
      steps.prefix_normalization = { original: rawCondition, normalized: prefixNormalized }
      rawCondition = prefixNormalized
    }
  }

  // Pre-process: detect bare field conditions and add trigger.current. prefix
  // e.g. "priority <= 2" → "trigger.current.priority <= 2"
  // e.g. "priority<=2^category=software" → "trigger.current.priority<=2^trigger.current.category=software"
  // Only applies when there's no dot-notation prefix and no pill references
  if (
    rawCondition &&
    !rawCondition.includes("{{") &&
    !rawCondition.includes(".") &&
    !rawCondition.startsWith("fd_data")
  ) {
    var BARE_FIELD_RE =
      /(^|\^(?:OR)?|\^NQ)(\w+)\s*(===?|!==?|>=|<=|>|<|=|LIKE|STARTSWITH|ENDSWITH|NOT LIKE|ISEMPTY|ISNOTEMPTY)\s*/g
    if (BARE_FIELD_RE.test(rawCondition)) {
      BARE_FIELD_RE.lastIndex = 0
      rawCondition = rawCondition.replace(
        BARE_FIELD_RE,
        function (_m: string, prefix: string, field: string, op: string) {
          return prefix + "trigger.current." + field + op
        },
      )
      steps.bare_field_rewrite = { original: conditionInput?.value?.value, rewritten: rawCondition }
    }
  }

  // Pre-process: detect dot notation conditions and convert to shorthand pill format.
  // Supports both symbol operators and word operators:
  //   "trigger.current.category = software"          → "{{trigger.current.category}}=software"
  //   "trigger.current.category == 'software'"       → "{{trigger.current.category}}=software"
  //   "trigger.current.category equals software"     → "{{trigger.current.category}}=software"
  //   "trigger.current.priority != 1"                → "{{trigger.current.priority}}!=1"
  //   "current.active is true"                       → "{{current.active}}=true"
  var WORD_OP_MAP: Record<string, string> = {
    equals: "=",
    is: "=",
    eq: "=",
    not_equals: "!=",
    "is not": "!=",
    neq: "!=",
    "not equals": "!=",
    "greater than": ">",
    gt: ">",
    "less than": "<",
    lt: "<",
    "greater or equals": ">=",
    gte: ">=",
    "less or equals": "<=",
    lte: "<=",
    contains: "LIKE",
    "starts with": "STARTSWITH",
    "ends with": "ENDSWITH",
    "not contains": "NOT LIKE",
    "is empty": "ISEMPTY",
    "is not empty": "ISNOTEMPTY",
  }
  // First replace word operators with symbols so the regex can match uniformly
  var dotOriginal = rawCondition
  var dotProcessed = rawCondition
  var WORD_OPS_SORTED = Object.keys(WORD_OP_MAP).sort(function (a, b) {
    return b.length - a.length
  }) // longest first
  for (var wi = 0; wi < WORD_OPS_SORTED.length; wi++) {
    var wordOp = WORD_OPS_SORTED[wi]
    // Only replace word operators that appear between a dot-notation field and a value
    var wordRe = new RegExp("((?:trigger\\.)?current\\.\\w+)\\s+" + wordOp.replace(/ /g, "\\s+") + "\\s+", "gi")
    dotProcessed = dotProcessed.replace(wordRe, function (m: string, prefix: string) {
      return prefix + WORD_OP_MAP[wordOp]
    })
  }
  // Value capture stops at the `^` clause separator (and whitespace) so that in a
  // multi-clause condition like "current.priority=2^current.active=true" the first
  // clause's value doesn't greedily swallow the rest — otherwise only the first
  // field becomes a pill and later condition rows render with an empty field.
  var DOT_NOTATION_RE =
    /((?:trigger\.)?current)\.(\w+)\s*(===?|!==?|>=|<=|>|<|=|LIKE|STARTSWITH|ENDSWITH|NOT LIKE|ISEMPTY|ISNOTEMPTY)\s*(?:'([^']*)'|"([^"]*)"|([^\s^]*))/g
  if (DOT_NOTATION_RE.test(dotProcessed)) {
    DOT_NOTATION_RE.lastIndex = 0
    rawCondition = dotProcessed.replace(
      DOT_NOTATION_RE,
      function (_m: string, prefix: string, field: string, op: string, qv1: string, qv2: string, uv: string) {
        var snOp = op
        if (op === "==" || op === "===") snOp = "="
        else if (op === "!=" || op === "!==") snOp = "!="
        var val = qv1 !== undefined ? qv1 : qv2 !== undefined ? qv2 : uv || ""
        return "{{" + prefix + "." + field + "}}" + snOp + val
      },
    )
    // Replace JS && with ServiceNow ^ (AND separator)
    rawCondition = rawCondition.replace(/\s*&&\s*/g, "^")
    steps.dot_notation_rewrite = { original: dotOriginal, rewritten: rawCondition }
  }

  // Pre-process: convert word operators in pill-format conditions
  // e.g. "{{trigger.current.category}} equals software" → "{{trigger.current.category}}=software"
  if (rawCondition.includes("{{")) {
    var PILL_WORD_OPS: [RegExp, string][] = [
      [/(\}\})\s+not\s+equals\s+/gi, "$1!="],
      [/(\}\})\s+is\s+not\s+/gi, "$1!="],
      [/(\}\})\s+equals\s+/gi, "$1="],
      [/(\}\})\s+is\s+/gi, "$1="],
      [/(\}\})\s+contains\s+/gi, "$1LIKE"],
      [/(\}\})\s+starts\s+with\s+/gi, "$1STARTSWITH"],
      [/(\}\})\s+ends\s+with\s+/gi, "$1ENDSWITH"],
      [/(\}\})\s+greater\s+than\s+/gi, "$1>"],
      [/(\}\})\s+less\s+than\s+/gi, "$1<"],
      // Symbol operators: = / == / === / != / !== / >= / <= / > / < with optional spaces
      // IMPORTANT: >= and <= must come BEFORE single > and < to avoid partial matches
      [/(\}\})\s*>=\s*/g, "$1>="],
      [/(\}\})\s*<=\s*/g, "$1<="],
      [/(\}\})\s*!={1,2}\s*/g, "$1!="],
      [/(\}\})\s*={1,3}\s*/g, "$1="],
      [/(\}\})\s*>\s*/g, "$1>"],
      [/(\}\})\s*<\s*/g, "$1<"],
    ]
    var pillWordOriginal = rawCondition
    for (var pwi = 0; pwi < PILL_WORD_OPS.length; pwi++) {
      rawCondition = rawCondition.replace(PILL_WORD_OPS[pwi][0], PILL_WORD_OPS[pwi][1])
    }
    if (rawCondition !== pillWordOriginal) {
      steps.pill_word_op_rewrite = { original: pillWordOriginal, rewritten: rawCondition }
    }
  }

  // Shorthand patterns that need rewriting to the real data pill base
  // e.g. {{trigger.current.category}} → {{Created or Updated_1.current.category}}
  var condHasShorthand = hasShorthandPills(rawCondition)
  // Also detect conditions that already contain full data pill references (non-shorthand)
  // e.g. {{Created or Updated_1.current.priority}}=1 — these still need two-step + labelCache
  var hasFullPillRefs = rawCondition.includes("{{") && !condHasShorthand

  if (
    rawCondition &&
    rawCondition !== "^EQ" &&
    (isStandardEncodedQuery(rawCondition) || condHasShorthand || hasFullPillRefs)
  ) {
    conditionTriggerInfo = await getFlowTriggerInfo(client, flowId)
    steps.trigger_info = {
      dataPillBase: conditionTriggerInfo.dataPillBase,
      triggerName: conditionTriggerInfo.triggerName,
      table: conditionTriggerInfo.table,
      tableLabel: conditionTriggerInfo.tableLabel,
      error: conditionTriggerInfo.error,
      debug: conditionTriggerInfo.debug,
    }
    if (conditionTriggerInfo.dataPillBase) {
      needsConditionUpdate = true

      // If condition has shorthand pills, rewrite them to real data pill base first
      if (condHasShorthand) {
        rawCondition = rewriteShorthandPills(rawCondition, conditionTriggerInfo.dataPillBase)
        steps.shorthand_rewrite = { original: conditionInput?.value?.value, rewritten: rawCondition }
      }

      // Clear condition in INSERT — it will be set via separate UPDATE with labelCache
      conditionInput.value = { schemaless: false, schemalessValue: "", value: "" }
      steps.condition_strategy = "two_step"
    }
  } else if (rawCondition && rawCondition !== "^EQ") {
    // Non-standard condition (JS expression, fd_data ref, etc.) — pass through as-is
    steps.condition_strategy = "passthrough"
    steps.condition_not_encoded_query = true
  }

  // ── Rewrite shorthand pills in non-condition inputs (e.g. FOR_EACH "items") ────
  // These inputs may contain {{trigger.current}} or {{current.field}} that need rewriting
  // to the full dataPillBase (e.g. {{Created or Updated_1.current}}) + labelCache for rendering.
  // Also handle inputs that already have full pill references — they still need labelCache.
  var nonConditionPillInputs: { name: string; fields: string[]; isRecordLevel: boolean }[] = []
  for (var nci = 0; nci < inputResult.inputs.length; nci++) {
    var ncInput = inputResult.inputs[nci]
    if (ncInput.name === "condition" || ncInput.name === "condition_name") continue
    var ncVal = validateAndFixPills(ncInput.value?.value || "")
    if (!ncVal.includes("{{")) continue

    var ncHasShorthand = hasShorthandPills(ncVal)

    // Get trigger info for shorthand rewriting OR for labelCache building (even non-shorthand pills)
    if (!conditionTriggerInfo) {
      conditionTriggerInfo = await getFlowTriggerInfo(client, flowId)
      steps.trigger_info = {
        dataPillBase: conditionTriggerInfo.dataPillBase,
        triggerName: conditionTriggerInfo.triggerName,
        table: conditionTriggerInfo.table,
        tableLabel: conditionTriggerInfo.tableLabel,
        error: conditionTriggerInfo.error,
        debug: conditionTriggerInfo.debug,
      }
    }
    if (!conditionTriggerInfo.dataPillBase) continue

    var ncPillBase = conditionTriggerInfo.dataPillBase
    var ncOrigVal = ncVal

    // Rewrite shorthand pills to full dataPillBase
    if (ncHasShorthand) {
      ncVal = rewriteShorthandPills(ncVal, ncPillBase)
      ncInput.value.value = ncVal
    }

    // Extract field names from ALL pills in the value for labelCache
    var ncPillFields: string[] = []
    var ncIsRecordLevel = false
    var ncPillRx = /\{\{([^}]+)\}\}/g
    var ncm: RegExpExecArray | null
    while ((ncm = ncPillRx.exec(ncVal)) !== null) {
      var ncParts = ncm[1].split(".")
      if (ncParts.length > 2) {
        ncPillFields.push(ncParts.slice(2).join("."))
      } else {
        // Record-level pill like {{Created or Updated_1.current}}
        ncIsRecordLevel = true
      }
    }

    if (ncPillFields.length > 0 || ncIsRecordLevel) {
      nonConditionPillInputs.push({ name: ncInput.name, fields: ncPillFields, isRecordLevel: ncIsRecordLevel })
      if (ncOrigVal !== ncVal) {
        steps["pill_rewrite_" + ncInput.name] = { original: ncOrigVal, rewritten: ncVal }
      } else {
        steps["pill_labelcache_" + ncInput.name] = { fields: ncPillFields, isRecordLevel: ncIsRecordLevel }
      }
    }
  }

  // Calculate insertion order (with TRY/CATCH-aware nesting)
  var resolvedOrder = await calculateInsertOrder(client, flowId, parentUiId, order)
  var nestedReorder: { actions: any[]; flowLogics: any[]; subflows: any[] } | null = null
  var nestedCatchUuid: string | undefined
  if (parentUiId) {
    const nested = await computeNestedOrder(client, flowId, parentUiId, order, steps)
    if (nested) {
      resolvedOrder = nested.order
      nestedReorder = nested.reorder
      nestedCatchUuid = nested.catchUuid
    }
  }
  steps.insert_order = resolvedOrder

  const logicResponseFields =
    "flowLogics { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }" +
    " actions { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }" +
    " subflows { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }"

  // Build the insert object — include connectedTo when linking Else to an If block
  var insertObj: any = {
    order: String(resolvedOrder),
    uiUniqueIdentifier: uuid,
    parent: parentUiId || "",
    metadata: '{"predicates":[]}',
    flowSysId: flowId,
    generationSource: "",
    definitionId: defId,
    type: "flowlogic",
    parentUiId: parentUiId || "",
    inputs: inputResult.inputs,
    outputsToAssign: [],
    flowLogicDefinition: inputResult.flowLogicDefinition,
    comment: annotation || "",
  }
  if (connectedTo) {
    insertObj.connectedTo = connectedTo
  } else if (nestedCatchUuid) {
    insertObj.connectedTo = nestedCatchUuid
  }

  // Log the insertObj key values for diagnostics (compare with UI network trace)
  steps.insertObj_values = {
    order: insertObj.order,
    uiUniqueIdentifier: insertObj.uiUniqueIdentifier,
    parent: insertObj.parent,
    parentUiId: insertObj.parentUiId,
    connectedTo: insertObj.connectedTo || "(not set)",
    definitionId: insertObj.definitionId,
    type: insertObj.type,
    flowSysId: insertObj.flowSysId,
    metadata: insertObj.metadata,
    generationSource: insertObj.generationSource,
    inputsCount: (insertObj.inputs || []).length,
    outputsToAssignCount: (insertObj.outputsToAssign || []).length,
  }

  var flowPatch: any = {
    flowId: flowId,
    flowLogics: {
      insert: [insertObj],
    },
  }

  var catchUuid: string | undefined
  if (defType.toUpperCase() === "TRY") {
    catchUuid = generateUUID()
    var catchDefRecord: any = null
    try {
      var catchResp = await client.get("/api/now/table/sys_hub_flow_logic_definition", {
        params: { sysparm_query: "type=CATCH", sysparm_limit: 1 },
      })
      catchDefRecord = catchResp.data.result?.[0]
    } catch (_) {}

    if (catchDefRecord) {
      var catchInputResult = await buildFlowLogicInputsForInsert(client, catchDefRecord.sys_id, catchDefRecord, {})
      var catchInsertObj: any = {
        order: String(resolvedOrder + 1),
        uiUniqueIdentifier: catchUuid,
        parent: parentUiId || "",
        metadata: '{"predicates":[]}',
        flowSysId: flowId,
        generationSource: "",
        connectedTo: uuid,
        definitionId: catchDefRecord.sys_id,
        type: "flowlogic",
        parentUiId: parentUiId || "",
        inputs: catchInputResult.inputs,
        outputsToAssign: [],
        flowLogicDefinition: catchInputResult.flowLogicDefinition,
        comment: "",
      }
      flowPatch.flowLogics.insert.push(catchInsertObj)
      steps.catch_companion = {
        uuid: catchUuid,
        defId: catchDefRecord.sys_id,
        connectedTo: uuid,
        order: resolvedOrder + 1,
        inputsCount: catchInputResult.inputs.length,
      }
    }
  }

  if (nestedReorder) {
    const logicUpdates = parentUiId ? [{ uiUniqueIdentifier: parentUiId, type: "flowlogic" }] : []
    for (const u of nestedReorder.flowLogics) logicUpdates.push(u)
    if (logicUpdates.length > 0) {
      flowPatch.flowLogics.update = logicUpdates
    }
    if (nestedReorder.actions.length > 0) flowPatch.actions = { update: nestedReorder.actions }
    if (nestedReorder.subflows.length > 0) flowPatch.subflows = { update: nestedReorder.subflows }
  } else if (parentUiId) {
    flowPatch.flowLogics.update = [{ uiUniqueIdentifier: parentUiId, type: "flowlogic" }]
  }

  // Log the full serialized GraphQL mutation for direct comparison with UI network traces
  var mutationPreview =
    "mutation { global { snFlowDesigner { flow(flowPatch: " + jsToGraphQL(flowPatch) + ") { id ... } } } }"
  steps.graphql_mutation_preview =
    mutationPreview.length > 5000 ? mutationPreview.substring(0, 5000) + "... (truncated)" : mutationPreview

  try {
    // Step 1: INSERT the flow logic element (with empty condition if data pill transform is needed)
    const result = await executeFlowPatchMutation(client, flowPatch, logicResponseFields)
    const logicId = result?.flowLogics?.inserts?.[0]?.sysId
    const returnedUuid = result?.flowLogics?.inserts?.[0]?.uiUniqueIdentifier || uuid
    steps.insert = { success: !!logicId, logicId, uuid: returnedUuid }
    if (!logicId) return { success: false, steps, error: "GraphQL flow logic INSERT returned no ID" }

    if (catchUuid) {
      var catchInsert = result?.flowLogics?.inserts?.[1]
      steps.catch_insert = {
        sysId: catchInsert?.sysId,
        uiUniqueIdentifier: catchInsert?.uiUniqueIdentifier || catchUuid,
      }
      if (!catchInsert?.sysId) {
        steps.catch_warning =
          "CATCH companion was sent in mutation but GraphQL did not return a sysId for it. The TRY block was created but the CATCH may be missing."
      }
    }

    // Step 2: UPDATE condition with data pill + labelCache (separate mutation, matching UI behavior)
    // The Flow Designer UI always sets conditions in a separate UPDATE after creating the element.
    if (needsConditionUpdate && conditionTriggerInfo) {
      var dataPillBase = conditionTriggerInfo.dataPillBase
      var transformedCondition: string

      if (rawCondition.includes("{{")) {
        // Condition already contains data pill references (after shorthand rewrite)
        // Use as-is and extract field names from {{pill.field}} patterns for labelCache
        transformedCondition = rawCondition
        var pillFields: string[] = []
        var pillRx = /\{\{([^}]+)\}\}/g
        var pm
        while ((pm = pillRx.exec(rawCondition)) !== null) {
          var pParts = pm[1].split(".")
          if (pParts.length > 2) pillFields.push(pParts.slice(2).join("."))
        }
        // Build labelCache using extracted field names
        var labelCacheResult = await buildConditionLabelCache(
          client,
          rawCondition,
          dataPillBase,
          conditionTriggerInfo.triggerName,
          conditionTriggerInfo.tableRef,
          conditionTriggerInfo.tableLabel,
          returnedUuid,
          pillFields,
        )
      } else {
        // Plain encoded query — transform to data pill format
        transformedCondition = transformConditionToDataPills(rawCondition, dataPillBase)
        var labelCacheResult = await buildConditionLabelCache(
          client,
          rawCondition,
          dataPillBase,
          conditionTriggerInfo.triggerName,
          conditionTriggerInfo.tableRef,
          conditionTriggerInfo.tableLabel,
          returnedUuid,
        )
      }

      steps.condition_transform = { original: rawCondition, transformed: transformedCondition }
      steps.label_cache = labelCacheResult.map(function (e: any) {
        return e.name
      })

      try {
        // Match the UI's exact format for condition UPDATE (captured from clean Flow Designer network trace):
        // - labelCache.insert: field-level pills with FULL metadata (type, parent_table_name, etc.)
        // - Two inputs: condition_name (label) + condition (pill expression)
        // - No flowLogicDefinition, no displayValue on condition
        var updatePatch: any = {
          flowId: flowId,
          flowLogics: {
            update: [
              {
                uiUniqueIdentifier: returnedUuid,
                type: "flowlogic",
                inputs: [
                  {
                    name: "condition_name",
                    value: {
                      schemaless: false,
                      schemalessValue: "",
                      value: inputResult.resolvedInputs["condition_name"] || "",
                    },
                  },
                  {
                    name: "condition",
                    value: { schemaless: false, schemalessValue: "", value: transformedCondition },
                  },
                ],
              },
            ],
          },
        }
        if (labelCacheResult.length > 0) {
          var condExisting = await getExistingLabelCachePills(client, flowId)
          var condSplit = splitLabelCacheEntries(labelCacheResult, condExisting)
          updatePatch.labelCache = {} as any
          if (condSplit.inserts.length > 0) updatePatch.labelCache.insert = condSplit.inserts
          if (condSplit.updates.length > 0) updatePatch.labelCache.update = condSplit.updates
          steps.condition_label_cache_split = { inserts: condSplit.inserts.length, updates: condSplit.updates.length }
        }
        // Log the exact GraphQL mutation for debugging
        steps.condition_update_mutation = jsToGraphQL(updatePatch)
        var updateResult = await executeFlowPatchMutation(client, updatePatch, logicResponseFields)
        steps.condition_update = { success: true, response: updateResult }
      } catch (ue: any) {
        steps.condition_update = { success: false, error: ue.message }
        // Rollback: delete the just-inserted flow logic element to avoid a broken element
        try {
          await executeFlowPatchMutation(
            client,
            { flowId: flowId, flowLogics: { delete: [returnedUuid] } },
            "flowLogics { deletes __typename }",
          )
          steps.flow_logic_rollback = { success: true, deleted: returnedUuid }
        } catch (rollbackErr: any) {
          steps.flow_logic_rollback = { success: false, error: rollbackErr.message }
        }
        return {
          success: false,
          steps,
          error: "Flow logic created but condition UPDATE failed (rolled back): " + ue.message,
        }
      }
    }

    // Step 3: UPDATE labelCache for non-condition inputs with data pills (e.g. FOR_EACH "items")
    if (nonConditionPillInputs.length > 0 && conditionTriggerInfo?.dataPillBase) {
      try {
        var ncLabelInserts: any[] = []
        var dPillBase = conditionTriggerInfo.dataPillBase
        var dTriggerName = conditionTriggerInfo.triggerName
        var dTable = conditionTriggerInfo.tableRef
        var dTableLabel = conditionTriggerInfo.tableLabel

        for (var nli = 0; nli < nonConditionPillInputs.length; nli++) {
          var ncpi = nonConditionPillInputs[nli]

          // Field-level pills: reuse buildConditionLabelCache with the correct inputName
          if (ncpi.fields.length > 0) {
            var ncFieldEntries = await buildConditionLabelCache(
              client,
              "",
              dPillBase,
              dTriggerName,
              dTable,
              dTableLabel,
              returnedUuid,
              ncpi.fields,
              ncpi.name,
            )
            ncLabelInserts = ncLabelInserts.concat(ncFieldEntries)
          }

          // Record-level pill (e.g. {{Created or Updated_1.current}}) — add record-level labelCache entry
          if (ncpi.isRecordLevel) {
            ncLabelInserts.push(
              buildLabelCacheEntry({
                name: dPillBase,
                label: "Trigger - Record " + dTriggerName + "\u279b" + dTableLabel + " Record\u279b" + dTableLabel,
                reference: dTable,
                reference_display: dTableLabel,
                type: "reference",
                base_type: "reference",
                parent_table_name: dTable,
                column_name: "",
                usedInstances: [{ uiUniqueIdentifier: returnedUuid, inputName: ncpi.name }],
              }),
            )
          }
        }

        ncLabelInserts = deduplicateLabelCache(ncLabelInserts)

        if (ncLabelInserts.length > 0) {
          var ncExisting = await getExistingLabelCachePills(client, flowId)
          var ncSplit = splitLabelCacheEntries(ncLabelInserts, ncExisting)
          var ncUpdatePatch: any = {
            flowId: flowId,
            flowLogics: {
              update: [
                {
                  uiUniqueIdentifier: returnedUuid,
                  type: "flowlogic",
                },
              ],
            },
            labelCache: {} as any,
          }
          if (ncSplit.inserts.length > 0) ncUpdatePatch.labelCache.insert = ncSplit.inserts
          if (ncSplit.updates.length > 0) ncUpdatePatch.labelCache.update = ncSplit.updates
          steps.nc_pill_label_cache_mutation = jsToGraphQL(ncUpdatePatch)
          await executeFlowPatchMutation(client, ncUpdatePatch, logicResponseFields)
          steps.nc_pill_label_cache_update = {
            success: true,
            inserts: ncSplit.inserts.length,
            updates: ncSplit.updates.length,
          }
        }
      } catch (nce: any) {
        steps.nc_pill_label_cache_update = { success: false, error: nce.message }
        // Non-fatal: element was created, just label rendering may be affected
      }
    }

    return { success: true, logicId, uiUniqueIdentifier: returnedUuid, resolvedOrder, steps }
  } catch (e: any) {
    steps.insert = { success: false, error: e.message }
    return { success: false, steps, error: "GraphQL flow logic INSERT failed: " + e.message }
  }
}

// ── SUBFLOW INPUT/OUTPUT BUILDER (matching UI mutation format) ─────────

async function buildSubflowInputsForInsert(
  client: any,
  subflowSysId: string,
  userValues?: Record<string, string>,
): Promise<{
  inputs: any[]
  outputs: any[]
  waitForCompletion: any
  showStages: any
  resolvedInputs: Record<string, string>
  missingMandatory: string[]
}> {
  var inputParams: any[] = []
  var outputParams: any[] = []
  try {
    var inpResp = await client.get("/api/now/table/sys_hub_flow_variable", {
      params: {
        sysparm_query: "flow=" + subflowSysId + "^variable_type=input^ORDERBYorder",
        sysparm_fields:
          "sys_id,name,label,internal_type,mandatory,default_value,order,max_length,hint,read_only,extended,data_structure,reference,reference_display,ref_qual,choice_option,table_name,column_name,use_dependent,dependent_on,show_ref_finder,local,attributes,sys_class_name",
        sysparm_display_value: "false",
        sysparm_limit: 50,
      },
    })
    var rawInputs = inpResp.data.result || []
    var seenIds: Record<string, boolean> = {}
    var seenNames: Record<string, boolean> = {}
    for (var ri = 0; ri < rawInputs.length; ri++) {
      var rid = str(rawInputs[ri].sys_id)
      var rname = str(rawInputs[ri].name)
      if (seenIds[rid] || seenNames[rname]) continue
      seenIds[rid] = true
      seenNames[rname] = true
      inputParams.push(rawInputs[ri])
    }
  } catch (e: any) {
    console.warn(
      "[snow_manage_flow] sys_hub_flow_variable input query failed for flow=" + subflowSysId + ": " + (e.message || ""),
    )
  }
  try {
    var outResp = await client.get("/api/now/table/sys_hub_flow_variable", {
      params: {
        sysparm_query: "flow=" + subflowSysId + "^variable_type=output^ORDERBYorder",
        sysparm_fields: "sys_id,name,label,internal_type,mandatory,order,reference,attributes",
        sysparm_display_value: "false",
        sysparm_limit: 50,
      },
    })
    var rawOutputs = outResp.data.result || []
    var seenOutIds: Record<string, boolean> = {}
    var seenOutNames: Record<string, boolean> = {}
    for (var ro = 0; ro < rawOutputs.length; ro++) {
      var roid = str(rawOutputs[ro].sys_id)
      var roname = str(rawOutputs[ro].name)
      if (seenOutIds[roid] || seenOutNames[roname]) continue
      seenOutIds[roid] = true
      seenOutNames[roname] = true
      outputParams.push(rawOutputs[ro])
    }
  } catch (e: any) {
    console.warn(
      "[snow_manage_flow] sys_hub_flow_variable output query failed for flow=" +
        subflowSysId +
        ": " +
        (e.message || ""),
    )
  }

  var resolvedInputs: Record<string, string> = {}
  if (userValues) {
    var paramNames = inputParams.map(function (p: any) {
      return str(p.name)
    })
    for (var [key, value] of Object.entries(userValues)) {
      if (paramNames.includes(key)) {
        resolvedInputs[key] = value
        continue
      }
      var keyLC = key.toLowerCase().replace(/[\s-]/g, "_")
      var match = inputParams.find(function (p: any) {
        var nm = str(p.name)
        var nmLC = nm.toLowerCase()
        if (nmLC.endsWith("_" + keyLC)) return true
        if (nmLC.startsWith(keyLC + "_")) return true
        if (nmLC === keyLC) return true
        if (str(p.label).toLowerCase() === keyLC) return true
        var stripped = nmLC.replace(/^(ah_|sn_|sc_|rp_|fb_|kb_)/, "")
        if (stripped === keyLC) return true
        if (nmLC.replace(/_/g, "") === keyLC.replace(/_/g, "")) return true
        return false
      })
      if (match) resolvedInputs[str(match.name)] = value
      else resolvedInputs[key] = value
    }
  }

  for (var rk of Object.keys(resolvedInputs)) {
    var rv = resolvedInputs[rk]
    if (rv && typeof rv === "object" && !Array.isArray(rv)) {
      var pairs: string[] = []
      for (var [fk, fv] of Object.entries(rv)) {
        pairs.push(fk + "=" + String(fv))
      }
      resolvedInputs[rk] = pairs.join("^")
    }
  }

  var inputs = inputParams.map(function (rec: any) {
    var paramType = str(rec.internal_type) || "string"
    var name = str(rec.name)
    var varId = str(rec.sys_id)
    var userVal = resolvedInputs[name] || ""
    return {
      id: varId,
      name: name,
      children: [],
      displayValue: { value: "" },
      value: { schemaless: false, schemalessValue: "", value: userVal },
      parameter: {
        id: varId,
        label: str(rec.label) || name,
        name: name,
        type: paramType,
        type_label: TYPE_LABELS[paramType] || paramType.charAt(0).toUpperCase() + paramType.slice(1),
        hint: str(rec.hint),
        order: parseInt(str(rec.order) || "0", 10),
        extended: str(rec.extended) === "true",
        mandatory: str(rec.mandatory) === "true",
        readonly: str(rec.read_only) === "true",
        maxsize: parseInt(str(rec.max_length) || "8000", 10),
        data_structure: str(rec.data_structure),
        reference: str(rec.reference),
        reference_display: str(rec.reference_display),
        ref_qual: str(rec.ref_qual),
        choiceOption: str(rec.choice_option),
        table: str(rec.table_name),
        columnName: str(rec.column_name),
        defaultValue: str(rec.default_value),
        use_dependent: str(rec.use_dependent) === "true",
        dependent_on: str(rec.dependent_on),
        show_ref_finder: str(rec.show_ref_finder) === "true",
        local: str(rec.local) === "true",
        attributes: str(rec.attributes),
        sys_class_name: str(rec.sys_class_name),
        children: [],
      },
    }
  })

  var outputs = outputParams.map(function (rec: any) {
    var paramType = str(rec.internal_type) || "string"
    var attrs = str(rec.attributes)
    var uiType = paramType
    var uiMatch = attrs.match(/uiType=([^,]+)/)
    if (uiMatch) uiType = uiMatch[1]
    return {
      label: str(rec.label) || str(rec.name),
      name: str(rec.name),
      type: paramType,
      type_label: TYPE_LABELS[paramType] || paramType.charAt(0).toUpperCase() + paramType.slice(1),
      order: parseInt(str(rec.order) || "0", 10),
      mandatory: str(rec.mandatory) === "true",
      reference: str(rec.reference),
      attributes: attrs,
      uiDisplayType: uiType,
      uiDisplayTypeLabel: TYPE_LABELS[uiType] || uiType.charAt(0).toUpperCase() + uiType.slice(1),
      internal_link: "",
    }
  })

  var waitForCompletion = {
    label: "Wait For Completion",
    name: "wait_for_completion",
    type: "boolean",
    type_label: "True/False",
    mandatory: false,
    readonly: false,
    attributes: "fd_hide_inline_script_widget=true,",
    uiDisplayType: "boolean",
    uiDisplayTypeLabel: "True/False",
    value: "true",
  }

  var showStages = {
    label: "Show Subflow Stages",
    name: "show_stages",
    type: "boolean",
    type_label: "True/False",
    mandatory: false,
    readonly: true,
    attributes: "fd_hide_inline_script_widget=true,",
    uiDisplayType: "boolean",
    uiDisplayTypeLabel: "True/False",
    value: "false",
  }

  var missingMandatory = inputs
    .filter(function (inp: any) {
      return inp.parameter?.mandatory && !inp.value?.value
    })
    .map(function (inp: any) {
      return inp.name + " (" + (inp.parameter?.label || inp.name) + ")"
    })

  return { inputs, outputs, waitForCompletion, showStages, resolvedInputs, missingMandatory }
}

// ── SUBFLOW CALL (invoke a subflow as a step) ────────────────────────

async function addSubflowCallViaGraphQL(
  client: any,
  flowId: string,
  subflowId: string,
  inputs?: Record<string, string>,
  order?: number,
  parentUiId?: string,
  annotation?: string,
): Promise<{
  success: boolean
  callId?: string
  uiUniqueIdentifier?: string
  resolvedOrder?: number
  steps?: any
  error?: string
}> {
  const steps: any = {}

  // Resolve subflow: look up by sys_id, name, or internal_name in sys_hub_flow
  let subflowSysId = isSysId(subflowId) ? subflowId : null
  let subflowName = ""
  if (!subflowSysId) {
    for (const field of ["name", "internal_name"]) {
      if (subflowSysId) break
      try {
        const resp = await client.get("/api/now/table/sys_hub_flow", {
          params: {
            sysparm_query: field + "=" + subflowId + "^type=subflow",
            sysparm_fields: "sys_id,name,internal_name",
            sysparm_limit: 1,
          },
        })
        const found = resp.data.result?.[0]
        if (found?.sys_id) {
          subflowSysId = found.sys_id
          subflowName = found.name || subflowId
          steps.subflow_lookup = {
            id: found.sys_id,
            name: found.name,
            internal_name: found.internal_name,
            matched: field + "=" + subflowId,
          }
        }
      } catch (_) {}
    }
    // LIKE fallback
    if (!subflowSysId) {
      try {
        const resp = await client.get("/api/now/table/sys_hub_flow", {
          params: {
            sysparm_query: "nameLIKE" + subflowId + "^type=subflow",
            sysparm_fields: "sys_id,name,internal_name",
            sysparm_limit: 5,
          },
        })
        const results = resp.data.result || []
        steps.subflow_lookup_candidates = results.map((r: any) => ({
          sys_id: r.sys_id,
          name: r.name,
          internal_name: r.internal_name,
        }))
        if (results[0]?.sys_id) {
          subflowSysId = results[0].sys_id
          subflowName = results[0].name || subflowId
          steps.subflow_lookup = { id: results[0].sys_id, name: results[0].name, matched: "LIKE " + subflowId }
        }
      } catch (_) {}
    }
  }
  if (!subflowSysId) return { success: false, error: "Subflow not found: " + subflowId, steps }

  if (!subflowName) subflowName = subflowId

  // Calculate insertion order (with TRY/CATCH-aware nesting)
  var resolvedOrder = await calculateInsertOrder(client, flowId, parentUiId, order)
  var nestedReorder: { actions: any[]; flowLogics: any[]; subflows: any[] } | null = null
  var nestedCatchUuid: string | undefined
  if (parentUiId) {
    const nested = await computeNestedOrder(client, flowId, parentUiId, order, steps)
    if (nested) {
      resolvedOrder = nested.order
      nestedReorder = nested.reorder
      nestedCatchUuid = nested.catchUuid
    }
  }
  steps.insert_order = resolvedOrder

  const uuid = generateUUID()
  const subflowResponseFields =
    "subflows { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }" +
    " flowLogics { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }" +
    " actions { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }"

  var built = await buildSubflowInputsForInsert(client, subflowSysId, inputs)
  steps.subflow_inputs = {
    count: built.inputs.length,
    outputs: built.outputs.length,
    resolved: built.resolvedInputs,
    missing: built.missingMandatory,
    input_ids: built.inputs.map(function (inp: any) {
      return inp.id + ":" + inp.name
    }),
    output_names: built.outputs.map(function (out: any) {
      return out.name
    }),
  }

  const subPatch: any = {
    flowId: flowId,
    subflows: {
      insert: [
        {
          metadata: '{"predicates":[]}',
          flowSysId: flowId,
          generationSource: "",
          name: subflowName,
          order: String(resolvedOrder),
          parent: parentUiId || "",
          subflowSysId: subflowSysId,
          uiUniqueIdentifier: uuid,
          type: "subflow",
          parentUiId: parentUiId || "",
          inputs: built.inputs,
          outputs: built.outputs,
          waitForCompletion: built.waitForCompletion,
          showStages: built.showStages,
          comment: annotation || "",
          ...(nestedCatchUuid ? { connectedTo: nestedCatchUuid } : {}),
        },
      ],
    },
  }

  if (nestedReorder) {
    if (nestedReorder.subflows.length > 0) subPatch.subflows.update = nestedReorder.subflows
    const logicUpdates = parentUiId ? [{ uiUniqueIdentifier: parentUiId, type: "flowlogic" }] : []
    for (const u of nestedReorder.flowLogics) logicUpdates.push(u)
    if (logicUpdates.length > 0) subPatch.flowLogics = { update: logicUpdates }
    if (nestedReorder.actions.length > 0) subPatch.actions = { update: nestedReorder.actions }
  } else if (parentUiId) {
    subPatch.flowLogics = { update: [{ uiUniqueIdentifier: parentUiId, type: "flowlogic" }] }
  }

  try {
    const result = await executeFlowPatchMutation(client, subPatch, subflowResponseFields)
    const callId = result?.subflows?.inserts?.[0]?.sysId
    steps.insert = { success: !!callId, callId, uuid }
    if (!callId) return { success: false, steps, error: "GraphQL subflow INSERT returned no ID" }
    return { success: true, callId, uiUniqueIdentifier: uuid, resolvedOrder, steps }
  } catch (e: any) {
    steps.insert = { success: false, error: e.message }
    return { success: false, steps, error: "GraphQL subflow INSERT failed: " + e.message }
  }
}

// ── GENERIC UPDATE/DELETE for any flow element ───────────────────────

const elementGraphQLMap: Record<string, { key: string; type: string; responseFields: string }> = {
  action: {
    key: "actions",
    type: "action",
    responseFields: "actions { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }",
  },
  trigger: {
    key: "triggerInstances",
    type: "trigger",
    responseFields: "triggerInstances { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }",
  },
  flowlogic: {
    key: "flowLogics",
    type: "flowlogic",
    responseFields: "flowLogics { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }",
  },
  subflow: {
    key: "subflows",
    type: "subflow",
    responseFields: "subflows { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }",
  },
  stage: {
    key: "stages",
    type: "stage",
    responseFields: "stages { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }",
  },
}

async function updateElementViaGraphQL(
  client: any,
  flowId: string,
  elementType: string,
  elementId: string,
  inputs: Record<string, string>,
  annotation?: string,
): Promise<{ success: boolean; steps?: any; error?: string }> {
  const config = elementGraphQLMap[elementType]
  if (!config) return { success: false, error: "Unknown element type: " + elementType }

  const updateInputs = Object.entries(inputs).map(([name, value]) => ({
    name,
    value: { schemaless: false, schemalessValue: "", value: String(value) },
  }))

  try {
    await executeFlowPatchMutation(
      client,
      {
        flowId,
        [config.key]: {
          update: [
            { uiUniqueIdentifier: elementId, type: config.type, inputs: updateInputs, comment: annotation || "" },
          ],
        },
      },
      config.responseFields,
    )
    return { success: true, steps: { element: elementId, type: elementType, inputs: updateInputs.map((i) => i.name) } }
  } catch (e: any) {
    return { success: false, error: e.message, steps: { element: elementId, type: elementType } }
  }
}

async function deleteElementViaGraphQL(
  client: any,
  flowId: string,
  elementType: string,
  elementIds: string[],
): Promise<{ success: boolean; steps?: any; error?: string }> {
  const config = elementGraphQLMap[elementType]
  if (!config) return { success: false, error: "Unknown element type: " + elementType }

  try {
    await executeFlowPatchMutation(
      client,
      {
        flowId,
        [config.key]: { delete: elementIds },
      },
      config.responseFields,
    )
    return { success: true, steps: { deleted: elementIds, type: elementType } }
  } catch (e: any) {
    return { success: false, error: e.message, steps: { elementIds, type: elementType } }
  }
}

const DEFAULT_STAGE_STATES = [
  { label: "Pending - has not started", name: "pending" },
  { label: "In progress", name: "in_progress" },
  { label: "Skipped", name: "skipped" },
  { label: "Completed", name: "complete" },
  { label: "Error", name: "error" },
]

async function addStageViaGraphQL(
  client: any,
  flowId: string,
  label: string,
  componentIndexes: number[],
  order: number,
  states?: { label: string; name: string }[],
  alwaysShow?: boolean,
): Promise<{
  success: boolean
  stageId?: string
  sysId?: string
  uiUniqueIdentifier?: string
  steps?: any
  error?: string
}> {
  const id = generateUUID()
  const stage = {
    stageId: id,
    label,
    value: label,
    type: "standard",
    duration: "1970-01-01 00:00:00",
    alwaysShow: alwaysShow !== false,
    order,
    componentIndexes,
    states: states || DEFAULT_STAGE_STATES,
  }

  try {
    const result = await executeFlowPatchMutation(
      client,
      { flowId, stages: { insert: [stage] } },
      "stages { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }",
    )
    const insert = result?.stages?.inserts?.[0]
    return {
      success: true,
      stageId: id,
      sysId: insert?.sysId,
      uiUniqueIdentifier: insert?.uiUniqueIdentifier,
      steps: { stage, graphql_result: result?.stages },
    }
  } catch (e: any) {
    return { success: false, error: e.message, steps: { stage } }
  }
}

async function updateStageViaGraphQL(
  client: any,
  flowId: string,
  stageId: string,
  fields: {
    label?: string
    componentIndexes?: number[]
    order?: number
    states?: { label: string; name: string }[]
    alwaysShow?: boolean
  },
): Promise<{ success: boolean; steps?: any; error?: string }> {
  const patch: any = { stageId }
  if (fields.label !== undefined) {
    patch.label = fields.label
    patch.value = fields.label
  }
  if (fields.componentIndexes !== undefined) patch.componentIndexes = fields.componentIndexes
  if (fields.order !== undefined) patch.order = fields.order
  if (fields.states !== undefined) patch.states = fields.states
  if (fields.alwaysShow !== undefined) patch.alwaysShow = fields.alwaysShow

  try {
    const result = await executeFlowPatchMutation(
      client,
      { flowId, stages: { update: [patch] } },
      "stages { inserts { sysId uiUniqueIdentifier __typename } updates deletes __typename }",
    )
    return { success: true, steps: { stageId, fields: Object.keys(fields), graphql_result: result?.stages } }
  } catch (e: any) {
    return { success: false, error: e.message, steps: { stageId } }
  }
}

async function createFlowViaProcessFlowAPI(
  client: any,
  params: {
    name: string
    description: string
    isSubflow: boolean
    runAs: string
    shouldActivate: boolean
    scope?: string
  },
): Promise<{
  success: boolean
  flowSysId?: string
  versionCreated?: boolean
  flowData?: any
  error?: string
  diagnostics?: any
}> {
  try {
    var flowResp = await client.post(
      "/api/now/processflow/flow",
      {
        access: "public",
        description: params.description || "",
        flowPriority: "MEDIUM",
        name: params.name,
        protection: "",
        runAs: params.runAs || "user",
        runWithRoles: { value: "", displayValue: "" },
        // sys_scope is resolved server-side from scopeName — leaving it empty
        // (the old behaviour for the default app) created the flow with scope
        // "None" instead of Global. Mirror what the Flow Designer UI sends for a
        // Global flow: scope/scopeName = "global", scopeDisplayName = "Global".
        scope: params.scope || "global",
        scopeName: params.scope || "global",
        scopeDisplayName: (params.scope || "global") === "global" ? "Global" : "",
        security: { can_read: true, can_write: true },
        status: "draft",
        type: params.isSubflow ? "subflow" : "flow",
        userHasRolesAssignedToFlow: true,
        active: false,
        deleted: false,
      },
      {
        params: {
          param_only_properties: "true",
          sysparm_transaction_scope: "global",
        },
      },
    )

    var flowResult = flowResp.data?.result?.data
    if (!flowResult?.id) {
      var errDetail = flowResp.data?.result?.errorMessage || "no flow id returned"
      return { success: false, error: "ProcessFlow API: " + errDetail }
    }

    var flowSysId = flowResult.id

    var versionCreated = false
    var versionCreateError: string | undefined
    try {
      await client.post(
        "/api/now/processflow/versioning/create_version",
        { item_sys_id: flowSysId, type: "Autosave", annotation: "", favorite: false },
        { params: { sysparm_transaction_scope: "global" } },
      )
      versionCreated = true
    } catch (vcErr: any) {
      versionCreateError = vcErr.message || "version creation failed"
    }

    return {
      success: true,
      flowSysId,
      versionCreated,
      flowData: flowResult,
      diagnostics: versionCreateError ? { version_create_error: versionCreateError } : undefined,
    }
  } catch (e: any) {
    var msg = e.message || ""
    try {
      msg += " — " + JSON.stringify(e.response?.data || "").substring(0, 200)
    } catch (_) {}
    return { success: false, error: "ProcessFlow API: " + msg }
  }
}

// ── resolve helpers ───────────────────────────────────────────────────

async function resolveFlowId(client: any, flowId: string): Promise<string> {
  if (isSysId(flowId)) return flowId

  // Strategy 1: Exact match on name
  var lookup = await client.get("/api/now/table/sys_hub_flow", {
    params: {
      sysparm_query: "name=" + flowId,
      sysparm_fields: "sys_id,name,active",
      sysparm_limit: 5,
    },
  })
  if (lookup.data.result && lookup.data.result.length > 0) {
    // Prefer active flows when multiple matches
    var activeMatch = lookup.data.result.find(function (f: any) {
      return f.active === "true"
    })
    return (activeMatch || lookup.data.result[0]).sys_id
  }

  // Strategy 2: Exact match on internal_name
  var internalName = sanitizeInternalName(flowId)
  var internalLookup = await client.get("/api/now/table/sys_hub_flow", {
    params: {
      sysparm_query: "internal_name=" + internalName,
      sysparm_fields: "sys_id,name,active",
      sysparm_limit: 5,
    },
  })
  if (internalLookup.data.result && internalLookup.data.result.length > 0) {
    var activeInternalMatch = internalLookup.data.result.find(function (f: any) {
      return f.active === "true"
    })
    return (activeInternalMatch || internalLookup.data.result[0]).sys_id
  }

  // Strategy 3: LIKE fallback on name and internal_name
  var likeLookup = await client.get("/api/now/table/sys_hub_flow", {
    params: {
      sysparm_query: "nameLIKE" + flowId + "^ORinternal_nameLIKE" + internalName,
      sysparm_fields: "sys_id,name,active",
      sysparm_limit: 10,
    },
  })
  if (likeLookup.data.result && likeLookup.data.result.length > 0) {
    var activeLikeMatch = likeLookup.data.result.find(function (f: any) {
      return f.active === "true"
    })
    return (activeLikeMatch || likeLookup.data.result[0]).sys_id
  }

  throw new SnowFlowError(
    ErrorType.NOT_FOUND,
    "Flow not found: '" + flowId + "'. Use the 'list' action to find available flows, or provide a sys_id.",
  )
}

// ── tool definition ────────────────────────────────────────────────────

export const toolDefinition: MCPToolDefinition = {
  name: "snow_manage_flow",
  description:
    "Complete Flow Designer lifecycle: create flows/subflows, add/update triggers and actions, list, get details, update, activate, deactivate, delete and publish. Use update_trigger to change an existing trigger (e.g. switch from record_created to record_create_or_update) without deleting the flow. " +
    "IMPORTANT: Flow elements (triggers, actions, flow logic, subflows) can ONLY be created/updated/deleted via this tool's GraphQL mutations. Direct Table API operations on sys_hub_action_instance, sys_hub_flow_logic, sys_hub_sub_flow_instance, sys_hub_trigger_instance will NOT work — these tables do not contain individual element records.",
  category: "automation",
  subcategory: "flow-designer",
  use_cases: ["flow-designer", "automation", "flow-management", "subflow"],
  complexity: "advanced",
  frequency: "high",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "create",
          "create_subflow",
          "list",
          "get",
          "update",
          "activate",
          "deactivate",
          "delete",
          "publish",
          "add_trigger",
          "update_trigger",
          "delete_trigger",
          "add_action",
          "update_action",
          "delete_action",
          "add_flow_logic",
          "update_flow_logic",
          "delete_flow_logic",
          "add_subflow",
          "update_subflow",
          "delete_subflow",
          "add_flow_variable",
          "add_stage",
          "update_stage",
          "delete_stage",
          "open_flow",
          "checkout",
          "close_flow",
          "force_unlock",
          "check_execution",
        ],
        description:
          "Action to perform. " +
          "CREATE FLOW: 'create' builds the flow AND its trigger in one call when trigger_type is provided. " +
          "Skip add_trigger afterwards — calling it on a flow that already has a trigger now returns a clear error pointing you at update_trigger or add_action. " +
          "Only call add_trigger when you originally created the flow without a trigger_type. " +
          "The editing lock stays open after create, so you can immediately call add_action, add_flow_logic, etc. " +
          "EDIT EXISTING FLOWS: call checkout (or open_flow) first to acquire the editing lock. Mutation actions (add_action, add_subflow, etc.) also auto-acquire the lock if not already held. " +
          "ALWAYS call close_flow as the LAST step to release the lock. " +
          'LOCK RECOVERY: If open_flow fails with "locked by another user", use force_unlock first to clear ghost locks, then retry open_flow. ' +
          "Validation errors like 'Missing required parameter' are NOT lock issues — they mean a parameter is missing, not that the flow is locked; do not chase them with force_unlock. " +
          "add_*/update_*/delete_* for triggers, actions, flow_logic, subflows, stages. update_trigger replaces the trigger type. delete_* removes elements by element_id. " +
          "add_stage/update_stage/delete_stage for stage management (visual progress grouping of actions). Stages use componentIndexes to map which actions belong to each stage. " +
          "Flow variable operations (set_flow_variable, append, get_output) are flow LOGIC — use add_flow_logic, not add_action. " +
          "'check_execution' queries sys_flow_context and sys_hub_flow_run for execution status/errors/outputs — use after activating to verify the flow runs correctly.",
      },

      flow_id: {
        type: "string",
        description: "Flow sys_id or name (required for get, update, activate, deactivate, delete, publish)",
      },

      name: {
        type: "string",
        description: "Flow name (required for create / create_subflow)",
      },
      description: {
        type: "string",
        description: "Flow description",
      },
      trigger_type: {
        type: "string",
        description:
          "Trigger type - looked up dynamically in sys_hub_trigger_definition. Common values: record_create, record_update, record_create_or_update, scheduled, manual (default: manual)",
        default: "manual",
      },
      table: {
        type: "string",
        description:
          'Table for record-based triggers (e.g. "incident") or list filter. Also accepted as "trigger_table".',
      },
      trigger_table: {
        type: "string",
        description: 'Alias for "table" — table for record-based triggers (e.g. "incident")',
      },
      action_table: {
        type: "string",
        description:
          'Shorthand for setting the table input on an action (e.g. "incident" for create_record/update_record/lookup_record). Injected as the "table" input.',
      },
      action_field_values: {
        type: "object",
        description: 'Alias for "action_inputs" — key-value pairs for action inputs. Same behavior as action_inputs.',
      },
      trigger_condition: {
        type: "string",
        description: "Encoded query condition for the trigger",
      },
      category: {
        type: "string",
        description: "Flow category",
        default: "custom",
      },
      run_as: {
        type: "string",
        enum: ["user", "system"],
        description: "Run-as context (default: user)",
        default: "user",
      },
      activities: {
        type: "array",
        description: "Flow action steps",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Step name" },
            type: {
              type: "string",
              description:
                'Action type - looked up dynamically in sys_hub_action_type_snapshot by internal_name or name. Common values: log, create_record, update_record, lookup_record, delete_record, send_notification, field_update, wait, create_approval. Note: there is NO generic "script" action in Flow Designer — use a subflow or business rule for custom scripts.',
            },
            inputs: { type: "object", description: "Step-specific input values" },
          },
        },
      },
      inputs: {
        type: "array",
        description: "Flow input variables",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            label: { type: "string" },
            type: { type: "string", enum: ["string", "integer", "boolean", "reference", "object", "array"] },
            mandatory: { type: "boolean" },
            default_value: { type: "string" },
          },
        },
      },
      outputs: {
        type: "array",
        description: "Flow output variables",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            label: { type: "string" },
            type: { type: "string", enum: ["string", "integer", "boolean", "reference", "object", "array"] },
          },
        },
      },
      activate: {
        type: "boolean",
        description: "Activate flow after creation (default: true)",
        default: true,
      },
      logic_type: {
        type: "string",
        description:
          "Flow logic type for add_flow_logic. Looked up dynamically in sys_hub_flow_logic_definition. " +
          "Common aliases (FOR_EACH, DO_UNTIL, etc.) are auto-normalized to ServiceNow types. Available types: " +
          "IF, ELSEIF, ELSE — conditional branching. Use ELSEIF (not nested ELSE+IF) for else-if branches. ELSE and ELSEIF require connected_to set to the If block's uiUniqueIdentifier. " +
          "FOREACH (or FOR_EACH), DOUNTIL (or DO_UNTIL) — loops. CONTINUE (skip iteration) and BREAK (exit loop) can be used inside loops. " +
          "PARALLEL — execute branches in parallel. " +
          "DECISION — switch/decision table. " +
          "TRY — error handling (try/catch). " +
          "END — End Flow (stops execution). Always add END as the last element when the flow should terminate cleanly. " +
          "TIMER — Wait for a duration of time. " +
          "GOBACKTO (or GO_BACK_TO) — jump back to a previous step. " +
          "SETFLOWVARIABLES, APPENDFLOWVARIABLES, GETFLOWOUTPUT — flow variable management. " +
          "WORKFLOW — call a legacy workflow. DYNAMICFLOW — dynamically invoke a flow. " +
          "Best practice: add an END element at the end of your flow for clean termination.",
      },
      logic_inputs: {
        type: "object",
        description:
          "Input values for the flow logic block. For IF/ELSEIF, prefer using the dedicated condition parameter instead.",
      },
      condition: {
        type: "string",
        description:
          "Condition for IF/ELSEIF flow logic. Accepts multiple formats (all auto-converted to Flow Designer pill format): " +
          '"priority<=2" (encoded query), ' +
          '"trigger.current.priority <= 2" (dot notation), ' +
          '"{{trigger.current.priority}}<=2" (shorthand pill), ' +
          '"category=software^priority!=1" (multi-clause). ' +
          "Spaces around operators are auto-removed. Single `=` works the same as `==` or `===`. " +
          "Operators: = != > < >= <= LIKE STARTSWITH ENDSWITH ISEMPTY ISNOTEMPTY. " +
          'Combine with ^ (AND) or ^OR (OR). Word operators also accepted: "equals", "not equals", "contains", "starts with", "is empty".',
      },
      condition_name: {
        type: "string",
        description:
          'REQUIRED for IF/ELSEIF: display label for the condition shown in Flow Designer UI (e.g. "Check if P1 or P2 Incident"). Falls back to annotation if not provided. Accepts alias logic_name.',
      },
      parent_ui_id: {
        type: "string",
        description:
          "Parent UI unique identifier for nesting elements inside flow logic blocks. REQUIRED for placing actions/subflows inside an If/Else block — get this from the `uiUniqueIdentifier` in the add_flow_logic response. The response also includes a `next_step.for_child` hint with the exact value to use.",
      },
      connected_to: {
        type: "string",
        description:
          "REQUIRED for ELSE blocks: the uiUniqueIdentifier of the If block this Else is connected to. Unlike parent_ui_id (which nests elements inside a block), connected_to links sibling blocks like Else to their If. Get this from the `connected_to_value` in the IF block's add_flow_logic response.",
      },
      subflow_id: {
        type: "string",
        description:
          "Subflow sys_id or name to call as a step (for add_subflow action). Looked up in sys_hub_flow where type=subflow.",
      },
      element_id: {
        type: "string",
        description:
          "Element sys_id or uiUniqueIdentifier for update_*/delete_* actions. For delete_* this can also be a comma-separated list of IDs.",
      },
      order: {
        type: "number",
        description:
          "GLOBAL position/order of the element in the flow (for add_* actions). If omitted, auto-calculated from current flow state. Previous response includes `next_order` — use that value for top-level elements. Do NOT guess order numbers. Flow Designer uses global sequential ordering across ALL elements (1, 2, 3...). For nested elements inside TRY/CATCH/IF blocks, order is computed automatically when parent_ui_id is set — the CATCH block and subsequent elements are shifted forward to make room.",
      },
      type: {
        type: "string",
        enum: ["flow", "subflow", "all"],
        description: "Filter by type (list only, default: all)",
        default: "all",
      },
      active_only: {
        type: "boolean",
        description: "Only list active flows (default: true)",
        default: true,
      },
      limit: {
        type: "number",
        description: "Max results for list",
        default: 50,
      },
      action_type: {
        type: "string",
        description:
          'Action type to add (for add_action). Looked up dynamically by internal_name or name in sys_hub_action_type_snapshot and sys_hub_action_type_definition. Common short names: log, create_record, update_record, lookup_record, delete_record, notification, field_update, wait, approval. You can also use the exact ServiceNow internal name (e.g. "global.update_record") or display name (e.g. "Update Record"). If omitted, action_name is used as the lookup key. Use "Subflow" with subflow_id to add a subflow call. NOTE: there is NO generic "script" or "run_script" action — use a subflow for custom logic. Flow variable operations (set_flow_variable, append_flow_variable, get_flow_output) are flow LOGIC — use add_flow_logic instead.',
        default: "log",
      },
      action_name: {
        type: "string",
        description:
          'Display name / type for the action (for add_action). If action_type is not specified, action_name is used to look up the action definition. Accepts display names like "Update Record", "Ask for Approval", "Log", "Create Record", "Subflow", etc.',
      },
      spoke: {
        type: "string",
        description:
          'Spoke/scope filter for action lookup (for add_action). Use to disambiguate when multiple spokes have actions with the same name (e.g. "global" for core actions, "spoke-specific" for spoke-specific Spoke actions). Matched against sys_scope and sys_package fields.',
      },
      action_inputs: {
        type: "object",
        description:
          'Key-value pairs for action inputs (also accepted as "action_config", "action_field_values", "inputs", or "config"). Keys are fuzzy-matched to ServiceNow parameter element names — you can use short names like "to" instead of "ah_to", "subject" instead of "ah_subject", "table" instead of "table_name", "message" instead of "log_message". Use `next_order` from the previous response for sequential ordering. Example: {to: "admin@example.com", subject: "Alert", body: "Incident created"}',
      },
      display_text: {
        type: "string",
        description:
          'Optional custom label for an action step, shown on the Flow Designer canvas (for add_action). Defaults to the action type name when omitted. Example: "Log high priority".',
      },
      variable_name: {
        type: "string",
        description:
          "Name of the user flow variable to add to an existing flow (for add_flow_variable). Flow inputs are trigger-derived and cannot be added this way.",
      },
      variable_label: {
        type: "string",
        description: "Display label for the flow variable (for add_flow_variable). Defaults to variable_name.",
      },
      variable_type: {
        type: "string",
        description:
          "Type of the flow variable (for add_flow_variable): string, integer, boolean, reference, etc. Default: string.",
      },
      update_fields: {
        type: "object",
        description: "Fields to update (for update action)",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          category: { type: "string" },
          run_as: { type: "string" },
        },
      },
      update_set_id: {
        type: "string",
        description:
          "[write actions] Explicit update set sys_id to switch to before making changes. Only used when ensure_update_set=true.",
      },
      update_set_name: {
        type: "string",
        description:
          '[write actions] Name for auto-created update set (default: "Serac: Flow Designer changes"). Only used when ensure_update_set=true and no update_set_id provided.',
        default: "Serac: Flow Designer changes",
      },
      ensure_update_set: {
        type: "boolean",
        description:
          "[write actions] Opt-in: ensure an update set is active before making changes. When true, switches to or creates an update set for change tracking. Default: false (no update set tracking).",
        default: false,
      },
      application_scope: {
        type: "string",
        description:
          '[create/create_subflow] Application scope for the new flow. Default: "global". Provide a scope name (e.g. "x_myco_app") to create in a scoped application.',
        default: "global",
      },
      force_unlock_all: {
        type: "boolean",
        description:
          "[force_unlock] Admin override: delete ALL locks including those < 5 minutes old. Without this, young locks are skipped (they may belong to an active user). Default: false.",
        default: false,
      },
      annotation: {
        type: "string",
        description:
          "Optional human-readable comment describing what this element does and why. " +
          "Sent as the 'comment' field in the Flow Designer GraphQL mutation; defaults to empty string when omitted. " +
          "Special case: for add_flow_logic with logic_type IF or ELSEIF, ServiceNow needs a condition label — " +
          "provide condition_name explicitly, or annotation will be used as a fallback.",
      },
      verify: {
        type: "boolean",
        description:
          "Verify mutations via processflow API after GraphQL operations. " +
          "Reads the real-time flow state to confirm changes took effect. " +
          "Adds ~200ms latency per mutation. Recommended for debugging or critical flows.",
        default: false,
      },
      stage_label: {
        type: "string",
        description:
          "Label for the stage (for add_stage, update_stage). The display name shown in the flow's progress indicator.",
      },
      stage_component_indexes: {
        type: "array",
        items: { type: "number" },
        description:
          "Array of action order indexes (0-based) that belong to this stage (for add_stage, update_stage). " +
          "These correspond to the positional indexes of actions in the flow. " +
          "Example: [0, 1] means the first two actions belong to this stage.",
      },
      stage_order: {
        type: "number",
        description:
          "Order of the stage in the stage list (0-based, for add_stage). " +
          "Stages have their own ordering separate from the global action order. " +
          "If omitted, defaults to 0.",
      },
      stage_states: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Display label (e.g. 'Pending - has not started')" },
            name: {
              type: "string",
              description: "State name (e.g. 'pending', 'in_progress', 'skipped', 'complete', 'error')",
            },
          },
        },
        description:
          "Custom stage states (for add_stage, update_stage). " +
          "Defaults to 5 standard states: pending, in_progress, skipped, complete, error. " +
          "Only provide this if you need non-standard states.",
      },
      stage_always_show: {
        type: "boolean",
        description: "Whether the stage is always visible in the progress indicator (default: true).",
        default: true,
      },
    },
    required: ["action"],
  },
}

// ── execute ────────────────────────────────────────────────────────────

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var action = args.action

  // ── Centralized input validation ──
  var REQUIRED_PARAMS: Record<string, string[]> = {
    create: ["name"],
    create_subflow: ["name"],
    list: [],
    get: ["flow_id"],
    update: ["flow_id", "update_fields"],
    activate: ["flow_id"],
    publish: ["flow_id"],
    deactivate: ["flow_id"],
    delete: ["flow_id"],
    // `annotation` was previously required on every add_* action, but
    // the handlers all fall through to `annotation || ""` — it's a
    // human-readable comment for the Flow Designer UI, not a functional
    // input. Requiring it caused agents to fail mid-build and misread
    // the validation error as a lock problem. add_flow_logic still has
    // a narrower IF/ELSEIF check downstream (condition_name or
    // annotation fallback); that one stays.
    add_trigger: ["flow_id"],
    update_trigger: ["flow_id"],
    delete_trigger: ["flow_id", "element_id"],
    add_action: ["flow_id"],
    update_action: ["flow_id", "element_id"],
    delete_action: ["flow_id", "element_id"],
    add_flow_logic: ["flow_id", "logic_type"],
    update_flow_logic: ["flow_id", "element_id"],
    delete_flow_logic: ["flow_id", "element_id"],
    add_subflow: ["flow_id", "subflow_id"],
    add_flow_variable: ["flow_id", "variable_name"],
    update_subflow: ["flow_id", "element_id"],
    delete_subflow: ["flow_id", "element_id"],
    add_stage: ["flow_id", "stage_label", "stage_component_indexes"],
    update_stage: ["flow_id", "element_id"],
    delete_stage: ["flow_id", "element_id"],
    open_flow: ["flow_id"],
    close_flow: ["flow_id"],
    force_unlock: ["flow_id"],
    check_execution: ["flow_id"],
  }

  var requiredParams = REQUIRED_PARAMS[action]
  if (requiredParams && requiredParams.length > 0) {
    var missingParams = requiredParams.filter(function (p: string) {
      return args[p] === undefined || args[p] === null || args[p] === ""
    })
    if (missingParams.length > 0) {
      return createErrorResult(
        new SnowFlowError(
          ErrorType.VALIDATION_ERROR,
          "Missing required parameter(s) for '" +
            action +
            "': " +
            missingParams.join(", ") +
            ". Provide these parameters and try again.",
        ),
      )
    }
  }

  try {
    var client = await getAuthenticatedClient(context)

    // ── Update Set tracking (opt-in via ensure_update_set=true) ──
    var WRITE_ACTIONS = [
      "create",
      "create_subflow",
      "update",
      "activate",
      "deactivate",
      "delete",
      "publish",
      "add_trigger",
      "update_trigger",
      "delete_trigger",
      "add_action",
      "update_action",
      "delete_action",
      "add_flow_logic",
      "update_flow_logic",
      "delete_flow_logic",
      "add_subflow",
      "update_subflow",
      "delete_subflow",
      "add_flow_variable",
      "add_stage",
      "update_stage",
      "delete_stage",
    ]
    var updateSetCtx: { updateSetId?: string; updateSetName?: string; warning?: string } = {}
    if (WRITE_ACTIONS.indexOf(action) !== -1) {
      updateSetCtx = await ensureUpdateSetForFlow(client, args)
    }

    switch (action) {
      // ────────────────────────────────────────────────────────────────
      // CREATE
      // ────────────────────────────────────────────────────────────────
      case "create":
      case "create_subflow": {
        var flowName = args.name
        var isSubflow = action === "create_subflow"
        var flowDescription = args.description || flowName
        var triggerType = isSubflow ? "manual" : args.trigger_type || "manual"
        var flowTable = args.table || args.trigger_table || ""
        var triggerCondition = args.trigger_condition || ""
        var flowCategory = args.category || "custom"
        var flowRunAs = isSubflow ? "user_who_calls" : args.run_as || "user"
        var applicationScope = args.application_scope || "global"
        var activitiesArg = args.activities || []
        var inputsArg = args.inputs || []
        var outputsArg = args.outputs || []
        var shouldActivate = args.activate !== false

        // Build flow_definition JSON (shared by both methods)
        var flowDefinition: any = {
          name: flowName,
          description: flowDescription,
          trigger: {
            type: triggerType,
            table: flowTable,
            condition: triggerCondition,
          },
          activities: activitiesArg.map(function (act: any, idx: number) {
            return {
              name: act.name,
              label: act.name,
              type: act.type || "script",
              inputs: act.inputs || {},
              order: (idx + 1) * 100,
              active: true,
            }
          }),
          inputs: inputsArg.map(function (inp: any) {
            return {
              name: inp.name,
              label: inp.label || inp.name,
              type: inp.type || "string",
              mandatory: inp.mandatory || false,
              default_value: inp.default_value || "",
            }
          }),
          outputs: outputsArg.map(function (out: any) {
            return {
              name: out.name,
              label: out.label || out.name,
              type: out.type || "string",
            }
          }),
          version: "1.0",
        }

        if (isSubflow) {
          delete flowDefinition.trigger
        }

        // ── Pipeline: ProcessFlow API (primary) → Table API (fallback) ──
        var flowSysId: string | null = null
        var usedMethod = "table_api"
        var versionCreated = false
        var factoryWarnings: string[] = []
        var triggerCreated = false
        var actionsCreated = 0
        var varsCreated = 0

        // Diagnostics
        var diagnostics: any = {
          processflow_api: null,
          table_api_used: false,
          version_created: false,
          version_method: null,
          post_verify: null,
        }

        // ── ProcessFlow API (primary — same REST endpoint as Flow Designer UI) ──
        // Uses /api/now/processflow/flow to create engine-registered flows,
        // then /api/now/processflow/versioning/create_version for versioning.
        try {
          var pfResult = await createFlowViaProcessFlowAPI(client, {
            name: flowName,
            description: flowDescription,
            isSubflow: isSubflow,
            runAs: flowRunAs,
            shouldActivate: shouldActivate,
            scope: applicationScope,
          })
          diagnostics.processflow_api = {
            success: pfResult.success,
            versionCreated: pfResult.versionCreated,
            error: pfResult.error,
            version_create_error: pfResult.diagnostics?.version_create_error,
          }
          if (pfResult.success && pfResult.flowSysId) {
            flowSysId = pfResult.flowSysId
            usedMethod = "processflow_api"
            versionCreated = !!pfResult.versionCreated
            diagnostics.version_created = versionCreated
            diagnostics.version_method = "processflow_api"
          }
        } catch (pfErr: any) {
          diagnostics.processflow_api = { error: pfErr.message || "unknown" }
          factoryWarnings.push("ProcessFlow API failed: " + (pfErr.message || pfErr))
        }

        // ── Triggers, actions, variables for ProcessFlow-created flows ──
        // ProcessFlow API POST establishes an editing context but may not persist a
        // sys_hub_flow_safe_edit record. Explicitly acquire the lock to ensure
        // close_flow (safeEdit delete) will succeed later.
        if (flowSysId && usedMethod === "processflow_api") {
          var pfLock = await acquireFlowEditingLock(client, flowSysId)
          diagnostics.processflow_lock = { acquired: pfLock.success, debug: pfLock.debug }
          if (!pfLock.success) {
            factoryWarnings.push(
              "Editing lock not confirmed for ProcessFlow-created flow: " + (pfLock.error || "unknown"),
            )
          }
          if (!isSubflow && triggerType !== "manual") {
            try {
              var pfTrigResult = await addTriggerViaGraphQL(client, flowSysId, triggerType, flowTable, triggerCondition)
              triggerCreated = pfTrigResult.success
              diagnostics.trigger_graphql = pfTrigResult
            } catch (pfTrigErr: any) {
              diagnostics.trigger_graphql_error = pfTrigErr.message || "trigger creation failed"
            }
          }
          for (var pfai = 0; pfai < activitiesArg.length; pfai++) {
            try {
              var pfAct = activitiesArg[pfai]
              var pfActResult = await addActionViaGraphQL(
                client,
                flowSysId,
                pfAct.type || "log",
                pfAct.name || "Action " + (pfai + 1),
                pfAct.inputs || pfAct.action_inputs || pfAct.action_config || pfAct.config,
                undefined,
                pfai + 1,
              )
              if (pfActResult.success) actionsCreated++
              diagnostics["action_" + pfai] = pfActResult
            } catch (pfActErr: any) {
              diagnostics["action_" + pfai + "_graphql_error"] = pfActErr.message || "action creation failed"
            }
          }
          if (isSubflow) {
            for (var pfvi = 0; pfvi < inputsArg.length; pfvi++) {
              try {
                var pfInp = inputsArg[pfvi]
                await client.post("/api/now/table/sys_hub_flow_variable", {
                  flow: flowSysId,
                  name: pfInp.name,
                  label: pfInp.label || pfInp.name,
                  type: pfInp.type || "string",
                  mandatory: pfInp.mandatory || false,
                  default_value: pfInp.default_value || "",
                  variable_type: "input",
                })
                varsCreated++
              } catch (e: any) {
                console.warn("[snow_manage_flow] create: input variable creation failed: " + (e.message || ""))
              }
            }
            for (var pfvo = 0; pfvo < outputsArg.length; pfvo++) {
              try {
                var pfOut = outputsArg[pfvo]
                await client.post("/api/now/table/sys_hub_flow_variable", {
                  flow: flowSysId,
                  name: pfOut.name,
                  label: pfOut.label || pfOut.name,
                  type: pfOut.type || "string",
                  variable_type: "output",
                })
                varsCreated++
              } catch (e: any) {
                console.warn("[snow_manage_flow] create: output variable creation failed: " + (e.message || ""))
              }
            }
          }
        }

        // ── Table API fallback (last resort) ─────────────────────────
        if (!flowSysId) {
          diagnostics.table_api_used = true
          var flowData: any = {
            name: flowName,
            description: flowDescription,
            active: shouldActivate,
            internal_name: sanitizeInternalName(flowName),
            category: flowCategory,
            run_as: flowRunAs,
            status: shouldActivate ? "published" : "draft",
            type: isSubflow ? "subflow" : "flow",
            scope: applicationScope !== "global" ? applicationScope : undefined,
            // Do NOT set flow_definition or latest_snapshot on flow record
            // Reference flow analysis: flow_definition=null, latest_snapshot=version sys_id
          }

          var flowResponse = await client.post("/api/now/table/sys_hub_flow", flowData)
          var createdFlow = flowResponse.data.result
          flowSysId = createdFlow.sys_id

          // Create sys_hub_flow_version via Table API (critical for Flow Designer UI)
          // Strategy: INSERT as draft → UPDATE to published/compiled
          // The UPDATE triggers Business Rules that compile the flow and set latest_version
          try {
            // Step 1: INSERT version as DRAFT (minimal fields)
            var versionInsertData: any = {
              flow: flowSysId,
              name: "1.0",
              version: "1.0",
              state: "draft",
              active: false,
              compile_state: "draft",
              is_current: false,
              internal_name: sanitizeInternalName(flowName) + "_v1_0",
            }
            var versionResp = await client.post("/api/now/table/sys_hub_flow_version", versionInsertData)
            var versionSysId = versionResp.data.result?.sys_id

            if (versionSysId) {
              // Step 2: UPDATE version → triggers compilation Business Rules
              // Use compile_state "pending" instead of "compiled" — let the server compile it
              var versionUpdateData: any = {
                state: shouldActivate ? "published" : "draft",
                active: true,
                compile_state: "pending",
                is_current: true,
                flow_definition: JSON.stringify(flowDefinition),
              }
              if (shouldActivate) versionUpdateData.published_flow = flowSysId
              try {
                await client.patch("/api/now/table/sys_hub_flow_version/" + versionSysId, versionUpdateData)
              } catch (updateErr: any) {
                diagnostics.version_update_error = updateErr.message || "unknown"
              }

              // Step 2b: Verify actual compile state after PATCH
              try {
                var compileCheckResp = await client.get("/api/now/table/sys_hub_flow_version/" + versionSysId, {
                  params: { sysparm_fields: "compile_state,state" },
                })
                var actualCompileState = compileCheckResp.data.result?.compile_state || "unknown"
                diagnostics.actual_compile_state = actualCompileState
                if (actualCompileState !== "compiled" && actualCompileState !== "pending") {
                  factoryWarnings.push(
                    "Version compile_state is '" +
                      actualCompileState +
                      "' — flow may need manual compilation in Flow Designer",
                  )
                }
              } catch (_) {
                diagnostics.compile_state_check = "failed"
              }

              versionCreated = true
              diagnostics.version_created = true
              diagnostics.version_method = "table_api (draft→update)"

              // Set latest_snapshot on flow record to version sys_id (reference field)
              try {
                await client.patch("/api/now/table/sys_hub_flow/" + flowSysId, {
                  latest_snapshot: versionSysId,
                })
                diagnostics.latest_snapshot_set = versionSysId
              } catch (snapshotErr: any) {
                diagnostics.latest_snapshot_error = snapshotErr.message || "unknown"
              }
            }
          } catch (verError: any) {
            factoryWarnings.push("sys_hub_flow_version creation failed: " + (verError.message || verError))
          }

          try {
            await client.get("/api/now/processflow/flow/" + flowSysId)
          } catch (_) {
            /* best-effort — registers flow with ProcessFlow engine */
          }
          var taLock = await acquireFlowEditingLock(client, flowSysId!)
          diagnostics.table_api_lock = { acquired: taLock.success, debug: taLock.debug }
          if (!taLock.success) {
            factoryWarnings.push(
              "Could not acquire editing lock for Table API flow — triggers/actions may fail: " +
                (taLock.error || "unknown"),
            )
          }

          // Create trigger via GraphQL (same method as Flow Designer UI)
          if (!isSubflow && triggerType !== "manual") {
            try {
              var taTrigResult = await addTriggerViaGraphQL(
                client,
                flowSysId!,
                triggerType,
                flowTable,
                triggerCondition,
              )
              triggerCreated = taTrigResult.success
              diagnostics.trigger_graphql = taTrigResult
            } catch (triggerError) {
              // Best-effort
            }
          }

          // Create actions via GraphQL (same method as Flow Designer UI)
          for (var ai = 0; ai < activitiesArg.length; ai++) {
            var activity = activitiesArg[ai]
            try {
              var taActResult = await addActionViaGraphQL(
                client,
                flowSysId!,
                activity.type || "log",
                activity.name || "Action " + (ai + 1),
                activity.inputs || activity.action_inputs || activity.action_config || activity.config,
                undefined,
                ai + 1,
              )
              if (taActResult.success) actionsCreated++
              diagnostics["action_" + ai] = taActResult
            } catch (actError) {
              // Best-effort
            }
          }

          // Create flow variables (subflows)
          if (isSubflow) {
            for (var vi = 0; vi < inputsArg.length; vi++) {
              var inp = inputsArg[vi]
              try {
                await client.post("/api/now/table/sys_hub_flow_variable", {
                  flow: flowSysId,
                  name: inp.name,
                  label: inp.label || inp.name,
                  type: inp.type || "string",
                  mandatory: inp.mandatory || false,
                  default_value: inp.default_value || "",
                  variable_type: "input",
                })
                varsCreated++
              } catch (varError: any) {
                console.warn(
                  "[snow_manage_flow] create: input variable (table API) failed: " + (varError.message || ""),
                )
              }
            }
            for (var vo = 0; vo < outputsArg.length; vo++) {
              var out = outputsArg[vo]
              try {
                await client.post("/api/now/table/sys_hub_flow_variable", {
                  flow: flowSysId,
                  name: out.name,
                  label: out.label || out.name,
                  type: out.type || "string",
                  variable_type: "output",
                })
                varsCreated++
              } catch (varError: any) {
                console.warn(
                  "[snow_manage_flow] create: output variable (table API) failed: " + (varError.message || ""),
                )
              }
            }
          }
        }

        // Engine REST registration skipped — all sn_fd endpoints return 400 on this instance type

        // ── Post-creation verification ─────────────────────────────
        if (flowSysId) {
          try {
            var verifyResp = await client.get("/api/now/table/sys_hub_flow/" + flowSysId, {
              params: {
                sysparm_fields: "sys_id,name,latest_version,latest_published_version,internal_name",
                sysparm_display_value: "false",
              },
            })
            var verifyFlow = verifyResp.data.result
            var latestVersionVal = verifyFlow?.latest_version || null
            var hasLatestVersion = !!latestVersionVal

            // Check version record details
            var verCheckResp = await client.get("/api/now/table/sys_hub_flow_version", {
              params: {
                sysparm_query: "flow=" + flowSysId,
                sysparm_fields: "sys_id,name,state,compile_state,is_current,active,internal_name",
                sysparm_limit: 1,
              },
            })
            var verRecords = verCheckResp.data.result || []
            var hasVersionRecord = verRecords.length > 0

            diagnostics.post_verify = {
              flow_exists: true,
              flow_internal_name: verifyFlow?.internal_name || "not set",
              latest_version_value: latestVersionVal || "null",
              latest_published_version: verifyFlow?.latest_published_version || "null",
              has_latest_version_ref: hasLatestVersion,
              version_record_exists: hasVersionRecord,
              version_details: hasVersionRecord
                ? {
                    sys_id: verRecords[0].sys_id,
                    state: verRecords[0].state,
                    compile_state: verRecords[0].compile_state,
                    is_current: verRecords[0].is_current,
                    active: verRecords[0].active,
                    internal_name: verRecords[0].internal_name || "not set",
                  }
                : null,
            }

            // If latest_version still not set and version exists, try one more time
            if (!hasLatestVersion && hasVersionRecord) {
              try {
                await client.patch("/api/now/table/sys_hub_flow/" + flowSysId, {
                  latest_version: verRecords[0].sys_id,
                  latest_published_version: shouldActivate ? verRecords[0].sys_id : undefined,
                })
                // Readback
                var finalCheck = await client.get("/api/now/table/sys_hub_flow/" + flowSysId, {
                  params: { sysparm_fields: "latest_version", sysparm_display_value: "false" },
                })
                diagnostics.post_verify.latest_version_final = finalCheck.data.result?.latest_version || "still null"
              } catch (finalLinkErr: any) {
                diagnostics.post_verify.latest_version_final_error = finalLinkErr.message || "unknown"
              }
            }
          } catch (verifyErr: any) {
            diagnostics.post_verify = { error: verifyErr.message || "verification failed" }
          }
        }

        // ── Build summary ───────────────────────────────────────────
        var methodLabel =
          usedMethod === "processflow_api"
            ? "ProcessFlow API (Flow Designer engine)"
            : "Table API" + (factoryWarnings.length > 0 ? " (fallback)" : "")

        var createSummary = summary()
          .success("Created " + (isSubflow ? "subflow" : "flow") + ": " + flowName)
          .field("sys_id", flowSysId!)
          .field("Type", isSubflow ? "Subflow" : "Flow")
          .field("Category", flowCategory)
          .field("Status", shouldActivate ? "Published (active)" : "Draft")
          .field("Method", methodLabel)

        if (diagnostics.factory_namespace) {
          createSummary.field("Namespace", diagnostics.factory_namespace)
        }

        if (versionCreated) {
          createSummary.field(
            "Version",
            "v1.0 created" + (diagnostics.version_method ? " (" + diagnostics.version_method + ")" : ""),
          )
        } else {
          createSummary.warning('Version record NOT created — flow may show "cannot be found" in Flow Designer')
        }

        if (!isSubflow && triggerType !== "manual") {
          createSummary.field("Trigger", triggerType + (triggerCreated ? " (created)" : " (best-effort)"))
          if (flowTable) createSummary.field("Table", flowTable)
        }
        if (activitiesArg.length > 0) {
          createSummary.field("Actions", actionsCreated + "/" + activitiesArg.length + " created")
        }
        if (varsCreated > 0) {
          createSummary.field("Variables", varsCreated + " created")
        }
        for (var wi = 0; wi < factoryWarnings.length; wi++) {
          createSummary.warning(factoryWarnings[wi])
        }

        // Diagnostics section
        createSummary.blank().line("Diagnostics:")
        if (diagnostics.processflow_api) {
          var pf = diagnostics.processflow_api
          createSummary.indented(
            "ProcessFlow API: " + (pf.success ? "success" : "failed") + (pf.versionCreated ? " (version created)" : ""),
          )
          if (pf.error) createSummary.indented("  Error: " + pf.error)
        }
        createSummary.indented("Table API fallback used: " + diagnostics.table_api_used)
        createSummary.indented(
          "Version created: " +
            diagnostics.version_created +
            (diagnostics.version_method ? " (" + diagnostics.version_method + ")" : ""),
        )
        if (diagnostics.post_verify) {
          if (diagnostics.post_verify.error) {
            createSummary.indented("Post-verify: error — " + diagnostics.post_verify.error)
          } else {
            createSummary.indented(
              "Post-verify: flow=" +
                diagnostics.post_verify.flow_exists +
                ", version_record=" +
                diagnostics.post_verify.version_record_exists +
                ", latest_version_ref=" +
                diagnostics.post_verify.has_latest_version_ref,
            )
          }
        }

        // NOTE: Do NOT release the editing lock here. The agent may need to add more elements
        // (flow logic, actions, etc.) after creation. The agent must call close_flow when done.

        return createSuccessResult(
          withUpdateSetContext(
            {
              created: true,
              method: usedMethod,
              version_created: versionCreated,
              flow: {
                sys_id: flowSysId,
                name: flowName,
                type: isSubflow ? "subflow" : "flow",
                category: flowCategory,
                active: shouldActivate,
                status: shouldActivate ? "published" : "draft",
              },
              trigger:
                !isSubflow && triggerType !== "manual"
                  ? {
                      type: triggerType,
                      table: flowTable,
                      condition: triggerCondition,
                      created: triggerCreated,
                    }
                  : null,
              activities_created: actionsCreated,
              activities_requested: activitiesArg.length,
              variables_created: varsCreated,
              warnings: factoryWarnings.length > 0 ? factoryWarnings : undefined,
              diagnostics: diagnostics,
              lock_acquired_at: new Date().toISOString(),
              lock_warning:
                "IMPORTANT: Editing lock is held. You MUST call close_flow with flow_id='" +
                flowSysId +
                "' when done editing.",
              next_step:
                "Flow is now open for editing." +
                (triggerCreated
                  ? " Trigger (" + triggerType + ") is already set up — do NOT call add_trigger again."
                  : "") +
                (actionsCreated > 0 ? " " + actionsCreated + " action(s) already added." : "") +
                " Add more elements with add_action/add_flow_logic. When DONE, call close_flow with flow_id='" +
                flowSysId +
                "' to release the editing lock.",
            },
            updateSetCtx,
          ),
          {},
          createSummary.build(),
        )
      }

      // ────────────────────────────────────────────────────────────────
      // LIST
      // ────────────────────────────────────────────────────────────────
      case "list": {
        var listQuery = ""
        var filterType = args.type || "all"
        var activeOnly = args.active_only !== false
        var listLimit = args.limit || 50
        var filterTable = args.table || ""

        if (filterType !== "all") {
          listQuery = "type=" + filterType
        }
        if (activeOnly) {
          listQuery += (listQuery ? "^" : "") + "active=true"
        }
        if (filterTable) {
          // Primary: find flows with triggers on the requested table via sys_hub_trigger_instance
          // This is more reliable than LIKE on flow_definition JSON blob
          var triggerFlowIds: string[] = []
          try {
            var trigLookup = await client.get("/api/now/table/sys_hub_trigger_instance", {
              params: {
                sysparm_query: "table=" + filterTable,
                sysparm_fields: "flow",
                sysparm_limit: 200,
              },
            })
            var trigResults = trigLookup.data.result || []
            var seenFlowIds: Record<string, boolean> = {}
            for (var tfi = 0; tfi < trigResults.length; tfi++) {
              var fid = typeof trigResults[tfi].flow === "object" ? trigResults[tfi].flow.value : trigResults[tfi].flow
              if (fid && !seenFlowIds[fid]) {
                triggerFlowIds.push(fid)
                seenFlowIds[fid] = true
              }
            }
          } catch (e: any) {
            console.warn(
              "[snow_manage_flow] list: trigger table lookup failed, using LIKE fallback: " + (e.message || ""),
            )
          }

          if (triggerFlowIds.length > 0) {
            listQuery += (listQuery ? "^" : "") + "sys_idIN" + triggerFlowIds.join(",")
          } else {
            // Fallback to LIKE on flow_definition (unreliable but better than nothing)
            listQuery += (listQuery ? "^" : "") + "flow_definitionLIKE" + filterTable
          }
        }

        var listResp = await client.get("/api/now/table/sys_hub_flow", {
          params: {
            sysparm_query: listQuery || undefined,
            sysparm_fields: "sys_id,name,description,type,category,active,status,run_as,sys_created_on,sys_updated_on",
            sysparm_limit: listLimit,
          },
        })

        var flows = (listResp.data.result || []).map(function (f: any) {
          return {
            sys_id: f.sys_id,
            name: f.name,
            description: f.description,
            type: f.type,
            category: f.category,
            active: f.active === "true",
            status: f.status,
            run_as: f.run_as,
            created: f.sys_created_on,
            updated: f.sys_updated_on,
          }
        })

        var listSummary = summary().success("Found " + flows.length + " flow" + (flows.length === 1 ? "" : "s"))

        for (var li = 0; li < Math.min(flows.length, 15); li++) {
          var lf = flows[li]
          listSummary.bullet(lf.name + " [" + (lf.type || "flow") + "]" + (lf.active ? "" : " (inactive)"))
        }
        if (flows.length > 15) {
          listSummary.indented("... and " + (flows.length - 15) + " more")
        }

        return createSuccessResult(
          {
            action: "list",
            count: flows.length,
            flows: flows,
          },
          {},
          listSummary.build(),
        )
      }

      // ────────────────────────────────────────────────────────────────
      // GET
      // ────────────────────────────────────────────────────────────────
      case "get": {
        var getSysId = await resolveFlowId(client, args.flow_id)

        // Fetch flow record
        var getResp = await client.get("/api/now/table/sys_hub_flow/" + getSysId)
        var flowRecord = getResp.data.result

        // ── Primary: processflow API for triggers, actions, flow logic ──
        // Flow elements do NOT exist as individual records in Table API.
        // The processflow API returns the real-time state including all elements.
        var triggerInstances: any[] = []
        var actionInstances: any[] = []
        var flowLogicInstances: any[] = []
        var dataSource = "table_api"

        try {
          var pfResp = await client.get("/api/now/processflow/flow/" + getSysId)
          var pfRaw = pfResp.data
          var pfData: any = null

          if (typeof pfRaw === "string") {
            // XML response — parse trigger, action and flow logic elements
            var triggerMatches = pfRaw.match(/<triggerInstance[^>]*>[\s\S]*?<\/triggerInstance>/g) || []
            for (var pti = 0; pti < triggerMatches.length; pti++) {
              var tm = triggerMatches[pti]
              var tidMatch = tm.match(/id="([^"]*)"/) || tm.match(/<id>([^<]*)<\/id>/)
              var tnameMatch = tm.match(/name="([^"]*)"/) || tm.match(/<name>([^<]*)<\/name>/)
              var ttypeMatch = tm.match(/typeLabel="([^"]*)"/) || tm.match(/<typeLabel>([^<]*)<\/typeLabel>/)
              var ttableMatch = tm.match(/table="([^"]*)"/) || tm.match(/<table>([^<]*)<\/table>/)
              triggerInstances.push({
                sys_id: tidMatch ? tidMatch[1] : "",
                name: tnameMatch ? tnameMatch[1] : "",
                action_type: ttypeMatch ? ttypeMatch[1] : "",
                table: ttableMatch ? ttableMatch[1] : "",
              })
            }
            // Parse action instances from XML
            var actionMatches = pfRaw.match(/<actionInstance[^>]*>[\s\S]*?<\/actionInstance>/g) || []
            for (var pai = 0; pai < actionMatches.length; pai++) {
              var am = actionMatches[pai]
              var aidMatch = am.match(/id="([^"]*)"/) || am.match(/<id>([^<]*)<\/id>/)
              var anameMatch = am.match(/name="([^"]*)"/) || am.match(/<name>([^<]*)<\/name>/)
              var atypeMatch = am.match(/typeLabel="([^"]*)"/) || am.match(/<typeLabel>([^<]*)<\/typeLabel>/)
              var aorderMatch = am.match(/order="([^"]*)"/) || am.match(/<order>([^<]*)<\/order>/)
              actionInstances.push({
                sys_id: aidMatch ? aidMatch[1] : "",
                name: anameMatch ? anameMatch[1] : "",
                action_type: atypeMatch ? atypeMatch[1] : "",
                order: aorderMatch ? aorderMatch[1] : "",
              })
            }
            // Parse flow logic instances from XML
            var logicMatches = pfRaw.match(/<flowLogicInstance[^>]*>[\s\S]*?<\/flowLogicInstance>/g) || []
            for (var pli = 0; pli < logicMatches.length; pli++) {
              var lm = logicMatches[pli]
              var lidMatch = lm.match(/id="([^"]*)"/) || lm.match(/<id>([^<]*)<\/id>/)
              var lnameMatch = lm.match(/name="([^"]*)"/) || lm.match(/<name>([^<]*)<\/name>/)
              var ltypeMatch = lm.match(/typeLabel="([^"]*)"/) || lm.match(/<typeLabel>([^<]*)<\/typeLabel>/)
              var lorderMatch = lm.match(/order="([^"]*)"/) || lm.match(/<order>([^<]*)<\/order>/)
              flowLogicInstances.push({
                sys_id: lidMatch ? lidMatch[1] : "",
                name: lnameMatch ? lnameMatch[1] : "",
                type: ltypeMatch ? ltypeMatch[1] : "",
                order: lorderMatch ? lorderMatch[1] : "",
              })
            }
            if (triggerInstances.length > 0 || actionInstances.length > 0) dataSource = "processflow_api"
          } else if (pfRaw && typeof pfRaw === "object") {
            pfData = pfRaw.result?.data || pfRaw.result || pfRaw.data || pfRaw
            // JSON response — extract elements from model
            var model = pfData.model || pfData
            if (model.triggerInstances && Array.isArray(model.triggerInstances)) {
              triggerInstances = model.triggerInstances.map(function (t: any) {
                return {
                  sys_id: t.id || t.sys_id || "",
                  name: t.name || t.typeLabel || "",
                  action_type: t.typeLabel || t.type || "",
                  table: t.table || "",
                  condition: t.condition || "",
                }
              })
            }
            if (model.actionInstances && Array.isArray(model.actionInstances)) {
              actionInstances = model.actionInstances.map(function (a: any) {
                return {
                  sys_id: a.id || a.sys_id || "",
                  name: a.name || a.typeLabel || "",
                  action_type: a.typeLabel || a.type || "",
                  order: a.order || "",
                }
              })
            }
            if (model.flowLogicInstances && Array.isArray(model.flowLogicInstances)) {
              flowLogicInstances = model.flowLogicInstances.map(function (l: any) {
                return {
                  sys_id: l.id || l.sys_id || "",
                  name: l.name || l.typeLabel || "",
                  type: l.typeLabel || l.type || "",
                  order: l.order || "",
                }
              })
            }
            if (triggerInstances.length > 0 || actionInstances.length > 0) dataSource = "processflow_api"
          }
        } catch (e: any) {
          console.warn(
            "[snow_manage_flow] get: processflow API failed, falling back to Table API: " + (e.message || ""),
          )
        }

        // ── Fallback: Table API for triggers/actions (may return empty arrays) ──
        if (dataSource === "table_api") {
          try {
            var trigResp = await client.get("/api/now/table/sys_hub_trigger_instance", {
              params: {
                sysparm_query: "flow=" + getSysId,
                sysparm_fields: "sys_id,name,action_type,table,condition,active,order",
                sysparm_limit: 10,
              },
            })
            triggerInstances = trigResp.data.result || []
          } catch (e: any) {
            console.warn("[snow_manage_flow] get: trigger instances query failed: " + (e.message || ""))
          }

          try {
            var actResp = await client.get("/api/now/table/sys_hub_action_instance", {
              params: {
                sysparm_query: "flow=" + getSysId + "^ORDERBYorder",
                sysparm_fields: "sys_id,name,action_type,order,active",
                sysparm_limit: 50,
              },
            })
            actionInstances = actResp.data.result || []
          } catch (e: any) {
            console.warn("[snow_manage_flow] get: action instances query failed: " + (e.message || ""))
          }
        }

        // Flow variables and executions are always fetched via Table API (they exist as real records)
        var flowVars: any[] = []
        try {
          var varResp = await client.get("/api/now/table/sys_hub_flow_variable", {
            params: {
              sysparm_query: "flow=" + getSysId,
              sysparm_fields: "sys_id,name,label,type,mandatory,variable_type,default_value",
              sysparm_limit: 50,
            },
          })
          flowVars = varResp.data.result || []
        } catch (e: any) {
          console.warn("[snow_manage_flow] get: flow variables query failed: " + (e.message || ""))
        }

        var executions: any[] = []
        try {
          var execResp = await client.get("/api/now/table/sys_hub_flow_run", {
            params: {
              sysparm_query: "flow=" + getSysId + "^ORDERBYDESCsys_created_on",
              sysparm_fields: "sys_id,state,started,ended,duration,trigger_record_table,trigger_record_id",
              sysparm_limit: 10,
            },
          })
          executions = execResp.data.result || []
        } catch (e: any) {
          console.warn("[snow_manage_flow] get: executions query failed: " + (e.message || ""))
        }

        var getSummary = summary()
          .success("Flow: " + (flowRecord.name || args.flow_id))
          .field("sys_id", flowRecord.sys_id)
          .field("Type", flowRecord.type)
          .field("Category", flowRecord.category)
          .field("Status", flowRecord.active === "true" ? "Active" : "Inactive")
          .field("Run as", flowRecord.run_as)
          .field("Description", flowRecord.description)

        if (triggerInstances.length > 0) {
          getSummary.blank().line("Triggers: " + triggerInstances.length)
          for (var ti = 0; ti < triggerInstances.length; ti++) {
            getSummary.bullet(triggerInstances[ti].name || "trigger-" + ti)
          }
        }
        if (actionInstances.length > 0) {
          getSummary.blank().line("Actions: " + actionInstances.length)
          for (var aci = 0; aci < Math.min(actionInstances.length, 10); aci++) {
            getSummary.bullet(actionInstances[aci].name || "action-" + aci)
          }
        }
        if (flowLogicInstances.length > 0) {
          getSummary.blank().line("Flow Logic: " + flowLogicInstances.length)
          for (var fli = 0; fli < Math.min(flowLogicInstances.length, 10); fli++) {
            getSummary.bullet(
              (flowLogicInstances[fli].type || "") + " " + (flowLogicInstances[fli].name || "logic-" + fli),
            )
          }
        }
        if (flowVars.length > 0) {
          getSummary.blank().line("Variables: " + flowVars.length)
        }
        if (executions.length > 0) {
          getSummary.blank().line("Recent executions: " + executions.length)
          for (var ei = 0; ei < Math.min(executions.length, 5); ei++) {
            var ex = executions[ei]
            getSummary.bullet((ex.state || "unknown") + " - " + (ex.started || "pending"))
          }
        }

        return createSuccessResult(
          {
            action: "get",
            data_source: dataSource,
            flow: {
              sys_id: flowRecord.sys_id,
              name: flowRecord.name,
              description: flowRecord.description,
              type: flowRecord.type,
              category: flowRecord.category,
              active: flowRecord.active === "true",
              status: flowRecord.status,
              run_as: flowRecord.run_as,
              created: flowRecord.sys_created_on,
              updated: flowRecord.sys_updated_on,
            },
            triggers: triggerInstances.map(function (t: any) {
              return {
                sys_id: t.sys_id,
                name: t.name,
                action_type: typeof t.action_type === "object" ? t.action_type.display_value : t.action_type,
                table: t.table,
                condition: t.condition,
                active: t.active === "true",
              }
            }),
            actions: actionInstances.map(function (a: any) {
              return {
                sys_id: a.sys_id,
                name: a.name,
                action_type: typeof a.action_type === "object" ? a.action_type.display_value : a.action_type,
                order: a.order,
                active: a.active === "true",
              }
            }),
            flow_logic: flowLogicInstances.map(function (l: any) {
              return {
                sys_id: l.sys_id,
                name: l.name,
                type: l.type,
                order: l.order,
              }
            }),
            variables: flowVars.map(function (v: any) {
              return {
                sys_id: v.sys_id,
                name: v.name,
                label: v.label,
                type: v.type,
                mandatory: v.mandatory === "true",
                variable_type: v.variable_type,
                default_value: v.default_value,
              }
            }),
            recent_executions: executions.map(function (e: any) {
              return {
                sys_id: e.sys_id,
                state: e.state,
                started: e.started,
                ended: e.ended,
                duration: e.duration,
                trigger_table: e.trigger_record_table,
                trigger_record: e.trigger_record_id,
              }
            }),
          },
          {},
          getSummary.build(),
        )
      }

      // ────────────────────────────────────────────────────────────────
      // UPDATE
      // ────────────────────────────────────────────────────────────────
      case "update": {
        var updateFields = args.update_fields
        if (!updateFields || Object.keys(updateFields).length === 0) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "update_fields is required for update action")
        }

        var updateSysId = await resolveFlowId(client, args.flow_id)
        await client.patch("/api/now/table/sys_hub_flow/" + updateSysId, updateFields)

        var updateSummary = summary()
          .success("Updated flow: " + args.flow_id)
          .field("sys_id", updateSysId)

        var fieldNames = Object.keys(updateFields)
        for (var fi = 0; fi < fieldNames.length; fi++) {
          updateSummary.field(fieldNames[fi], updateFields[fieldNames[fi]])
        }

        return createSuccessResult(
          {
            action: "update",
            flow_id: updateSysId,
            updated_fields: fieldNames,
            message: "Flow updated successfully",
          },
          {},
          updateSummary.build(),
        )
      }

      // ────────────────────────────────────────────────────────────────
      // ACTIVATE / PUBLISH
      // ────────────────────────────────────────────────────────────────
      case "activate":
      case "publish": {
        var activateSysId = await resolveFlowId(client, args.flow_id)
        var activateSummary = summary()

        // Publish the way the Flow Designer UI does: FIRST compile the working
        // copy into a master snapshot (POST .../snapshot — the step the tool used
        // to skip, which is why flows stayed draft and never triggered), THEN
        // record a published version. Verification below is the gate, so a failed
        // compile surfaces as a real error instead of a false "published".
        var snapshotId = await compileFlowSnapshot(client, activateSysId)
        if (snapshotId) activateSummary.field("snapshot", snapshotId)

        try {
          await client.post(
            "/api/now/processflow/versioning/create_version?sysparm_transaction_scope=global",
            { item_sys_id: activateSysId, type: "Activate/Publish", annotation: "", favorite: false },
          )
        } catch (_) {
          // The version record is non-fatal bookkeeping; the snapshot above is
          // what activates the flow, and verification decides success.
        }

        // Releasing the editing lock cleans up the safe-edit session; capture any
        // compilation error it surfaces.
        var releaseResult = await releaseFlowEditingLock(client, activateSysId)

        // Source of truth: re-read the flow. Recompile once if the snapshot
        // didn't materialize, then re-verify.
        var activation = await verifyFlowActivation(client, activateSysId)
        if (!activation.active || !activation.hasSnapshot) {
          await compileFlowSnapshot(client, activateSysId)
          activation = await verifyFlowActivation(client, activateSysId)
        }

        if (!activation.active || !activation.hasSnapshot) {
          var why = releaseResult?.compilationError
            ? "Compilation error: " + releaseResult.compilationError
            : (activation.active ? "active but has no compiled snapshot" : "not active") +
              " (status=" + activation.status + ")"
          return createErrorResult(
            new SnowFlowError(
              ErrorType.UNKNOWN_ERROR,
              "Flow publish did not complete — the flow will NOT trigger. " + why + ".",
              {
                retryable: true,
                details: {
                  flow_id: activateSysId,
                  active: activation.active,
                  status: activation.status,
                  has_snapshot: activation.hasSnapshot,
                  compilation_error: releaseResult?.compilationError || null,
                },
              },
            ),
          )
        }

        activateSummary
          .success("Flow published and verified (active with a compiled snapshot)")
          .field("sys_id", activateSysId)
          .field("status", activation.status)

        var publishData: any = {
          action: action,
          flow_id: activateSysId,
          active: true,
          status: activation.status,
          snapshot: activation.snapshot,
          message: "Flow activated, published, and verified (compiled snapshot present)",
          next_step:
            "Use action='check_execution' with flow_id='" + activateSysId + "' to verify execution after trigger.",
        }

        return createSuccessResult(publishData, {}, activateSummary.build())
      }

      // ────────────────────────────────────────────────────────────────
      // DEACTIVATE
      // ────────────────────────────────────────────────────────────────
      case "deactivate": {
        var deactivateSysId = await resolveFlowId(client, args.flow_id)

        // Primary: use processflow versioning API with Deactivate type
        var deactivateOk = false
        try {
          await client.post("/api/now/processflow/versioning/create_version?sysparm_transaction_scope=global", {
            item_sys_id: deactivateSysId,
            type: "Deactivate",
            annotation: "",
            favorite: false,
          })
          deactivateOk = true
        } catch (_) {
          // Fallback: direct REST PATCH
          await client.patch("/api/now/table/sys_hub_flow/" + deactivateSysId, { active: false })
          deactivateOk = true
        }

        // Safety: release any lingering editing lock
        await releaseFlowEditingLock(client, deactivateSysId)

        var deactivateSummary = summary().success("Flow deactivated").field("sys_id", deactivateSysId)

        return createSuccessResult(
          {
            action: "deactivate",
            flow_id: deactivateSysId,
            active: false,
            message: "Flow deactivated",
          },
          {},
          deactivateSummary.build(),
        )
      }

      // ────────────────────────────────────────────────────────────────
      // DELETE
      // ────────────────────────────────────────────────────────────────
      case "delete": {
        var deleteSysId = await resolveFlowId(client, args.flow_id)
        var deleteSteps: any = {}

        // Pre-delete: release any editing lock (flow may be locked)
        try {
          await releaseFlowEditingLock(client, deleteSysId)
          deleteSteps.lock_released = true
        } catch (e: any) {
          deleteSteps.lock_release_error = e.message
          console.warn("[snow_manage_flow] delete: lock release failed: " + (e.message || ""))
        }

        // Pre-delete: deactivate the flow (avoids "active flow" errors)
        try {
          await client.patch("/api/now/table/sys_hub_flow/" + deleteSysId, { active: false })
          deleteSteps.deactivated = true
        } catch (e: any) {
          deleteSteps.deactivate_error = e.message
          console.warn("[snow_manage_flow] delete: deactivation failed: " + (e.message || ""))
        }

        // Delete the flow
        await client.delete("/api/now/table/sys_hub_flow/" + deleteSysId)

        // Post-delete: clean up orphaned safe_edit records
        try {
          var orphanResp = await client.get("/api/now/table/sys_hub_flow_safe_edit", {
            params: { sysparm_query: "document_id=" + deleteSysId, sysparm_fields: "sys_id", sysparm_limit: 10 },
          })
          var orphans = orphanResp.data?.result || []
          for (var oi = 0; oi < orphans.length; oi++) {
            await client.delete("/api/now/table/sys_hub_flow_safe_edit/" + orphans[oi].sys_id)
          }
          if (orphans.length > 0) deleteSteps.orphans_cleaned = orphans.length
        } catch (e: any) {
          console.warn("[snow_manage_flow] delete: orphan cleanup failed: " + (e.message || ""))
        }

        var deleteSummary = summary().success("Flow deleted").field("sys_id", deleteSysId)
        if (deleteSteps.orphans_cleaned)
          deleteSummary.line("Cleaned " + deleteSteps.orphans_cleaned + " orphaned lock record(s)")

        return createSuccessResult(
          {
            action: "delete",
            flow_id: deleteSysId,
            message: "Flow deleted",
            steps: deleteSteps,
          },
          {},
          deleteSummary.build(),
        )
      }

      // ────────────────────────────────────────────────────────────────
      // ADD_TRIGGER
      // ────────────────────────────────────────────────────────────────
      case "add_trigger": {
        var addTrigFlowId = await resolveFlowId(client, args.flow_id)

        // Pre-flight: most flows already have a trigger by the time the
        // agent calls add_trigger — `create` sets one up when trigger_type
        // is provided. Surface a clear, actionable error instead of letting
        // the GraphQL mutation fail downstream, which agents tend to
        // misread as a lock problem and chase with force_unlock loops.
        try {
          var existingTrigResp = await client.get("/api/now/table/sys_hub_trigger_instance", {
            params: {
              sysparm_query: "flow=" + addTrigFlowId,
              sysparm_fields: "sys_id,trigger_type",
              sysparm_limit: 1,
            },
          })
          var existingTrig = existingTrigResp.data?.result?.[0]
          if (existingTrig?.sys_id) {
            var existingType =
              typeof existingTrig.trigger_type === "object"
                ? existingTrig.trigger_type.value || existingTrig.trigger_type.display_value
                : existingTrig.trigger_type
            return createErrorResult(
              new SnowFlowError(
                ErrorType.VALIDATION_ERROR,
                "Flow already has a trigger" +
                  (existingType ? " (type: " + existingType + ")" : "") +
                  ". The trigger was set up at create time when trigger_type was provided. " +
                  "Use 'update_trigger' to modify it, or skip this step and proceed with add_action / add_flow_logic.",
              ),
            )
          }
        } catch (_) {
          // Lookup failed — fall through to the original logic so we
          // don't block legitimate add_trigger calls on a transient
          // table-API error.
        }

        var addTrigLock = await ensureFlowEditingLock(client, addTrigFlowId)
        if (!addTrigLock.success)
          return createErrorResult("Flow is not open for editing. Call open_flow first. " + (addTrigLock.warning || ""))
        var addTrigType = args.trigger_type || "record_create_or_update"
        var addTrigTable = args.table || args.trigger_table || ""
        var addTrigCondition = args.trigger_condition || ""

        var addTrigResult = await addTriggerViaGraphQL(
          client,
          addTrigFlowId,
          addTrigType,
          addTrigTable,
          addTrigCondition,
          args.annotation,
        )

        var addTrigSummary = summary()
        if (addTrigResult.success) {
          addTrigSummary
            .success("Trigger added via GraphQL")
            .field("Flow", addTrigFlowId)
            .field("Type", addTrigType)
            .field("Annotation", args.annotation)
            .field("Trigger ID", addTrigResult.triggerId || "unknown")
          if (addTrigTable) addTrigSummary.field("Table", addTrigTable)
        } else {
          addTrigSummary.error("Failed to add trigger: " + (addTrigResult.error || "unknown"))
        }

        if (addTrigResult.success) {
          if (args.verify) {
            var trigVerification = await verifyFlowState(client, addTrigFlowId, {
              type: "trigger",
              id: addTrigResult.triggerId,
            })
            addTrigResult.steps.verification = trigVerification
            addTrigSummary.field("Verified", trigVerification.verified ? "yes" : "FAILED")
          }
          return createSuccessResult(
            withUpdateSetContext({ action: "add_trigger", ...addTrigResult }, updateSetCtx),
            {},
            addTrigSummary.build(),
          )
        }
        var addTrigLockHint = ""
        var addTrigPostLock = await verifyFlowEditingLock(client, addTrigFlowId)
        if (!addTrigPostLock.locked) {
          addTrigLockHint =
            " Note: No editing lock detected. Try calling open_flow with flow_id='" +
            addTrigFlowId +
            "' first, then retry."
        }
        return createErrorResult((addTrigResult.error || "Failed to add trigger") + addTrigLockHint)
      }

      // ────────────────────────────────────────────────────────────────
      // UPDATE_TRIGGER — replace existing trigger(s) with a new one
      // ────────────────────────────────────────────────────────────────
      case "update_trigger": {
        var updTrigFlowId = await resolveFlowId(client, args.flow_id)
        var updTrigLock = await ensureFlowEditingLock(client, updTrigFlowId)
        if (!updTrigLock.success)
          return createErrorResult("Flow is not open for editing. Call open_flow first. " + (updTrigLock.warning || ""))
        var updTrigType = args.trigger_type || "record_create_or_update"
        var updTrigTable = args.table || args.trigger_table || ""
        var updTrigCondition = args.trigger_condition || ""
        var updTrigSteps: any = {}

        // Step 1: Find existing trigger instances on this flow
        var trigInstances: any[] = []
        try {
          var existingTriggers = await client.get("/api/now/table/sys_hub_trigger_instance", {
            params: {
              sysparm_query: "flow=" + updTrigFlowId,
              sysparm_fields: "sys_id,name,type",
              sysparm_limit: 10,
            },
          })
          trigInstances = existingTriggers.data.result || []
          updTrigSteps.existing_triggers = trigInstances.map(function (t: any) {
            return { sys_id: t.sys_id, name: t.name, type: t.type }
          })
        } catch (e: any) {
          updTrigSteps.lookup_error = "Could not query existing triggers: " + (e.message || "")
        }

        // Step 2: Create the NEW trigger FIRST (safe: old triggers still exist if this fails)
        var updTrigResult = await addTriggerViaGraphQL(
          client,
          updTrigFlowId,
          updTrigType,
          updTrigTable,
          updTrigCondition,
          args.annotation,
        )
        updTrigSteps.new_trigger = updTrigResult

        // Step 3: Only delete old triggers if the new one was created successfully
        if (updTrigResult.success && trigInstances.length > 0) {
          var newTriggerId = updTrigResult.triggerId || ""
          var deleteIds = trigInstances
            .map(function (t: any) {
              return t.sys_id
            })
            .filter(function (id: string) {
              return id !== newTriggerId
            })
          if (deleteIds.length > 0) {
            try {
              await executeFlowPatchMutation(
                client,
                {
                  flowId: updTrigFlowId,
                  triggerInstances: { delete: deleteIds },
                },
                "triggerInstances { deletes __typename }",
              )
              updTrigSteps.deleted = deleteIds
            } catch (e: any) {
              updTrigSteps.delete_error = e.message
              console.warn("[snow_manage_flow] update_trigger: old trigger deletion failed: " + (e.message || ""))
            }
          }
        }

        var updTrigSummary = summary()
        if (updTrigResult.success) {
          updTrigSummary
            .success("Trigger updated via GraphQL (create-first)")
            .field("Annotation", args.annotation)
            .field("Flow", updTrigFlowId)
            .field("New Type", updTrigType)
            .field("Trigger ID", updTrigResult.triggerId || "unknown")
          if (updTrigTable) updTrigSummary.field("Table", updTrigTable)
          if (updTrigSteps.deleted) updTrigSummary.line("Old trigger(s) removed: " + updTrigSteps.deleted.join(", "))
        } else {
          updTrigSummary.error(
            "Failed to create new trigger: " +
              (updTrigResult.error || "unknown") +
              ". Old trigger(s) preserved — flow is not broken.",
          )
        }

        if (updTrigResult.success && args.verify) {
          var updTrigVerification = await verifyFlowState(client, updTrigFlowId, {
            type: "trigger",
            id: updTrigResult.triggerId,
          })
          updTrigSteps.verification = updTrigVerification
          updTrigSummary.field("Verified", updTrigVerification.verified ? "yes" : "FAILED")
        }
        return updTrigResult.success
          ? createSuccessResult(
              { action: "update_trigger", mutation_method: "graphql", steps: updTrigSteps },
              {},
              updTrigSummary.build(),
            )
          : createErrorResult(
              "Failed to update trigger: " +
                (updTrigResult.error || "unknown") +
                ". Old trigger(s) preserved — the flow still has its original trigger.",
            )
      }

      // ────────────────────────────────────────────────────────────────
      // ADD_ACTION
      // ────────────────────────────────────────────────────────────────
      case "add_action": {
        var addActFlowId = await resolveFlowId(client, args.flow_id)
        var addActLock = await ensureFlowEditingLock(client, addActFlowId)
        if (!addActLock.success)
          return createErrorResult("Flow is not open for editing. Call open_flow first. " + (addActLock.warning || ""))
        var addActType = args.action_type || args.action_name || args.name || "log"
        var addActName = args.action_name || args.name || addActType
        var addActInputs =
          args.action_inputs ||
          args.action_config ||
          args.action_field_values ||
          args.field_values ||
          args.inputs ||
          args.config ||
          {}

        var addActTypeLC = addActType.toLowerCase().replace(/[\s_-]+/g, "")
        if (addActTypeLC === "subflow" || addActTypeLC === "callsubflow" || addActTypeLC === "runsubflow") {
          var sfId = args.subflow_id || addActInputs.subflow_id || addActInputs.subflow
          if (!sfId) {
            return createErrorResult(
              new SnowFlowError(
                ErrorType.VALIDATION_ERROR,
                "Subflow calls require subflow_id parameter. Use action='add_subflow' with subflow_id, or provide subflow_id when using action_name='Subflow'.",
              ),
            )
          }
          var sfInputs = { ...addActInputs }
          delete sfInputs.subflow_id
          delete sfInputs.subflow
          var sfResult = await addSubflowCallViaGraphQL(
            client,
            addActFlowId,
            sfId,
            sfInputs,
            args.order,
            args.parent_ui_id,
            args.annotation,
          )
          var sfSummary = summary()
          if (sfResult.success) {
            sfSummary
              .success("Subflow call added via GraphQL (redirected from add_action)")
              .field("Flow", addActFlowId)
              .field("Subflow", sfId)
              .field("Call ID", sfResult.callId || "unknown")
          } else {
            sfSummary.error("Failed to add subflow call: " + (sfResult.error || "unknown"))
          }
          if (sfResult.success) {
            var sfNextOrder = (sfResult.resolvedOrder || 1) + 1
            return createSuccessResult(
              withUpdateSetContext(
                {
                  action: "add_subflow",
                  redirected_from: "add_action (action_name was 'Subflow')",
                  ...sfResult,
                  mutation_method: "graphql",
                  next_order: sfNextOrder,
                  reminder:
                    "IMPORTANT: Call close_flow with flow_id='" +
                    addActFlowId +
                    "' when you are done adding elements. Forgetting this will leave the flow locked.",
                },
                updateSetCtx,
              ),
              {},
              sfSummary.build(),
            )
          }
          return createErrorResult(sfResult.error || "Failed to add subflow call")
        }

        // Accept action_table as a shorthand — inject into inputs as table/table_name
        if (args.action_table && !addActInputs.table && !addActInputs.table_name) {
          addActInputs = { ...addActInputs, table: args.action_table }
        }
        // Early validation: check action_table exists before calling GraphQL
        if (args.action_table) {
          var actTblCheck = await validateTableExists(client, args.action_table)
          if (!actTblCheck.exists) {
            return createErrorResult(
              new SnowFlowError(
                ErrorType.VALIDATION_ERROR,
                "Table '" + args.action_table + "' does not exist in ServiceNow.",
              ),
            )
          }
        }

        var addActResult = await addActionViaGraphQL(
          client,
          addActFlowId,
          addActType,
          addActName,
          addActInputs,
          args.parent_ui_id,
          args.order,
          args.spoke,
          args.annotation,
          args.display_text,
        )

        var addActSummary = summary()
        if (addActResult.success) {
          addActSummary
            .success("Action added via GraphQL")
            .field("Flow", addActFlowId)
            .field("Type", addActType)
            .field("Name", addActName)
            .field("Annotation", args.annotation)
            .field("Action ID", addActResult.actionId || "unknown")
        } else {
          addActSummary.error("Failed to add action: " + (addActResult.error || "unknown"))
        }

        if (addActResult.success) {
          if (args.verify) {
            var actVerification = await verifyFlowState(client, addActFlowId, {
              type: "action",
              id: addActResult.actionId,
            })
            addActResult.steps.verification = actVerification
            addActSummary.field("Verified", actVerification.verified ? "yes" : "FAILED")
          }
          var addActNextOrder = (addActResult.resolvedOrder || 1) + 1
          return createSuccessResult(
            withUpdateSetContext(
              {
                action: "add_action",
                ...addActResult,
                mutation_method: "graphql",
                next_order: addActNextOrder,
                reminder:
                  "IMPORTANT: Call close_flow with flow_id='" +
                  addActFlowId +
                  "' when you are done adding elements. Forgetting this will leave the flow locked.",
              },
              updateSetCtx,
            ),
            {},
            addActSummary.build(),
          )
        }
        var addActLockHint = ""
        var addActPostLock = await verifyFlowEditingLock(client, addActFlowId)
        if (!addActPostLock.locked) {
          addActLockHint =
            " Note: No editing lock detected. Try calling open_flow with flow_id='" +
            addActFlowId +
            "' first, then retry."
        }
        return createErrorResult((addActResult.error || "Failed to add action") + addActLockHint)
      }

      // ────────────────────────────────────────────────────────────────
      // ADD_FLOW_LOGIC — add If/Else, For Each, Do Until, Switch blocks
      // ────────────────────────────────────────────────────────────────
      case "add_flow_logic": {
        var addLogicFlowId = await resolveFlowId(client, args.flow_id)
        var addLogicLock = await ensureFlowEditingLock(client, addLogicFlowId)
        if (!addLogicLock.success)
          return createErrorResult(
            "Flow is not open for editing. Call open_flow first. " + (addLogicLock.warning || ""),
          )
        var addLogicType = args.logic_type
        var addLogicInputs =
          args.logic_inputs || args.logic_config || args.inputs || args.action_inputs || args.config || {}
        // Accept condition and condition_name at top level (most natural for the agent)
        if (args.condition && !addLogicInputs.condition) {
          const raw = args.condition
          const normalized =
            typeof raw === "object" && raw !== null && !Array.isArray(raw)
              ? (raw.field || "") + (raw.operator || "=") + (raw.value ?? "")
              : String(raw)
          addLogicInputs = { ...addLogicInputs, condition: normalized }
        }
        if (args.condition_name && !addLogicInputs.condition_name) {
          addLogicInputs = { ...addLogicInputs, condition_name: args.condition_name }
        }
        // Also accept logic_name as alias for condition_name
        if (args.logic_name && !addLogicInputs.condition_name) {
          addLogicInputs = { ...addLogicInputs, condition_name: args.logic_name }
        }
        var ifElseTypes = ["IF", "ELSEIF"]
        if (
          ifElseTypes.indexOf(addLogicType.toUpperCase().replace(/[^A-Z]/g, "")) !== -1 &&
          !addLogicInputs.condition_name &&
          args.annotation
        ) {
          addLogicInputs = { ...addLogicInputs, condition_name: args.annotation }
        }
        if (
          ifElseTypes.indexOf(addLogicType.toUpperCase().replace(/[^A-Z]/g, "")) !== -1 &&
          !addLogicInputs.condition_name
        ) {
          return createErrorResult(
            new SnowFlowError(
              ErrorType.VALIDATION_ERROR,
              "IF/ELSEIF flow logic requires a condition label. Provide 'condition_name' (or 'annotation' as fallback).",
            ),
          )
        }
        var addLogicOrder = args.order
        var addLogicParentUiId = args.parent_ui_id || ""
        var addLogicConnectedTo = args.connected_to || ""

        var addLogicResult = await addFlowLogicViaGraphQL(
          client,
          addLogicFlowId,
          addLogicType,
          addLogicInputs,
          addLogicOrder,
          addLogicParentUiId,
          addLogicConnectedTo,
          args.annotation,
        )

        var addLogicSummary = summary()
        if (addLogicResult.success) {
          addLogicSummary
            .success("Flow logic added via GraphQL")
            .field("Annotation", args.annotation)
            .field("Flow", addLogicFlowId)
            .field("Type", addLogicType)
            .field("Logic ID", addLogicResult.logicId || "unknown")
            .field("uiUniqueIdentifier", addLogicResult.uiUniqueIdentifier || "unknown")
          if (addLogicResult.steps?.catch_companion) {
            addLogicSummary
              .field("Catch Block", "auto-created (companion)")
              .field("Catch ID", addLogicResult.steps.catch_insert?.sysId || "unknown")
              .field(
                "Catch UUID",
                addLogicResult.steps.catch_insert?.uiUniqueIdentifier ||
                  addLogicResult.steps.catch_companion.uuid ||
                  "unknown",
              )
            if (addLogicResult.steps.catch_warning) {
              addLogicSummary.field("WARNING", addLogicResult.steps.catch_warning)
            }
          }
        } else {
          addLogicSummary.error("Failed to add flow logic: " + (addLogicResult.error || "unknown"))
        }

        // For IF/ELSEIF: hint about ELSE/ELSEIF placement
        // CRITICAL: ELSE/ELSEIF sit at the SAME level as IF (same parent), NOT inside the IF branch.
        // - Actions INSIDE IF use parent_ui_id = IF's uiUniqueIdentifier
        // - ELSE/ELSEIF use parent_ui_id = IF's PARENT (same level as IF) + connected_to = IF's logicId
        var logicUpperType = addLogicType.toUpperCase().replace(/[^A-Z]/g, "")
        var addLogicNextOrder =
          logicUpperType === "TRY" ? (addLogicResult.resolvedOrder || 1) + 2 : (addLogicResult.resolvedOrder || 1) + 1
        var logicHints: any = {
          mutation_method: "graphql",
          reminder:
            "IMPORTANT: Call close_flow with flow_id='" +
            addLogicFlowId +
            "' when you are done adding elements. Forgetting this will leave the flow locked.",
          next_order: addLogicNextOrder,
        }
        if (logicUpperType === "IF" || logicUpperType === "ELSEIF") {
          logicHints.important =
            "ELSE/ELSEIF must be at the SAME level as this IF (same parent_ui_id), NOT nested inside it. " +
            'Use connected_to: "' +
            (addLogicResult.logicId || "") +
            '" to link them to this IF, ' +
            'and parent_ui_id: "' +
            (addLogicParentUiId || "") +
            '" (the SAME parent as this IF block).'
          logicHints.connected_to_value = addLogicResult.logicId || ""
          logicHints.parent_ui_id_for_else = addLogicParentUiId || ""
          logicHints.parent_ui_id_for_children = addLogicResult.uiUniqueIdentifier || ""
          logicHints.next_step = {
            for_child:
              'To add actions INSIDE this IF branch, use parent_ui_id: "' +
              (addLogicResult.uiUniqueIdentifier || "") +
              '". Order is computed automatically when parent_ui_id is set.',
            for_else:
              'To add ELSE/ELSEIF at the SAME level as this IF, use connected_to: "' +
              (addLogicResult.logicId || "") +
              '" AND parent_ui_id: "' +
              (addLogicParentUiId || "") +
              "\" (NOT the IF's uiUniqueIdentifier!)",
          }
        }
        if (logicUpperType === "TRY" && addLogicResult.steps?.catch_companion) {
          var catchId = addLogicResult.steps.catch_insert?.sysId || ""
          var catchUiId =
            addLogicResult.steps.catch_insert?.uiUniqueIdentifier || addLogicResult.steps.catch_companion.uuid || ""
          logicHints.important =
            "TRY block created with companion CATCH block. " +
            "Add actions INSIDE the TRY using parent_ui_id='" +
            (addLogicResult.uiUniqueIdentifier || "") +
            "'. " +
            "Add error-handling actions INSIDE the CATCH using parent_ui_id='" +
            catchUiId +
            "'."
          logicHints.try_ui_id = addLogicResult.uiUniqueIdentifier || ""
          logicHints.catch_sys_id = catchId
          logicHints.catch_ui_id = catchUiId
          logicHints.next_step = {
            for_try_child:
              'To add actions INSIDE the TRY block, use parent_ui_id: "' +
              (addLogicResult.uiUniqueIdentifier || "") +
              '". Order is computed automatically (CATCH block and subsequent elements are shifted forward).',
            for_catch_child:
              'To add error-handling actions INSIDE the CATCH block, use parent_ui_id: "' +
              catchUiId +
              '". Order is computed automatically.',
          }
        }

        if (addLogicResult.success) {
          if (args.verify) {
            var logicVerification = await verifyFlowState(client, addLogicFlowId, {
              type: "flow_logic",
              id: addLogicResult.logicId,
            })
            addLogicResult.steps.verification = logicVerification
            addLogicSummary.field("Verified", logicVerification.verified ? "yes" : "FAILED")
          }
          return createSuccessResult(
            withUpdateSetContext({ action: "add_flow_logic", ...addLogicResult, ...logicHints }, updateSetCtx),
            {},
            addLogicSummary.build(),
          )
        }
        var addLogicLockHint = ""
        var addLogicPostLock = await verifyFlowEditingLock(client, addLogicFlowId)
        if (!addLogicPostLock.locked) {
          addLogicLockHint =
            " Note: No editing lock detected. Try calling open_flow with flow_id='" +
            addLogicFlowId +
            "' first, then retry."
        }
        return createErrorResult((addLogicResult.error || "Failed to add flow logic") + addLogicLockHint)
      }

      // ────────────────────────────────────────────────────────────────
      // ADD_FLOW_VARIABLE — add a user flow variable to an existing flow
      // ────────────────────────────────────────────────────────────────
      case "add_flow_variable": {
        var fvFlowId = await resolveFlowId(client, args.flow_id)
        var fvLock = await ensureFlowEditingLock(client, fvFlowId)
        if (!fvLock.success) {
          return createErrorResult("Flow is not open for editing. Call open_flow first. " + (fvLock.warning || ""))
        }
        var fvResult = await addFlowVariable(client, fvFlowId, {
          name: args.variable_name,
          label: args.variable_label,
          type: args.variable_type,
          order: args.order,
        })
        if (!fvResult.success) {
          return createErrorResult(
            new SnowFlowError(ErrorType.UNKNOWN_ERROR, "Failed to add flow variable: " + (fvResult.error || ""), {
              details: { flow_id: fvFlowId, variable: args.variable_name },
            }),
          )
        }
        return createSuccessResult(
          withUpdateSetContext(
            {
              action: "add_flow_variable",
              flow_id: fvFlowId,
              name: args.variable_name,
              sys_id: fvResult.sysId,
              message: "Added flow variable '" + args.variable_name + "'",
              reminder: "Call close_flow with flow_id='" + fvFlowId + "' when you are done editing.",
            },
            updateSetCtx,
          ),
          {},
          summary()
            .success("Added flow variable: " + args.variable_name)
            .field("flow", fvFlowId)
            .build(),
        )
      }

      // ────────────────────────────────────────────────────────────────
      // ADD_SUBFLOW — call an existing subflow as a step in the flow
      // ────────────────────────────────────────────────────────────────
      case "add_subflow": {
        var addSubFlowId = await resolveFlowId(client, args.flow_id)
        var addSubLock = await ensureFlowEditingLock(client, addSubFlowId)
        if (!addSubLock.success)
          return createErrorResult("Flow is not open for editing. Call open_flow first. " + (addSubLock.warning || ""))
        var addSubSubflowId = args.subflow_id
        var addSubInputs =
          args.action_inputs ||
          args.action_config ||
          args.action_field_values ||
          args.field_values ||
          args.inputs ||
          args.config ||
          {}
        var addSubOrder = args.order
        var addSubParentUiId = args.parent_ui_id || ""

        var addSubResult = await addSubflowCallViaGraphQL(
          client,
          addSubFlowId,
          addSubSubflowId,
          addSubInputs,
          addSubOrder,
          addSubParentUiId,
          args.annotation,
        )

        var addSubSummary = summary()
        if (addSubResult.success) {
          addSubSummary
            .success("Subflow call added via GraphQL")
            .field("Flow", addSubFlowId)
            .field("Annotation", args.annotation)
            .field("Subflow", addSubSubflowId)
            .field("Call ID", addSubResult.callId || "unknown")
        } else {
          addSubSummary.error("Failed to add subflow call: " + (addSubResult.error || "unknown"))
        }

        if (addSubResult.success) {
          if (args.verify) {
            var subVerification = await verifyFlowState(client, addSubFlowId, {
              type: "subflow",
              id: addSubResult.callId,
            })
            addSubResult.steps.verification = subVerification
            addSubSummary.field("Verified", subVerification.verified ? "yes" : "FAILED")
          }
          var addSubNextOrder = (addSubResult.resolvedOrder || 1) + 1
          return createSuccessResult(
            withUpdateSetContext(
              {
                action: "add_subflow",
                ...addSubResult,
                mutation_method: "graphql",
                next_order: addSubNextOrder,
                reminder:
                  "IMPORTANT: Call close_flow with flow_id='" +
                  addSubFlowId +
                  "' when you are done adding elements. Forgetting this will leave the flow locked.",
              },
              updateSetCtx,
            ),
            {},
            addSubSummary.build(),
          )
        }
        var addSubLockHint = ""
        var addSubPostLock = await verifyFlowEditingLock(client, addSubFlowId)
        if (!addSubPostLock.locked) {
          addSubLockHint =
            " Note: No editing lock detected. Try calling open_flow with flow_id='" +
            addSubFlowId +
            "' first, then retry."
        }
        return createErrorResult((addSubResult.error || "Failed to add subflow call") + addSubLockHint)
      }

      // ────────────────────────────────────────────────────────────────
      // UPDATE_ACTION / UPDATE_FLOW_LOGIC / UPDATE_SUBFLOW
      // ────────────────────────────────────────────────────────────────
      case "update_action":
      case "update_flow_logic":
      case "update_subflow": {
        var updElemFlowId = await resolveFlowId(client, args.flow_id)
        var updElemLock = await ensureFlowEditingLock(client, updElemFlowId)
        if (!updElemLock.success)
          return createErrorResult("Flow is not open for editing. Call open_flow first. " + (updElemLock.warning || ""))
        var updElemType =
          action === "update_action" ? "action" : action === "update_flow_logic" ? "flowlogic" : "subflow"
        var updElemInputs =
          args.action_inputs ||
          args.action_config ||
          args.action_field_values ||
          args.field_values ||
          args.logic_inputs ||
          args.inputs ||
          args.config ||
          {}
        // Accept action_table as a shorthand — inject into inputs as table/table_name
        if (args.action_table && !updElemInputs.table && !updElemInputs.table_name) {
          updElemInputs = { ...updElemInputs, table: args.action_table }
        }
        // Early validation: check action_table exists before calling GraphQL
        if (args.action_table) {
          var updActTblCheck = await validateTableExists(client, args.action_table)
          if (!updActTblCheck.exists) {
            return createErrorResult(
              new SnowFlowError(
                ErrorType.VALIDATION_ERROR,
                "Table '" + args.action_table + "' does not exist in ServiceNow.",
              ),
            )
          }
        }

        if (action === "update_flow_logic") {
          if (args.condition_name && !updElemInputs.condition_name) {
            updElemInputs = { ...updElemInputs, condition_name: args.condition_name }
          }
          if (args.logic_name && !updElemInputs.condition_name) {
            updElemInputs = { ...updElemInputs, condition_name: args.logic_name }
          }
          if (!updElemInputs.condition_name && args.annotation) {
            updElemInputs = { ...updElemInputs, condition_name: args.annotation }
          }
        }

        var updElemResult = await updateElementViaGraphQL(
          client,
          updElemFlowId,
          updElemType,
          args.element_id,
          updElemInputs,
          args.annotation,
        )

        var updElemSummary = summary()
        if (updElemResult.success) {
          updElemSummary
            .success("Element updated")
            .field("Type", updElemType)
            .field("Element", args.element_id)
            .field("Annotation", args.annotation)
          if (args.verify) {
            var updVerifyType = updElemType === "flowlogic" ? "flow_logic" : updElemType
            var updVerification = await verifyFlowState(client, updElemFlowId, {
              type: updVerifyType as any,
              id: args.element_id,
            })
            if (updElemResult.steps) updElemResult.steps.verification = updVerification
            updElemSummary.field("Verified", updVerification.verified ? "yes" : "FAILED")
          }
        } else {
          updElemSummary.error("Failed to update element: " + (updElemResult.error || "unknown"))
        }
        return updElemResult.success
          ? createSuccessResult({ action, ...updElemResult }, {}, updElemSummary.build())
          : createErrorResult(updElemResult.error || "Failed to update element")
      }

      // ────────────────────────────────────────────────────────────────
      // DELETE_ACTION / DELETE_FLOW_LOGIC / DELETE_SUBFLOW / DELETE_TRIGGER
      // ────────────────────────────────────────────────────────────────
      case "delete_action":
      case "delete_flow_logic":
      case "delete_subflow":
      case "delete_trigger": {
        var delElemFlowId = await resolveFlowId(client, args.flow_id)
        var delElemLock = await ensureFlowEditingLock(client, delElemFlowId)
        if (!delElemLock.success)
          return createErrorResult("Flow is not open for editing. Call open_flow first. " + (delElemLock.warning || ""))
        var delElemType =
          action === "delete_action"
            ? "action"
            : action === "delete_flow_logic"
              ? "flowlogic"
              : action === "delete_subflow"
                ? "subflow"
                : "trigger"
        var delElemIds = String(args.element_id)
          .split(",")
          .map((id: string) => id.trim())

        // Map 'trigger' to the correct GraphQL key
        var delGraphQLType = delElemType === "trigger" ? "trigger" : delElemType
        var delResult = await deleteElementViaGraphQL(client, delElemFlowId, delGraphQLType, delElemIds)

        var delSummary = summary()
        if (delResult.success) {
          delSummary.success("Element(s) deleted").field("Type", delElemType).field("Deleted", delElemIds.join(", "))
          if (args.verify) {
            var delVerifyType =
              delElemType === "flowlogic" ? "flow_logic" : delElemType === "trigger" ? "trigger" : delElemType
            var delVerification = await verifyFlowState(client, delElemFlowId, {
              type: delVerifyType as any,
              id: delElemIds[0],
              deleted: true,
            })
            if (delResult.steps) delResult.steps.verification = delVerification
            delSummary.field("Verified deleted", delVerification.verified ? "yes" : "FAILED")
          }
        } else {
          delSummary.error("Failed to delete element: " + (delResult.error || "unknown"))
        }
        return delResult.success
          ? createSuccessResult({ action, ...delResult }, {}, delSummary.build())
          : createErrorResult(delResult.error || "Failed to delete element")
      }

      // ────────────────────────────────────────────────────────────────
      // ADD_STAGE — add a visual progress stage grouping actions
      // ────────────────────────────────────────────────────────────────
      case "add_stage": {
        var addStageFlowId = await resolveFlowId(client, args.flow_id)
        var addStageLock = await ensureFlowEditingLock(client, addStageFlowId)
        if (!addStageLock.success)
          return createErrorResult(
            "Flow is not open for editing. Call open_flow first. " + (addStageLock.warning || ""),
          )
        var addStageLabel = args.stage_label
        var addStageIndexes = args.stage_component_indexes || []
        var addStageOrder = args.stage_order ?? 0
        var addStageStates = args.stage_states
        var addStageAlwaysShow = args.stage_always_show

        var addStageResult = await addStageViaGraphQL(
          client,
          addStageFlowId,
          addStageLabel,
          addStageIndexes,
          addStageOrder,
          addStageStates,
          addStageAlwaysShow,
        )

        var addStageSummary = summary()
        if (addStageResult.success) {
          addStageSummary
            .success("Stage added via GraphQL")
            .field("Flow", addStageFlowId)
            .field("Label", addStageLabel)
            .field("Stage ID", addStageResult.stageId || "unknown")
            .field("Component Indexes", addStageIndexes.join(", "))
            .field("Order", String(addStageOrder))
          if (args.annotation) addStageSummary.field("Annotation", args.annotation)

          if (args.verify) {
            var addStageVerification = await verifyFlowState(client, addStageFlowId, {
              type: "stage",
              id: addStageResult.sysId || addStageResult.stageId,
            })
            if (addStageResult.steps) addStageResult.steps.verification = addStageVerification
            addStageSummary.field("Verified", addStageVerification.verified ? "yes" : "FAILED")
          }
          return createSuccessResult(
            withUpdateSetContext(
              {
                action: "add_stage",
                ...addStageResult,
                reminder:
                  "IMPORTANT: Call close_flow with flow_id='" +
                  addStageFlowId +
                  "' when you are done adding elements. Forgetting this will leave the flow locked.",
              },
              updateSetCtx,
            ),
            {},
            addStageSummary.build(),
          )
        }
        return createErrorResult(addStageResult.error || "Failed to add stage")
      }

      // ────────────────────────────────────────────────────────────────
      // UPDATE_STAGE — update an existing stage's properties
      // ────────────────────────────────────────────────────────────────
      case "update_stage": {
        var updStageFlowId = await resolveFlowId(client, args.flow_id)
        var updStageLock = await ensureFlowEditingLock(client, updStageFlowId)
        if (!updStageLock.success)
          return createErrorResult(
            "Flow is not open for editing. Call open_flow first. " + (updStageLock.warning || ""),
          )
        var updStageFields: any = {}
        if (args.stage_label !== undefined) updStageFields.label = args.stage_label
        if (args.stage_component_indexes !== undefined) updStageFields.componentIndexes = args.stage_component_indexes
        if (args.stage_order !== undefined) updStageFields.order = args.stage_order
        if (args.stage_states !== undefined) updStageFields.states = args.stage_states
        if (args.stage_always_show !== undefined) updStageFields.alwaysShow = args.stage_always_show

        var updStageResult = await updateStageViaGraphQL(client, updStageFlowId, args.element_id, updStageFields)

        var updStageSummary = summary()
        if (updStageResult.success) {
          updStageSummary
            .success("Stage updated")
            .field("Flow", updStageFlowId)
            .field("Stage ID", args.element_id)
            .field("Updated fields", Object.keys(updStageFields).join(", "))
        }
        if (!updStageResult.success) {
          updStageSummary.error("Failed to update stage: " + (updStageResult.error || "unknown"))
        }
        return updStageResult.success
          ? createSuccessResult({ action: "update_stage", ...updStageResult }, {}, updStageSummary.build())
          : createErrorResult(updStageResult.error || "Failed to update stage")
      }

      // ────────────────────────────────────────────────────────────────
      // DELETE_STAGE — remove stage(s) from the flow
      // ────────────────────────────────────────────────────────────────
      case "delete_stage": {
        var delStageFlowId = await resolveFlowId(client, args.flow_id)
        var delStageLock = await ensureFlowEditingLock(client, delStageFlowId)
        if (!delStageLock.success)
          return createErrorResult(
            "Flow is not open for editing. Call open_flow first. " + (delStageLock.warning || ""),
          )
        var delStageIds = String(args.element_id)
          .split(",")
          .map(function (id: string) {
            return id.trim()
          })

        var delStageResult = await deleteElementViaGraphQL(client, delStageFlowId, "stage", delStageIds)

        var delStageSummary = summary()
        if (delStageResult.success) {
          delStageSummary.success("Stage(s) deleted").field("Deleted", delStageIds.join(", "))
          if (args.verify) {
            var delStageVerification = await verifyFlowState(client, delStageFlowId, {
              type: "stage",
              id: delStageIds[0],
              deleted: true,
            })
            if (delStageResult.steps) delStageResult.steps.verification = delStageVerification
            delStageSummary.field("Verified deleted", delStageVerification.verified ? "yes" : "FAILED")
          }
        }
        if (!delStageResult.success) {
          delStageSummary.error("Failed to delete stage: " + (delStageResult.error || "unknown"))
        }
        return delStageResult.success
          ? createSuccessResult({ action: "delete_stage", ...delStageResult }, {}, delStageSummary.build())
          : createErrorResult(delStageResult.error || "Failed to delete stage")
      }

      // ────────────────────────────────────────────────────────────────
      // CHECK_EXECUTION — query flow execution contexts, runs & outputs
      // ────────────────────────────────────────────────────────────────
      case "check_execution": {
        var execFlowId = await resolveFlowId(client, args.flow_id)
        var execLimit = args.limit || 5
        var execSummary = summary()
        var execSteps: any = {}

        var ctxResp = await client.get(
          "/api/now/table/sys_flow_context?sysparm_query=flow=" +
            execFlowId +
            "^ORDERBYDESCsys_created_on&sysparm_fields=sys_id,state,status,started,ended,duration,error,output,trigger_record_table,trigger_record_id,sys_created_on&sysparm_display_value=all&sysparm_limit=" +
            execLimit,
        )
        var contexts = ctxResp.data?.result || []
        execSteps.contexts = contexts.length

        var runsResp = await client.get(
          "/api/now/table/sys_hub_flow_run?sysparm_query=flow=" +
            execFlowId +
            "^ORDERBYDESCsys_created_on&sysparm_fields=sys_id,state,started,ended,duration,trigger_record_table,trigger_record_id&sysparm_display_value=all&sysparm_limit=" +
            execLimit,
        )
        var runs = runsResp.data?.result || []
        execSteps.runs = runs.length

        var outputs: any[] = []
        if (contexts.length > 0) {
          var latestCtxId = typeof contexts[0].sys_id === "object" ? contexts[0].sys_id.value : contexts[0].sys_id
          try {
            var outResp = await client.get(
              "/api/now/table/sys_hub_flow_output?sysparm_query=flow_context=" +
                latestCtxId +
                "&sysparm_fields=sys_id,name,value,type&sysparm_display_value=all&sysparm_limit=20",
            )
            outputs = outResp.data?.result || []
          } catch (_) {}
        }
        execSteps.outputs = outputs.length

        var latest = contexts[0] || null
        var hasErrors = false
        if (latest) {
          var latestState =
            typeof latest.state === "object" ? latest.state.display_value || latest.state.value : latest.state
          var latestStatus =
            typeof latest.status === "object" ? latest.status.display_value || latest.status.value : latest.status
          var latestError =
            typeof latest.error === "object" ? latest.error.display_value || latest.error.value : latest.error
          hasErrors = !!(latestError && latestError !== "")
          execSummary
            .field("Flow", execFlowId)
            .field("Contexts found", String(contexts.length))
            .field("Runs found", String(runs.length))
            .field("Latest state", latestState || "unknown")
            .field("Latest status", latestStatus || "unknown")
          if (latest.started) execSummary.field("Started", String(latest.started))
          if (latest.ended) execSummary.field("Ended", String(latest.ended))
          if (latest.duration) execSummary.field("Duration", String(latest.duration))
          if (hasErrors) execSummary.error("Error: " + latestError)
          if (outputs.length > 0) execSummary.field("Outputs", String(outputs.length))
        }
        if (!latest) {
          execSummary.field("Flow", execFlowId).warning("No execution contexts found")
        }

        return createSuccessResult(
          {
            action: "check_execution",
            flow_id: execFlowId,
            contexts: contexts,
            runs: runs,
            outputs: outputs,
            has_errors: hasErrors,
            latest: latest
              ? {
                  sys_id: typeof latest.sys_id === "object" ? latest.sys_id.value : latest.sys_id,
                  state:
                    typeof latest.state === "object" ? latest.state.display_value || latest.state.value : latest.state,
                  status:
                    typeof latest.status === "object"
                      ? latest.status.display_value || latest.status.value
                      : latest.status,
                  error:
                    typeof latest.error === "object" ? latest.error.display_value || latest.error.value : latest.error,
                  started: latest.started,
                  ended: latest.ended,
                  duration: latest.duration,
                }
              : null,
            steps: execSteps,
          },
          {},
          execSummary.build(),
        )
      }

      // ────────────────────────────────────────────────────────────────
      // CHECKOUT / OPEN_FLOW — acquire Flow Designer editing lock (safeEdit create)
      // ────────────────────────────────────────────────────────────────
      case "checkout":
      case "open_flow": {
        var openFlowId = await resolveFlowId(client, args.flow_id)
        var openSummary = summary()
        var openDebug: any = {}

        // Step 1: Load flow data via processflow GET (same as UI)
        try {
          await client.get("/api/now/processflow/flow/" + openFlowId)
        } catch (_) {
          /* best-effort — flow data load is not critical for lock acquisition */
        }

        // Step 2: Pre-release any existing locks (the OAuth service account may hold a stale lock
        // from a previous session, and safeEdit(upsert) may fail for the SAME user's stale lock)
        var preRelease = await releaseFlowEditingLock(client, openFlowId)
        openDebug.pre_release = {
          success: preRelease.success,
          safe_edit_cleaned: preRelease.debug?.safe_edit_records_cleaned,
          flow_lock_cleaned: preRelease.debug?.flow_lock_records_cleaned,
        }
        // Brief delay to let ServiceNow propagate the lock deletion
        await new Promise(function (resolve) {
          setTimeout(resolve, 1500)
        })

        // Step 3: Acquire editing lock via safeEdit create mutation + REST fallback
        var lockResult = await acquireFlowEditingLock(client, openFlowId)
        openDebug.acquire = lockResult.debug
        if (lockResult.success) {
          openSummary
            .success("Flow opened for editing (lock acquired)")
            .field("Flow", openFlowId)
            .line("You can now use add_action, add_flow_logic, etc. Call close_flow when done.")
          return createSuccessResult(
            {
              action: "open_flow",
              flow_id: openFlowId,
              editing_session: true,
              lock_acquired_at: new Date().toISOString(),
              lock_debug: openDebug,
              lock_warning:
                "IMPORTANT: Editing lock is held. You MUST call close_flow with flow_id='" +
                openFlowId +
                "' when done editing.",
              next_step: "Flow is open. Add actions/logic, then call close_flow to release the lock.",
            },
            {},
            openSummary.build(),
          )
        }

        // Step 4: Lock still failed — try force cleanup of ALL lock tables + longer delay + retry
        openSummary.line("Lock acquisition failed after pre-release, attempting aggressive cleanup...")
        openDebug.first_attempt_error = lockResult.error
        // Aggressively clean all lock tables (same as force_unlock)
        try {
          var seResp = await client.get("/api/now/table/sys_hub_flow_safe_edit", {
            params: { sysparm_query: "document_id=" + openFlowId, sysparm_fields: "sys_id", sysparm_limit: 50 },
          })
          var seRecs = seResp.data?.result || []
          for (var sei = 0; sei < seRecs.length; sei++) {
            try {
              await client.delete("/api/now/table/sys_hub_flow_safe_edit/" + seRecs[sei].sys_id)
            } catch (_) {}
          }
          openDebug.force_safe_edit_deleted = seRecs.length
        } catch (_) {}
        try {
          var flResp = await client.get("/api/now/table/sys_hub_flow_lock", {
            params: { sysparm_query: "flow=" + openFlowId, sysparm_fields: "sys_id", sysparm_limit: 50 },
          })
          var flRecs = flResp.data?.result || []
          for (var fli = 0; fli < flRecs.length; fli++) {
            try {
              await client.delete("/api/now/table/sys_hub_flow_lock/" + flRecs[fli].sys_id)
            } catch (_) {}
          }
          openDebug.force_flow_lock_deleted = flRecs.length
        } catch (_) {}
        // Longer delay after aggressive cleanup
        await new Promise(function (resolve) {
          setTimeout(resolve, 2000)
        })
        var retryResult = await acquireFlowEditingLock(client, openFlowId)
        openDebug.retry = retryResult.debug
        if (retryResult.success) {
          openSummary
            .success("Flow opened for editing (stale lock cleared)")
            .field("Flow", openFlowId)
            .line("You can now use add_action, add_flow_logic, etc. Call close_flow when done.")
          return createSuccessResult(
            {
              action: "open_flow",
              flow_id: openFlowId,
              editing_session: true,
              stale_lock_cleared: true,
              lock_acquired_at: new Date().toISOString(),
              lock_debug: openDebug,
              lock_warning:
                "IMPORTANT: Editing lock is held. You MUST call close_flow with flow_id='" +
                openFlowId +
                "' when done editing.",
              next_step: "Flow is open. Add actions/logic, then call close_flow to release the lock.",
            },
            {},
            openSummary.build(),
          )
        }

        openSummary
          .error("Cannot open flow: " + (retryResult.error || "lock acquisition failed"))
          .field("Flow", openFlowId)
          .line("Try force_unlock first, then open_flow again.")
        return createErrorResult(
          "Cannot open flow for editing: " +
            (retryResult.error || "lock acquisition failed") +
            " | debug: " +
            JSON.stringify(openDebug),
        )
      }

      // ────────────────────────────────────────────────────────────────
      // CLOSE_FLOW — release Flow Designer editing lock (safeEdit)
      // ────────────────────────────────────────────────────────────────
      case "close_flow": {
        var closeFlowId = await resolveFlowId(client, args.flow_id)
        var closeResult = await releaseFlowEditingLock(client, closeFlowId)
        var closeSummary = summary()
        if (closeResult.success) {
          closeSummary.success("Flow saved and editing lock released").field("Flow", closeFlowId)
        } else if (closeResult.compilationError) {
          // Compilation failed but the lock IS released (safeEdit(delete) was called + REST cleanup).
          // Treat as success with warning, not as a fatal error.
          closeSummary
            .warning("Lock released but flow compilation had warnings: " + closeResult.compilationError)
            .field("Flow", closeFlowId)
            .line("The flow may need fixes before it can be activated/published.")
        } else {
          closeSummary.warning("Lock release returned false (flow may not have been locked)").field("Flow", closeFlowId)
        }
        var closeData: any = {
          action: "close_flow",
          flow_id: closeFlowId,
          lock_released: true, // Lock is always released (GraphQL safeEdit(delete) + REST cleanup both run)
          compilation_success: closeResult.success,
        }
        if (closeResult.compilationError) {
          closeData.compilation_warning = closeResult.compilationError
          closeData.debug = closeResult.debug
          closeData.next_step =
            "The editing lock has been released. The compilation warning means the flow may have issues (e.g. incomplete conditions). Fix the flow elements and try activating again."
        }
        return createSuccessResult(closeData, {}, closeSummary.build())
      }

      // ────────────────────────────────────────────────────────────────
      // FORCE_UNLOCK — aggressively clear all locks on a flow (ghost lock recovery)
      // ────────────────────────────────────────────────────────────────
      case "force_unlock": {
        var unlockFlowId = await resolveFlowId(client, args.flow_id)
        var unlockSummary = summary()
        var unlockSteps: Record<string, any> = {}

        // 1. GraphQL safeEdit(delete)
        try {
          var unlockMutation =
            'mutation { global { snFlowDesigner { safeEdit(safeEditInput: {delete: "' +
            unlockFlowId +
            '"}) { deleteResult { deleteSuccess id __typename } __typename } __typename } __typename } }'
          var unlockGqlResp = await client.post("/api/now/graphql", { variables: {}, query: unlockMutation })
          unlockSteps.graphql_delete =
            unlockGqlResp.data?.data?.global?.snFlowDesigner?.safeEdit?.deleteResult?.deleteSuccess === true
        } catch (_) {
          unlockSteps.graphql_delete = "error"
        }

        // 2. Delete sys_hub_flow_safe_edit records (with age check)
        var deletedRecords = 0
        var youngLocksSkipped = 0
        var forceAll = args.force_unlock_all === true
        var LOCK_AGE_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes
        try {
          var seResp = await client.get("/api/now/table/sys_hub_flow_safe_edit", {
            params: {
              sysparm_query: "document_id=" + unlockFlowId,
              sysparm_fields: "sys_id,user,sys_created_by,sys_created_on",
              sysparm_limit: 50,
            },
          })
          var seRecords = seResp.data?.result || []
          for (var se = 0; se < seRecords.length; se++) {
            var lockRecord = seRecords[se]
            var lockAge = Date.now() - new Date(str(lockRecord.sys_created_on)).getTime()
            var isYoung = !isNaN(lockAge) && lockAge < LOCK_AGE_THRESHOLD_MS

            if (isYoung && !forceAll) {
              // Skip young locks — they may belong to an active user
              youngLocksSkipped++
              continue
            }

            try {
              await client.delete("/api/now/table/sys_hub_flow_safe_edit/" + lockRecord.sys_id)
              deletedRecords++
            } catch (_) {
              /* best-effort */
            }
          }
          unlockSteps.safe_edit_records_found = seRecords.length
          unlockSteps.safe_edit_records_deleted = deletedRecords
          unlockSteps.young_locks_skipped = youngLocksSkipped
        } catch (_) {
          unlockSteps.safe_edit_query = "error"
        }

        // 3. Check sys_hub_flow_lock table (some instances use this)
        try {
          var lockResp = await client.get("/api/now/table/sys_hub_flow_lock", {
            params: { sysparm_query: "flow=" + unlockFlowId, sysparm_fields: "sys_id", sysparm_limit: 50 },
          })
          var lockRecords = lockResp.data?.result || []
          var deletedLocks = 0
          for (var lk = 0; lk < lockRecords.length; lk++) {
            try {
              await client.delete("/api/now/table/sys_hub_flow_lock/" + lockRecords[lk].sys_id)
              deletedLocks++
            } catch (_) {
              /* best-effort */
            }
          }
          unlockSteps.flow_lock_records_found = lockRecords.length
          unlockSteps.flow_lock_records_deleted = deletedLocks
        } catch (_) {
          unlockSteps.flow_lock_table = "not_available"
        }

        unlockSummary.success("Force unlock completed").field("Flow", unlockFlowId)
        if (deletedRecords > 0) unlockSummary.line("Deleted " + deletedRecords + " safe_edit record(s)")
        if (youngLocksSkipped > 0) {
          unlockSummary.warning(
            youngLocksSkipped +
              " lock(s) < 5 min old were skipped (may belong to active user). Use force_unlock_all=true to override.",
          )
        }
        unlockSummary.line("You can now try open_flow again.")

        var unlockNextStep = "Lock cleared. Use open_flow to start editing."
        if (youngLocksSkipped > 0) {
          unlockNextStep =
            youngLocksSkipped +
            " young lock(s) skipped. If the flow is still locked, retry with force_unlock_all=true to delete all locks including active ones."
        }

        return createSuccessResult(
          {
            action: "force_unlock",
            flow_id: unlockFlowId,
            steps: unlockSteps,
            young_locks_skipped: youngLocksSkipped,
            next_step: unlockNextStep,
          },
          {},
          unlockSummary.build(),
        )
      }

      default:
        throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "Unknown action: " + action)
    }
  } catch (error: any) {
    // Safety: only release lock on truly UNRECOVERABLE errors (network, auth, timeout).
    // Validation errors, "flow not found", and GraphQL business-logic errors should NOT
    // kill the editing session — the agent can fix the input and retry.
    var MUTATION_ACTIONS = [
      "create",
      "create_subflow",
      "add_trigger",
      "update_trigger",
      "add_action",
      "add_flow_logic",
      "add_subflow",
      "update_action",
      "update_flow_logic",
      "update_subflow",
      "delete_action",
      "delete_flow_logic",
      "delete_subflow",
      "delete_trigger",
      "add_stage",
      "update_stage",
      "delete_stage",
    ]
    var isUnrecoverableError =
      error.isAxiosError ||
      (error instanceof SnowFlowError &&
        [
          ErrorType.NETWORK_ERROR,
          ErrorType.TIMEOUT,
          ErrorType.TIMEOUT_ERROR,
          ErrorType.CONNECTION_RESET,
          ErrorType.UNAUTHORIZED,
        ].indexOf(error.type) !== -1)
    if (client && args.flow_id && isUnrecoverableError && MUTATION_ACTIONS.indexOf(action) !== -1) {
      try {
        await releaseFlowEditingLock(client, await resolveFlowId(client, args.flow_id))
      } catch (lockReleaseErr: any) {
        console.warn(
          "[snow_manage_flow] Failed to release lock on error recovery: " + (lockReleaseErr.message || "unknown"),
        )
      }
    }

    if (error instanceof SnowFlowError) {
      return createErrorResult(error)
    }
    if (error.response?.status === 403) {
      return createErrorResult(
        "Permission denied (403): Your ServiceNow user lacks Flow Designer permissions. " +
          'Required roles: "flow_designer" or "admin". Contact your ServiceNow administrator.',
      )
    }
    return createErrorResult(new SnowFlowError(ErrorType.UNKNOWN_ERROR, error.message, { originalError: error }))
  }
}

export const version = "6.0.0"
export const author = "Serac Team"
