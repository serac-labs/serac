/**
 * Meta-Tools for Lazy Loading Mode
 *
 * When SNOW_LAZY_TOOLS=true, only these 2 tools are registered in tools/list.
 * This reduces token usage from ~71k to ~2k while keeping all functionality available.
 *
 * Workflow:
 * 1. AI calls tool_search({query: "incidents"})
 * 2. Returns list of matching tools with their schemas
 * 3. AI calls tool_execute({tool: "snow_query_incidents", args: {...}})
 * 4. Tool is executed and result returned
 *
 * Session-based tool enabling:
 * - When enable=true (default), found tools are enabled for the current session
 * - Enabled tools are persisted to disk and restored on restart
 * - This allows filtering tools/list to only show enabled tools
 *
 * ...but only where enablement is actually honoured. See
 * `enablementIsHonoured()` below: on a server that registered its catalog as
 * non-deferred (which is exactly what transports/http-entry.ts does, so the
 * portal gets the full tool list) enabling a tool changes nothing, and
 * `tool_search` must not report that it did.
 *
 * Transport split, stated once:
 * - stdio is single-tenant — one process, one user — so per-session state is
 *   real state and lives on disk (`FileToolSessionStore`).
 * - HTTP is multi-tenant — one process, every customer — so a request we
 *   cannot place in a tenant gets no shared session state at all.
 *
 * The enabled-tools store is reached through `resolveTenantScope()` from
 * `shared/tenant-scope.ts` here AND in both of its readers
 * (`handlers/list-tools.ts`, `handlers/call-tool.ts`) — writer and readers have
 * to agree on the scope string or this tool reports `[ENABLED]` for tools the
 * next `tools/list` omits. Flat cache keys elsewhere in the package
 * (`shared/auth.ts`, `shared/scripted-exec.ts`, `shared/update-set-guard.ts`,
 * `tools/blast-radius/.../deep-search.ts`) compose that scope with
 * `tenantScopedKey()`. Note what is NOT claimed: `handlers/call-tool.ts`
 * deliberately skips the deferred check on HTTP (the portal budgets tools
 * client-side), so the enabled set is a stdio mechanism that HTTP merely
 * refuses to corrupt.
 *
 * @see https://www.anthropic.com/engineering/advanced-tool-use
 */

import { type MCPToolDefinition, type ServiceNowContext } from "../../shared/types.js"
import { toolRegistry } from "../../shared/tool-registry.js"
import { ToolSearch } from "../../shared/tool-search.js"
import { STDIO_TENANT, resolveTenantScope } from "../../shared/tenant-scope.js"
import { isWriteTool } from "../../shared/instance-map-hook.js"
import {
  guardKey,
  requiresUpdateSet,
  updateSetActive,
  recordUpdateSetSkip,
  observeUpdateSetTool,
  confirmationFlag,
  prodWriteBlockMessage,
  updateSetBlockMessage,
  getActiveUpdateSet,
  driftScope,
  needsCurrentReassert,
  markCurrentAsserted,
} from "../../shared/update-set-guard.js"
import { setCurrentUpdateSet } from "../../shared/update-set-rebind.js"

// ============================================================================
// tool_search - Search for available tools
// ============================================================================

