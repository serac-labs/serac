/**
 * Tool Search - Session-based tool enabling for lazy loading mode
 *
 * Ported from the original JavaScript implementation to TypeScript.
 *
 * This module provides:
 *   - Tool index for lightweight search (name + description only)
 *   - Per-(tenant, session) enabled-tools tracking via an injectable store
 *   - File-based default store for stdio, memory-backed for HTTP
 *
 * Multi-tenant safety (PR-6a): all state operations take a `tenantId` so
 * two tenants with the same session ID cannot see each other's enabled
 * tools. The default tenantId `"stdio"` is safe only in the single-user
 * stdio context; HTTP callers must always pass the resolved tenant ID
 * (`ctx.serviceNow.tenantId`). See also `ToolSessionStore`.
 *
 * Callers should derive that ID with `resolveTenantScope()` from
 * `shared/tenant-scope.ts` (re-exported below) rather than writing
 * `context.tenantId ?? "stdio"` inline: the helper fails closed on a
 * multi-tenant transport instead of quietly parking an unidentified caller in
 * the shared stdio bucket. The default parameter is kept only for the
 * single-tenant stdio embedders (`src/enterprise-proxy/*`) that call these
 * functions with no tenant at all.
 *
 * The store keys on (tenant, session) with nested maps, never with a composed
 * string, so the scope goes in verbatim. Caches that DO flatten a tenant into
 * one string key must compose it with `tenantScopedKey()`.
 *
 * @see https://www.anthropic.com/engineering/advanced-tool-use
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { mcpDebug } from "../../shared/mcp-debug.js"
import { FileToolSessionStore, type ToolSessionStore } from "./tool-session-store.js"
import { STDIO_TENANT } from "./tenant-scope.js"

// Re-exported so callers that already reach for the tenancy rule through this
// module keep working. `shared/tenant-scope.ts` is the definition; it is
// import-free so that low-level modules (auth.ts, scripted-exec.ts) can key on
// a tenant without depending on the tool index.
export { STDIO_TENANT, resolveTenantScope, tenantScopedKey } from "./tenant-scope.js"

/**
 * Tool index entry - lightweight representation for search
 */
export interface ToolIndexEntry {
  id: string
  description: string
  category: string
  keywords: string[]
  deferred: boolean
}

/**
 * Build the index the transports register at bootstrap.
 *
 * `stdio.ts` and `http-entry.ts` each carried their own copy of this mapping,
 * and the retrieval eval needs the same one. Either copy drifting — a
 * different truncation length, a field the ranker reads that only one of them
 * fills — silently changes what a session can find, and nothing fails.
 *
 * `deferred` is the one thing the callers genuinely disagree on: stdio defers
 * the whole catalog so `tool_search` is the only way in, HTTP marks it
 * available because the portal budgets tools itself. It does not affect
 * ranking. Note that keywords come from the untruncated description even
 * though the indexed description is cut at 200 chars.
 */
export function buildToolIndex(
  tools: { name: string; description: string }[],
  categoryOf: (name: string) => string,
  deferred: boolean,
): ToolIndexEntry[] {
  return tools.map((tool) => ({
    id: tool.name,
    description: tool.description.substring(0, 200),
    category: categoryOf(tool.name),
    keywords: extractKeywords(tool.name, tool.description),
    deferred,
  }))
}

/**
 * Derive the search keywords for a tool from its name and description.
 *
 * Lived as a private copy in both transports — the http-entry copy carried a
 * comment saying it mirrored the stdio one, which is the sort of pairing that
 * drifts. `src/enterprise-proxy/tool-cache.ts` has a genuinely different one
 * for non-`snow_` tools; that is not this.
 */
function extractKeywords(name: string, description: string): string[] {
  const keywords = new Set<string>()

  // snow_query_incidents -> query, incidents
  for (const part of name.replace(/^snow_/, "").split("_")) {
    if (part.length > 2) keywords.add(part.toLowerCase())
  }

  // Only the first 10 significant description words are indexed, so a tool
  // whose distinguishing noun appears late in a long description is not
  // reachable by keyword — see the eval's reported misses.
  const descWords = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !["this", "that", "with", "from", "will", "have", "been", "tool"].includes(w))
  for (const word of descWords.slice(0, 10)) keywords.add(word)

  return Array.from(keywords)
}

/**
 * Active session store. Defaults to file-backed for stdio; the HTTP
 * transport should call `setSessionStore(new MemoryToolSessionStore())`
 * at startup to opt into in-memory, per-tenant isolation.
 */
let sessionStore: ToolSessionStore = new FileToolSessionStore()

