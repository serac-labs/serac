/**
 * Enterprise Tool Cache + Search Index
 *
 * Builds a search index from remote enterprise tool definitions fetched via HTTPS.
 * Reuses the shared ToolSearch module for search, session management, and tool enabling.
 *
 * Cache is in-memory with a configurable TTL (default 5 minutes) to avoid
 * hitting the license server on every ListTools request.
 */

import { ToolSearch, getCurrentSessionId } from "../servicenow-mcp-unified/shared/tool-search.js"
import type { ToolIndexEntry } from "../servicenow-mcp-unified/shared/tool-search.js"
import { listEnterpriseTools } from "./proxy.js"
import type { EnterpriseTool } from "./types.js"
import { mcpDebug } from "../shared/mcp-debug.js"

export { ToolSearch, getCurrentSessionId }
export type { ToolIndexEntry }

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

let cachedTools: EnterpriseTool[] = []
let cacheTimestamp = 0
let indexBuilt = false

/**
 * Infer domain/category from a tool name prefix
 */
export function inferDomain(toolName: string): string {
  if (toolName.startsWith("jira_")) return "jira"
  if (toolName.startsWith("azure_") || toolName.startsWith("azdo_")) return "azure-devops"
  if (toolName.startsWith("confluence_")) return "confluence"
  if (toolName.startsWith("github_") || toolName.startsWith("gh_")) return "github"
  if (toolName.startsWith("gitlab_") || toolName.startsWith("gl_")) return "gitlab"
  if (toolName.startsWith("process_mining_") || toolName.startsWith("pm_")) return "process-mining"
  return "enterprise"
}

/**
 * Extract search keywords from tool name and description
 */
export function extractKeywords(name: string, description: string): string[] {
  const words = new Set<string>()

  // Split tool name on underscores
  for (const part of name.split("_")) {
    if (part.length > 2) words.add(part.toLowerCase())
  }

  // Extract meaningful words from description
  const descWords = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "can",
    "shall",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "out",
    "off",
    "over",
    "under",
    "again",
    "further",
    "then",
    "once",
    "and",
    "but",
    "or",
    "nor",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
  ])
  for (const w of descWords) {
    if (w.length > 2 && !stopWords.has(w)) words.add(w)
  }

  return Array.from(words)
}

/**
 * Fetch enterprise tools from license server with caching
 * Returns cached tools if still fresh, otherwise fetches new ones
 */
export async function fetchAndCacheTools(): Promise<EnterpriseTool[]> {
  const now = Date.now()
  if (cachedTools.length > 0 && now - cacheTimestamp < CACHE_TTL_MS) {
    mcpDebug(
      `[Enterprise ToolCache] Using cached tools (${cachedTools.length} tools, age: ${Math.round((now - cacheTimestamp) / 1000)}s)`,
    )
    return cachedTools
  }

  mcpDebug("[Enterprise ToolCache] Fetching tools from license server...")
  const tools = await listEnterpriseTools()
  cachedTools = tools
  cacheTimestamp = Date.now()
  mcpDebug(`[Enterprise ToolCache] Cached ${tools.length} tools`)
  return tools
}

/**
 * Build the ToolSearch index from enterprise tools
 * All enterprise tools are registered as deferred (lazy-loaded)
 */
export function buildEnterpriseToolIndex(tools: EnterpriseTool[]): void {
  if (indexBuilt && cachedTools.length === tools.length) return

  const entries: ToolIndexEntry[] = tools.map((tool) => ({
    id: tool.name,
    description: tool.description || `Enterprise tool: ${tool.name}`,
    category: inferDomain(tool.name),
    keywords: extractKeywords(tool.name, tool.description || ""),
    deferred: true,
  }))

  ToolSearch.clearIndex()
  ToolSearch.registerTools(entries)
  indexBuilt = true

  const stats = ToolSearch.getStats()
  mcpDebug(
    `[Enterprise ToolCache] Index built: ${stats.total} tools across ${Object.keys(stats.categories).length} categories`,
  )
}

/**
 * Get a single cached tool definition by name
 */
export function getCachedTool(name: string): EnterpriseTool | undefined {
  return cachedTools.find((t) => t.name === name)
}

/**
 * Get all cached tool definitions
 */
export function getCachedTools(): EnterpriseTool[] {
  return cachedTools
}

/**
 * Force refetch on next request
 */
export function invalidateCache(): void {
  cachedTools = []
  cacheTimestamp = 0
  indexBuilt = false
  ToolSearch.clearIndex()
  mcpDebug("[Enterprise ToolCache] Cache invalidated")
}