export const tool_search_def: MCPToolDefinition = {
  name: "tool_search",
  description: `Search for available ServiceNow tools when you need specialized functionality.

This tool searches through ALL 235+ available tools including:
- Core operations (queries, CRUD, bulk operations)
- Deployment (widgets, UI pages, script includes)
- CMDB and asset management
- Change/incident/problem management
- Knowledge base and service catalog
- Automation (scripts, scheduled jobs, events)
- Security (ACLs, policies, compliance)
- Reporting (dashboards, KPIs, reports)
- And many more specialized tools

Each hit carries a status, and that status — not this description — is the
authority on whether you can call it:
- [AVAILABLE] — already callable on this server; nothing had to be enabled.
- [ENABLED]   — deferred, and enabled for this session (by this call or an
                earlier one). Callable now.
- [DEFERRED]  — still NOT callable. This happens when the request carries no
                session id, or no resolvable tenant on a multi-tenant server;
                usage_hint says which. tool_execute will refuse it.

The response also reports what this call actually changed: enabled_tools lists
the tools it wrote into session state, and is empty when it wrote nothing.

Example workflow:
1. tool_search({query: "incident query"})
   → Returns: snow_query_incidents [ENABLED], snow_query_table [ENABLED]
2. tool_execute({tool: "snow_query_incidents", args: {query: "priority=1"}})
   → Executes the tool and returns results`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'Search query to find relevant tools. Examples: "incident", "widget deploy", "cmdb", "update set", "knowledge article", "change request"',
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 10)",
        default: 10,
      },
      enable: {
        type: "boolean",
        description:
          "Enable found deferred tools for this session (default: true). Only tools this server actually gates on the enabled set are written; " +
          "on a server that lists its whole catalog there is nothing to enable and the hits come back [AVAILABLE]. Set false to search without touching session state.",
        default: true,
      },
    },
    required: ["query"],
  },
}

/**
 * Transport allowlist check shared by the meta path. call-tool.ts enforces
 * `transports` for direct dispatch; tool_search/tool_execute must apply the
 * same rule or they become a bypass for stdio-only tools over HTTP.
 * Fail closed: an absent origin is treated as "http".
 */
function allowedOnTransport(definition: { transports?: string[] } | undefined, origin: string | undefined): boolean {
  const transports = definition?.transports
  if (!transports) return true
  return transports.includes(origin ?? "http")
}

/**
 * Does enabling this tool change anything the rest of the server will honour?
 *
 * Only two kinds of tool are gated on the enabled-set:
 *   - index entries flagged `deferred: true` — handlers/list-tools.ts hides
 *     them until they are enabled, and canExecuteTool() refuses them;
 *   - tools missing from the index entirely — both of those code paths
 *     default an unknown tool to deferred.
 *
 * Everything else is already listed and already callable, so writing it into
 * the session store is a write nobody reads. `transports/http-entry.ts`
 * registers the entire catalog with `deferred: false` (deliberately: the
 * portal does its own client-side tool budgeting), which means on the shipped
 * HTTP server this returns false for every tool and `tool_search` stops
 * touching session state altogether — matching the "no session state is
 * retained between requests" contract in transports/http.ts.
 */
const enablementIsHonoured = (toolId: string): boolean => ToolSearch.getToolFromIndex(toolId)?.deferred ?? true

interface EnablementOutcome {
  /** Tool IDs actually written to the session store by this call. */
  enabled: string[]
  /** Everything enabled for this (tenant, session) after the write. */
  enabledSet: Set<string>
  /** Hits that needed enabling but did not get it — see `reason`. */
  pending: number
  reason: "enabled" | "nothing-deferred" | "no-session" | "no-tenant-scope" | "not-requested"
}

/**
 * Write the subset of `toolIds` whose enablement is honoured, then read the
 * store back so reported statuses come from the store rather than from what
 * we hoped we did.
 *
 * Fail closed on a missing tenant scope: enabling into a shared bucket is how
 * one tenant ends up steering another tenant's tool list, so we skip the write
 * and report the refusal instead of quietly claiming success.
 */