/**
 * Replace the session store at runtime. Called by transports during bootstrap.
 */
export function setSessionStore(store: ToolSessionStore): void {
  sessionStore = store
}

/**
 * Get the storage directory for the current-session pointer file.
 * (Stdio-only — used by `setCurrentSessionId` / `getCurrentSessionId`.)
 */
function getCurrentSessionDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "snow-code")
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "snow-code")
  }
  return path.join(os.homedir(), ".local", "share", "snow-code")
}

/**
 * Get the current session ID file path (stdio only).
 * This file is written by snow-code and read by MCP server.
 */
function getCurrentSessionFilePath(): string {
  const dataDir = getCurrentSessionDir()
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
  return path.join(dataDir, "current-session.json")
}

/**
 * STDIO-ONLY: Get the current session ID from env var or session file.
 * HTTP callers must extract sessionId from the JWT payload — the machine-local
 * session file has no meaning in a multi-tenant server.
 */
export function getCurrentSessionId(): string | undefined {
  // First check environment variable
  if (process.env.SNOW_SESSION_ID) {
    return process.env.SNOW_SESSION_ID
  }

  // Then check session file
  try {
    const filePath = getCurrentSessionFilePath()
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"))
      if (data.sessionId) {
        return data.sessionId
      }
    }
  } catch (e: any) {
    mcpDebug(`[ToolSearch] Failed to read current session: ${e.message}`)
  }

  return undefined
}

/**
 * STDIO-ONLY: Set the current session ID (called by snow-code when session starts).
 */
