/**
 * MCP `ListTools` request handler.
 *
 * Returns the tools available to the current session, respecting:
 *   - Lazy loading (deferred tools hidden until enabled via tool_search)
 *   - Domain filtering (SNOW_TOOL_DOMAINS env var)
 *   - Role-based filtering (JWT payload from request context)
 */

import { toolRegistry } from "../shared/tool-registry.js"
import { filterToolsByRole } from "../shared/permission-validator.js"
import { META_TOOLS } from "../tools/meta/index.js"
import { ToolSearch } from "../shared/tool-search.js"
import { mcpDebug } from "../../shared/mcp-debug.js"
import { MCPToolDefinition } from "../shared/types.js"
import { HandlerDeps } from "./types.js"

export const listTools = (deps: HandlerDeps) => async (request: any, extra?: any) => {
  const ctx = await deps.resolveContext(request, extra)
  // Fail fast if an HTTP resolver forgets to set tenantId — falling back
  // to the "stdio" sentinel under HTTP traffic would silently share
  // ToolSessionStore state across tenants.
  if (ctx.origin === "http" && !ctx.serviceNow.tenantId) {
    throw new Error(
      "HTTP transport resolver must populate serviceNow.tenantId — refusing to handle the request to avoid cross-tenant leaks.",
    )
  }
  const sessionId = ctx.sessionId
  const tenantId = ctx.serviceNow.tenantId ?? "stdio"

  // Get enabled tools for this session (scoped by tenant to prevent cross-tenant leaks)
  const enabledToolIds = sessionId ? await ToolSearch.getEnabledTools(sessionId, tenantId) : new Set<string>()

  // Debug: Log session info and sources
  mcpDebug(`[Server] ListTools request - sessionId: ${sessionId || "none"}`)
  if (!sessionId) {
    mcpDebug("[Server] ⚠️ No session ID found - all deferred tools will be hidden")
    mcpDebug("[Server]   Checked sources:")
    mcpDebug(`[Server]     - JWT payload: ${ctx.jwtPayload?.sessionId || "none"}`)
    mcpDebug(`[Server]     - x-session-id header: ${(request as any).headers?.["x-session-id"] || "none"}`)
    mcpDebug(`[Server]     - SNOW_SESSION_ID env: ${process.env.SNOW_SESSION_ID || "none"}`)
    mcpDebug(`[Server]     - current-session.json: ${ToolSearch.getCurrentSession() || "none"}`)
  }

  // Domain filtering via SNOW_TOOL_DOMAINS env var
  const toolDomainsEnv = process.env.SNOW_TOOL_DOMAINS

  let allTools: MCPToolDefinition[]
  if (toolDomainsEnv) {
    const requestedDomains = toolDomainsEnv
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean)
    const availableDomains = toolRegistry.getAvailableDomains()

    // Validate requested domains
    const invalidDomains = requestedDomains.filter((d) => !availableDomains.includes(d.toLowerCase()))
    if (invalidDomains.length > 0) {
      mcpDebug(`[Server] ⚠️  Unknown domains in SNOW_TOOL_DOMAINS: ${invalidDomains.join(", ")}`)
      mcpDebug(`[Server]    Available domains: ${availableDomains.join(", ")}`)
    }

    allTools = toolRegistry.getToolDefinitionsByDomains(requestedDomains)
    mcpDebug(`[Server] Domain filtering enabled: ${requestedDomains.join(", ")}`)
    mcpDebug(`[Server]   Tools loaded: ${allTools.length} (from ${requestedDomains.length} domains)`)
  } else {
    allTools = toolRegistry.getToolDefinitions()
  }

  // Transport-level tool filtering — drop anything whose transport allowlist
  // doesn't include the current transport. Tools without an allowlist are
  // kept (considered available everywhere).
  const transportFilteredTools = allTools.filter(
    (tool) => !tool.transports || tool.transports.includes(ctx.origin),
  )

  // Role-based tool filtering
  const userRole = ctx.jwtPayload?.role || "developer"
  const filteredTools = filterToolsByRole(transportFilteredTools, ctx.jwtPayload)

  const totalAvailable = toolRegistry.getToolDefinitions().length

  // Add meta-tools (tool_search, tool_execute) first - these are ALWAYS available
  // Defensive: check if META_TOOLS is defined and has entries
  const metaToolDefs = META_TOOLS && META_TOOLS.length > 0 ? META_TOOLS.map((t) => t.definition) : []

  if (metaToolDefs.length === 0) {
    mcpDebug("[Server] ⚠️  WARNING: META_TOOLS is empty! tool_search/tool_execute not available")
  }

  // Debug: Check tool index status
  const indexStats = ToolSearch.getStats()
  mcpDebug(
    `[Server] Tool index: ${indexStats.total} tools, ${indexStats.deferred} deferred, ${indexStats.immediate} immediate`,
  )

  // Check if lazy tools mode is enabled (DEFAULT: true for token efficiency)
  // Set SNOW_LAZY_TOOLS=false to disable and load all tools at startup
  const lazyToolsEnabled = process.env.SNOW_LAZY_TOOLS !== "false"
  mcpDebug(`[Server] SNOW_LAZY_TOOLS: ${lazyToolsEnabled ? "ENABLED (default)" : "DISABLED"}`)

  // If tool index is empty, warn - tools may not be filtered correctly
  if (indexStats.total === 0) {
    mcpDebug("[Server] ⚠️ Tool index is EMPTY - deferred filtering may not work correctly")
    mcpDebug("[Server]   All tools will be returned (not deferred)")
  }

  // DEFERRED LOADING MODE:
  // Only return meta-tools + enabled tools to reduce token usage (~71k -> ~2k)
  // Deferred tools must be enabled via tool_search before they appear here
  const enabledTools = filteredTools.filter((tool) => {
    // If lazy tools mode is enabled and tool index is populated,
    // only return non-deferred tools and session-enabled tools
    if (lazyToolsEnabled && indexStats.total > 0) {
      const indexEntry = ToolSearch.getToolFromIndex(tool.name)
      // Default to deferred=true when SNOW_LAZY_TOOLS is set
      const isDeferred = indexEntry?.deferred ?? true

      // Include if: not deferred OR enabled for this session
      if (!isDeferred) return true
      if (enabledToolIds.has(tool.name)) return true
      return false
    }

    // Fallback: If lazy tools mode is disabled or index not ready,
    // check the old way (tool index entry or default to allowing)
    const indexEntry = ToolSearch.getToolFromIndex(tool.name)
    if (!indexEntry) {
      // No index entry - if SNOW_LAZY_TOOLS is set, treat as deferred
      if (lazyToolsEnabled) return false
      // Otherwise allow (backwards compatibility)
      return true
    }

    const isDeferred = indexEntry.deferred
    if (!isDeferred) return true
    if (enabledToolIds.has(tool.name)) return true
    return false
  })

  // Debug: If many tools are enabled, log details
  if (enabledToolIds.size > 10) {
    mcpDebug(`[Server] ⚠️  Many tools enabled (${enabledToolIds.size}) - session may have stale data`)
    // Log first 5 enabled tool names
    const first5 = Array.from(enabledToolIds).slice(0, 5)
    mcpDebug(`[Server]    First 5: ${first5.join(", ")}`)
  }

  mcpDebug(`[Server] Listing tools for role: ${userRole}` + (toolDomainsEnv ? ` (domains: ${toolDomainsEnv})` : ""))
  mcpDebug(`[Server]   Meta-tools: ${metaToolDefs.length}`)
  mcpDebug(`[Server]   Enabled this session: ${enabledToolIds.size}`)
  mcpDebug(`[Server]   Filtered to return: ${enabledTools.length}`)
  mcpDebug(`[Server]   Total available: ${totalAvailable} (use tool_search to enable)`)

  // Build final tools list
  const toolsToReturn = [
    // Meta-tools always available
    ...metaToolDefs.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    // Only enabled tools (not all deferred tools)
    ...enabledTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  ]

  mcpDebug(`[Server] Returning ${toolsToReturn.length} tools total`)

  return {
    tools: toolsToReturn,
  }
}