async function applyEnablement(
  toolIds: string[],
  sessionId: string | undefined,
  tenantScope: string | undefined,
  enableRequested: boolean,
): Promise<EnablementOutcome> {
  const honoured = toolIds.filter(enablementIsHonoured)
  // Read the store even when we write nothing: a tool an earlier tool_search
  // enabled is still [ENABLED], and saying otherwise is the same class of lie.
  const readEnabled = async (): Promise<Set<string>> =>
    sessionId && tenantScope ? await ToolSearch.getEnabledTools(sessionId, tenantScope) : new Set<string>()

  if (!enableRequested) {
    return { enabled: [], enabledSet: await readEnabled(), pending: 0, reason: "not-requested" }
  }
  if (honoured.length === 0) {
    return { enabled: [], enabledSet: await readEnabled(), pending: 0, reason: "nothing-deferred" }
  }
  if (!sessionId) {
    return { enabled: [], enabledSet: new Set<string>(), pending: honoured.length, reason: "no-session" }
  }
  if (!tenantScope) {
    return { enabled: [], enabledSet: new Set<string>(), pending: honoured.length, reason: "no-tenant-scope" }
  }
  await ToolSearch.enableTools(sessionId, honoured, tenantScope)
  console.error(`[tool_search] Enabled ${honoured.length} deferred tool(s) for ${tenantScope}/${sessionId}`)
  return { enabled: honoured, enabledSet: await readEnabled(), pending: 0, reason: "enabled" }
}

/**
 * Status label for one hit, derived from the same two facts the rest of the
 * server uses (`ToolSearch.getToolStatus`): is it deferred, and is it in this
 * (tenant, session)'s enabled set.
 */
const statusFor = (toolId: string, enabledSet: Set<string>): "[AVAILABLE]" | "[ENABLED]" | "[DEFERRED]" => {
  if (!enablementIsHonoured(toolId)) return "[AVAILABLE]"
  return enabledSet.has(toolId) ? "[ENABLED]" : "[DEFERRED]"
}

/**
 * The sentence appended to `usage_hint`. It states what this call did to
 * session state — including "nothing", which is the honest answer on a server
 * whose catalog is not deferred.
 */
const enablementNote = (outcome: EnablementOutcome, firstTool: string | undefined): string => {
  if (outcome.reason === "enabled") {
    return (
      `\n\n✓ ${outcome.enabled.length} tool(s) are now ENABLED for this session.\n` +
      `Call them via tool_execute. Example:\ntool_execute({tool: "${outcome.enabled[0]}", args: {...}})`
    )
  }
  if (outcome.reason === "no-tenant-scope") {
    return (
      `\n\n⚠ ${outcome.pending} deferred tool(s) were NOT enabled: this request carries no tenant scope, ` +
      `and session state shared across tenants is a leak. Re-issue with a resolved tenantId (HTTP) or over stdio.`
    )
  }
  if (outcome.reason === "no-session") {
    return (
      `\n\n⚠ ${outcome.pending} deferred tool(s) were NOT enabled: this request carries no session id, ` +
      `so there is nothing to attach the enablement to. They stay [DEFERRED] and tool_execute will refuse them.`
    )
  }
  if (outcome.reason === "nothing-deferred") {
    return (
      `\n\nNo session state was changed — these tools are already available on this server. ` +
      `Call them directly: tool_execute({tool: "${firstTool ?? "snow_query_table"}", args: {...}})`
    )
  }
  return ""
}