export function setCurrentSessionId(sessionId: string): void {
  try {
    const filePath = getCurrentSessionFilePath()
    const data = JSON.stringify(
      {
        sessionId,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )
    fs.writeFileSync(filePath, data, "utf-8")
    mcpDebug(`[ToolSearch] Set current session: ${sessionId}`)
  } catch (e: any) {
    mcpDebug(`[ToolSearch] Failed to set current session: ${e.message}`)
  }
}

// Tool index (lightweight search index) — purely static data, shared across tenants.
let toolIndex: ToolIndexEntry[] = []

/**
 * ToolSearch namespace - session-based tool enabling
 */
export namespace ToolSearch {
  /**
   * Register a tool in the search index
   */
  export function registerTool(entry: ToolIndexEntry): void {
    const existing = toolIndex.findIndex((t) => t.id === entry.id)
    if (existing >= 0) {
      toolIndex[existing] = entry
    } else {
      toolIndex.push(entry)
    }
  }

  /**
   * Register multiple tools at once
   */
  export function registerTools(entries: ToolIndexEntry[]): void {
    for (const entry of entries) {
      registerTool(entry)
    }
  }

  /**
   * Get the tool index
   */
  export function getIndex(): ToolIndexEntry[] {
    return toolIndex
  }

  /**
   * Clear the tool index
   */
  export function clearIndex(): void {
    toolIndex = []
  }

  /**
   * Search tools by query using multiple strategies
   */
  export function search(query: string, limit: number = 20): ToolIndexEntry[] {
    const queryLower = query.toLowerCase()
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2)

    // Score each tool
    const scored = toolIndex.map((tool) => {
      let score = 0
      const idLower = tool.id.toLowerCase()
      const descLower = tool.description.toLowerCase()
      const keywordsLower = tool.keywords.map((k) => k.toLowerCase())

      // Exact ID match (highest priority)
      if (idLower === queryLower) score += 100

      // ID contains query
      if (idLower.includes(queryLower)) score += 50

      // ID starts with query
      if (idLower.startsWith(queryLower)) score += 30

      // Description contains query
      if (descLower.includes(queryLower)) score += 20

      // Keyword matches
      for (const kw of keywordsLower) {
        if (kw === queryLower) score += 40
        if (kw.includes(queryLower)) score += 15
      }

      // Word-level matching
      for (const word of queryWords) {
        if (idLower.includes(word)) score += 10
        if (descLower.includes(word)) score += 5
        for (const kw of keywordsLower) {
          if (kw.includes(word)) score += 8
        }
      }

      // Category match
      if (tool.category.toLowerCase().includes(queryLower)) score += 25

      return { tool, score }
    })

    // Filter and sort by score
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.tool)
  }

  /**
   * Enable a deferred tool for a (tenant, session).
   * `tenantId` defaults to the stdio sentinel for backwards-compat; HTTP
   * callers must always pass the tenant's actual ID.
   */
  export async function enableTool(sessionID: string, toolID: string, tenantId: string = STDIO_TENANT): Promise<void> {
    const current = await sessionStore.getEnabled(tenantId, sessionID)
    current.add(toolID)
    await sessionStore.setEnabled(tenantId, sessionID, current)
    mcpDebug(`[ToolSearch] Enabled tool '${toolID}' for ${tenantId}/${sessionID}`)
  }

  /**
   * Enable multiple deferred tools for a (tenant, session).
   */
  export async function enableTools(
    sessionID: string,
    toolIDs: string[],
    tenantId: string = STDIO_TENANT,
  ): Promise<void> {
    const current = await sessionStore.getEnabled(tenantId, sessionID)
    for (const toolID of toolIDs) {
      current.add(toolID)
    }
    await sessionStore.setEnabled(tenantId, sessionID, current)
    mcpDebug(`[ToolSearch] Enabled ${toolIDs.length} tools for ${tenantId}/${sessionID}`)
  }

  /**
   * Check if a deferred tool is enabled for a (tenant, session).
   */
  export async function isToolEnabled(
    sessionID: string,
    toolID: string,
    tenantId: string = STDIO_TENANT,
  ): Promise<boolean> {
    const current = await sessionStore.getEnabled(tenantId, sessionID)
    return current.has(toolID)
  }

  /**
   * Get all enabled tools for a (tenant, session).
   */
  export async function getEnabledTools(
    sessionID: string,
    tenantId: string = STDIO_TENANT,
  ): Promise<Set<string>> {
    return sessionStore.getEnabled(tenantId, sessionID)
  }

  /**
   * Clear enabled tools for a (tenant, session).
   */
  export async function clearSession(sessionID: string, tenantId: string = STDIO_TENANT): Promise<void> {
    await sessionStore.clear(tenantId, sessionID)
    mcpDebug(`[ToolSearch] Cleared ${tenantId}/${sessionID}`)
  }

  /**
   * Get statistics about the tool index
   */
  export function getStats(): {
    total: number
    deferred: number
    immediate: number
    categories: Record<string, number>
  } {
    const categories: Record<string, number> = {}
    let deferred = 0
    let immediate = 0

    for (const tool of toolIndex) {
      if (tool.deferred) {
        deferred++
      } else {
        immediate++
      }
      categories[tool.category] = (categories[tool.category] || 0) + 1
    }

    return {
      total: toolIndex.length,
      deferred,
      immediate,
      categories,
    }
  }

  /**
   * Get a tool from the index by ID
   */
  export function getToolFromIndex(toolId: string): ToolIndexEntry | undefined {
    return toolIndex.find((t) => t.id === toolId)
  }

  /**
   * Get tool status for display
   * Returns [AVAILABLE], [ENABLED], or [DEFERRED]
   */
  export async function getToolStatus(
    sessionID: string | undefined,
    toolID: string,
    tenantId: string = STDIO_TENANT,
  ): Promise<"[AVAILABLE]" | "[ENABLED]" | "[DEFERRED]"> {
    const tool = getToolFromIndex(toolID)
    if (!tool) {
      // Unknown tool - treat as deferred (must be enabled via tool_search first)
      if (sessionID) {
        const enabled = await isToolEnabled(sessionID, toolID, tenantId)
        if (enabled) {
          return "[ENABLED]"
        }
      }
      return "[DEFERRED]"
    }

    if (!tool.deferred) {
      return "[AVAILABLE]" // Not deferred, always available
    }

    // Tool is deferred - check if enabled for this session
    if (sessionID) {
      const enabled = await isToolEnabled(sessionID, toolID, tenantId)
      if (enabled) {
        return "[ENABLED]"
      }
    }

    return "[DEFERRED]"
  }

  /**
   * Check if a tool can be executed (not deferred OR enabled)
   */
  export async function canExecuteTool(
    sessionID: string | undefined,
    toolID: string,
    tenantId: string = STDIO_TENANT,
  ): Promise<boolean> {
    const tool = getToolFromIndex(toolID)
    if (!tool) {
      // Unknown tool - treat as deferred (must be enabled via tool_search first)
      if (sessionID) {
        return await isToolEnabled(sessionID, toolID, tenantId)
      }
      return false
    }

    if (!tool.deferred) {
      return true // Not deferred, always available
    }

    // Tool is deferred - check if enabled for this session
    if (sessionID) {
      return await isToolEnabled(sessionID, toolID, tenantId)
    }

    return false // Deferred and no session = cannot execute
  }

  /**
   * Get the current session ID (re-exported from module level)
   * Used by MCP server to get sessionId when not passed in request
   */
  export const getCurrentSession = getCurrentSessionId

  /**
   * Set the current session ID (re-exported from module level)
   * Called by snow-code when a session starts/changes
   */
  export const setCurrentSession = setCurrentSessionId
}