export async function tool_search_exec(
  args: { query: string; limit?: number; enable?: boolean },
  context: ServiceNowContext,
): Promise<any> {
  const limit = args.limit || 10
  const enableRequested = args.enable !== false // Default to true
  const sessionId = context.sessionId
  // Tenant-scope every ToolSearch call so two HTTP tenants with the same
  // session ID cannot enable each other's tools. `undefined` means the caller
  // cannot be placed in a tenant — it then gets no shared session state.
  const tenantScope = resolveTenantScope(context)

  // Use ToolSearch.search() for consistent behavior with snow-flow
  // This searches the tool index populated at server startup
  const searchResults = ToolSearch.search(args.query, limit).filter((entry) =>
    allowedOnTransport(toolRegistry.getTool(entry.id)?.definition, context.origin),
  )

  // If no results from index, fall back to toolRegistry direct search
  // This handles the case where the index hasn't been populated yet
  if (searchResults.length === 0) {
    // Fallback: search toolRegistry directly
    const query = args.query.toLowerCase()
    const queryWords = query.split(/\s+/).filter((w) => w.length > 2)
    const allTools = toolRegistry
      .getToolDefinitions()
      .filter((tool) => allowedOnTransport(tool, context.origin))

    const scored = allTools.map((tool) => {
      let score = 0
      const nameLower = tool.name.toLowerCase()
      const descLower = tool.description.toLowerCase()

      if (nameLower === query) score += 100
      if (nameLower.includes(query)) score += 50
      const queryPart = query.replace(/^snow_?/, "")
      if (nameLower.includes(queryPart)) score += 40
      if (descLower.includes(query)) score += 20

      for (const word of queryWords) {
        if (nameLower.includes(word)) score += 15
        if (descLower.includes(word)) score += 5
      }

      const registeredTool = toolRegistry.getTool(tool.name)
      if (registeredTool && registeredTool.domain.toLowerCase().includes(query)) {
        score += 30
      }

      return { tool, score, domain: registeredTool?.domain || "unknown" }
    })

    const fallbackResults = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    if (fallbackResults.length === 0) {
      const domains = toolRegistry.getAvailableDomains().slice(0, 15)
      return {
        success: false,
        message: `No tools found matching "${args.query}"`,
        suggestion: `Try different keywords. Available domains: ${domains.join(", ")}`,
        available_domains: domains,
      }
    }

    // Enable and format fallback results. These hits come from the registry,
    // not the index, so many of them have no index entry at all — those DO
    // need enabling (list-tools and canExecuteTool treat unknown tools as
    // deferred), which is why the decision is per-tool and not per-branch.
    const outcome = await applyEnablement(
      fallbackResults.map((r) => r.tool.name),
      sessionId,
      tenantScope,
      enableRequested,
    )

    const formattedTools = fallbackResults.map((r, i) => {
      const params = r.tool.inputSchema?.properties || {}
      const required = r.tool.inputSchema?.required || []
      const paramList = Object.entries(params).map(([name, prop]: [string, any]) => {
        const isRequired = required.includes(name)
        const type = prop.type || "any"
        return `    ${isRequired ? "*" : ""}${name}: ${type}${prop.description ? ` - ${prop.description.substring(0, 80)}` : ""}`
      })
      return {
        rank: i + 1,
        name: r.tool.name,
        status: statusFor(r.tool.name, outcome.enabledSet),
        domain: r.domain,
        description: r.tool.description.substring(0, 200) + (r.tool.description.length > 200 ? "..." : ""),
        parameters: paramList.length > 0 ? paramList.slice(0, 5) : ["(no parameters)"],
        has_more_params: paramList.length > 5,
      }
    })

    const enabledMsg = enablementNote(outcome, fallbackResults[0]?.tool.name)

    return {
      success: true,
      query: args.query,
      count: fallbackResults.length,
      // Reports what this call did to session state, not what it was asked to do.
      enabled: outcome.enabled.length > 0,
      enabled_tools: outcome.enabled,
      sessionId: sessionId || null,
      tools: formattedTools,
      usage_hint: `To use a tool, call: tool_execute({tool: "${fallbackResults[0]?.tool.name}", args: {...}})${enabledMsg}`,
    }
  }

  // Process results from ToolSearch.search().
  // Only the deferred hits are written to the session store — enabling a tool
  // that is already listed and already callable is a write nobody reads, and
  // reporting it as "now ENABLED" would be a promise the next request cannot
  // keep. See enablementIsHonoured().
  const outcome = await applyEnablement(
    searchResults.map((t) => t.id),
    sessionId,
    tenantScope,
    enableRequested,
  )

  // Format results with schema info from toolRegistry
  const formattedTools = searchResults.map((entry, i) => {
    const tool = toolRegistry.getTool(entry.id)
    const toolDef = tool?.definition
    const params = toolDef?.inputSchema?.properties || {}
    const required = toolDef?.inputSchema?.required || []

    const paramList = Object.entries(params).map(([name, prop]: [string, any]) => {
      const isRequired = required.includes(name)
      const type = prop.type || "any"
      return `    ${isRequired ? "*" : ""}${name}: ${type}${prop.description ? ` - ${prop.description.substring(0, 80)}` : ""}`
    })

    return {
      rank: i + 1,
      name: entry.id,
      // Read out of the session store, so [ENABLED] also covers tools a
      // previous tool_search in this session enabled.
      status: statusFor(entry.id, outcome.enabledSet),
      domain: entry.category,
      description: entry.description + (entry.description.length >= 200 ? "..." : ""),
      parameters: paramList.length > 0 ? paramList.slice(0, 5) : ["(no parameters)"],
      has_more_params: paramList.length > 5,
    }
  })

  const enabledMsg = enablementNote(outcome, searchResults[0]?.id)

  return {
    success: true,
    query: args.query,
    count: searchResults.length,
    // Reports what this call did to session state, not what it was asked to do.
    enabled: outcome.enabled.length > 0,
    enabled_tools: outcome.enabled,
    sessionId: sessionId || null,
    tools: formattedTools,
    usage_hint: `To use a tool, call: tool_execute({tool: "${searchResults[0]?.id}", args: {...}})${enabledMsg}`,
  }
}

// ============================================================================
// tool_execute - Execute any tool by name
// ============================================================================

export const tool_execute_def: MCPToolDefinition = {
  name: "tool_execute",
  description: `Execute any ServiceNow tool by name. Use this after tool_search to call the tools you found.

This is the gateway to ALL 235+ ServiceNow tools. After searching with tool_search,
use this tool to execute the found tools.

Example:
1. tool_search({query: "query incidents"})
   → Found: snow_query_incidents
2. tool_execute({
     tool: "snow_query_incidents",
     args: { query: "priority=1^state!=7", limit: 10 }
   })
   → Returns the query results

The 'args' parameter should match the tool's input schema from tool_search results.`,
  inputSchema: {
    type: "object",
    properties: {
      tool: {
        type: "string",
        description: "The exact tool name to execute (from tool_search results)",
      },
      args: {
        type: "object",
        description: "Arguments to pass to the tool (must match tool's input schema)",
        additionalProperties: true,
      },
    },
    required: ["tool", "args"],
  },
}

export async function tool_execute_exec(
  args: { tool: string; args: Record<string, any> },
  context: ServiceNowContext,
): Promise<any> {
  const toolName = args.tool
  const toolArgs = args.args || {}
  const sessionId = context.sessionId
  // See tool_search_exec — the tenant scope keys every ToolSessionStore lookup.
  const tenantScope = resolveTenantScope(context)

  // Get tool from registry
  const tool = toolRegistry.getTool(toolName)

  if (!tool) {
    // Try to find similar tools
    const allTools = toolRegistry.getToolDefinitions()
    const similar = allTools
      .filter((t) => t.name.includes(toolName) || toolName.includes(t.name.replace("snow_", "")))
      .slice(0, 5)
      .map((t) => t.name)

    return {
      success: false,
      error: `Tool not found: ${toolName}`,
      suggestion:
        similar.length > 0
          ? `Did you mean one of these? ${similar.join(", ")}`
          : "Use tool_search to find available tools",
      hint: 'Use tool_search({query: "your task"}) to find the right tool',
    }
  }

  // Enforce the transport allowlist exactly like the direct dispatch path in
  // call-tool.ts — tool_execute must not be a bypass for stdio-only tools
  // (local filesystem + child processes) over the multi-tenant HTTP transport.
  if (!allowedOnTransport(tool.definition, context.origin)) {
    return {
      success: false,
      error:
        `Tool "${toolName}" is not available over the ${context.origin ?? "http"} transport ` +
        `(allowed transports: ${(tool.definition.transports ?? []).join(", ")}).`,
    }
  }
  const forbidden = tool.definition.httpForbiddenArgs
  if ((context.origin ?? "http") === "http" && forbidden) {
    for (const arg of forbidden) {
      if (toolArgs[arg] !== undefined) {
        return {
          success: false,
          error:
            `Tool "${toolName}" cannot accept the "${arg}" argument over HTTP transport ` +
            `(it would touch the shared filesystem). Use the inline-content equivalent instead.`,
        }
      }
    }
  }

  // Mirror the write-guards from the direct dispatch path (call-tool.ts):
  // without them tool_execute is a bypass around the prod-write and
  // update-set confirmations. Same messages, same lenient flag parsing.
  const prodWrite = context.environmentType === "production" && isWriteTool(tool.definition)
  if (prodWrite && !confirmationFlag(toolArgs.__confirmProd)) {
    return { success: false, error: prodWriteBlockMessage(toolName) }
  }
  const usKey = guardKey(context.tenantId, sessionId, context.instanceUrl)
  if (confirmationFlag(toolArgs.__skipUpdateSet)) {
    recordUpdateSetSkip(usKey)
  }
  if (requiresUpdateSet(tool.definition, toolArgs)) {
    if (!updateSetActive(usKey)) {
      return { success: false, error: updateSetBlockMessage(toolName) }
    }
    // Re-bind the chat's update set if another chat moved the per-user current
    // set away (mirrors call-tool.ts). Best-effort: a failed re-bind proceeds.
    const bound = getActiveUpdateSet(usKey)
    if (bound?.sysId) {
      const scope = driftScope(context.tenantId, context.instanceUrl)
      if (needsCurrentReassert(scope, bound.sysId)) {
        try {
          await setCurrentUpdateSet(context, bound.sysId)
          markCurrentAsserted(scope, bound.sysId)
        } catch (rebindError: any) {
          console.error(`[MetaTool] update-set re-bind failed for ${toolName}: ${rebindError?.message ?? rebindError}`)
        }
      }
    }
  }

  // Check if tool is deferred and needs to be enabled first.
  // Without a provable tenant we must not read some other tenant's enabled
  // set, so we look the tool up with no session: always-available tools still
  // run, deferred ones fail closed. (`tenantScope ?? STDIO_TENANT` is then
  // never consulted — no session means no store lookup.)
  const enablementSession = tenantScope ? sessionId : undefined
  const storeScope = tenantScope ?? STDIO_TENANT
  const canExecute = await ToolSearch.canExecuteTool(enablementSession, toolName, storeScope)
  if (!canExecute) {
    const toolStatus = await ToolSearch.getToolStatus(enablementSession, toolName, storeScope)
    const queryHint = toolName.replace("snow_", "").replace(/_/g, " ")
    return {
      success: false,
      error: `Tool "${toolName}" is ${toolStatus} and must be enabled first`,
      hint: `Use tool_search({query: "${queryHint}"}) to enable this tool`,
      status: toolStatus,
    }
  }

  // Execute the tool. Strip the guard flags so executors never see them,
  // and feed update-set lifecycle tools into the guard state — in lazy
  // mode (TUI) snow_ensure_active_update_set runs through THIS path, so
  // without the observe call the guard could never be lifted.
  const execArgs = Object.fromEntries(
    Object.entries(toolArgs).filter(([k]) => k !== "__confirmProd" && k !== "__skipUpdateSet"),
  )
  try {
    console.error(`[MetaTool] Executing via tool_execute: ${toolName}`)
    const result = await tool.executor(execArgs, context)
    observeUpdateSetTool(toolName, execArgs, result, usKey)
    return {
      success: true,
      tool: toolName,
      result,
    }
  } catch (error: any) {
    return {
      success: false,
      tool: toolName,
      error: error.message,
      hint: "Check tool_search results for correct parameter format",
    }
  }
}

// ============================================================================
// Export meta-tools array for easy registration
// ============================================================================

export const META_TOOLS = [
  { definition: tool_search_def, executor: tool_search_exec },
  { definition: tool_execute_def, executor: tool_execute_exec },
]
