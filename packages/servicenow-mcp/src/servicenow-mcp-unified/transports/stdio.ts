/**
 * Stdio transport bootstrap for the ServiceNow unified MCP server.
 *
 * Wires together:
 *   - Credential loading (env vars → auth.json → enterprise portal fetch)
 *   - Tool discovery + search index population
 *   - Authentication validation
 *   - StdioServerTransport connection
 *
 * The HTTP transport (see transports/http.ts) resolves credentials per-request
 * from the portal DB and does not share this bootstrap code.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { MCPPromptManager } from "../../shared/mcp-prompt-manager.js"
import { toolRegistry } from "../shared/tool-registry.js"
import { authManager } from "../shared/auth.js"
import { ToolSearch } from "../shared/tool-search.js"
import { mcpDebug, mcpWarn } from "../../shared/mcp-debug.js"
import { extractJWTPayload } from "../shared/permission-validator.js"
import { createServer } from "../shared/server-factory.js"
import { ServiceNowContext, RequestContext } from "../shared/types.js"
import {
  loadContext,
  loadEnterpriseAuth,
  loadFromEnterprisePortal,
  hasValidCredentials,
} from "../shared/context-loader.js"

export interface StdioHandle {
  server: Server
  stop: () => Promise<void>
}

/**
 * Build, bootstrap, and connect the stdio-transport MCP server.
 * Returns a handle with the Server instance and a `stop()` for graceful shutdown.
 */
export const startStdio = async (): Promise<StdioHandle> => {
  const promptManager = new MCPPromptManager("servicenow-unified")
  // Lock the prompt registry — nobody should be mutating it past bootstrap.
  promptManager.freeze()

  // Mutable context holder — the resolver closure always reads the latest
  // value so that bootstrap() can swap in enterprise-portal credentials
  // after the server is already created.
  let context: ServiceNowContext = loadContext()

  const resolveContext = async (request: any, _extra?: any): Promise<RequestContext> => {
    // stdio has no HTTP headers; `request.headers` is undefined here. We keep
    // the lookup for symmetry with the HTTP resolver and because some test
    // harnesses pass a hand-crafted request with inline headers.
    const headers = (request as any)?.headers
    const jwtPayload = extractJWTPayload(headers)
    const sessionId =
      jwtPayload?.sessionId ||
      headers?.["x-session-id"] ||
      process.env.SNOW_SESSION_ID ||
      ToolSearch.getCurrentSession()

    // Stamp the stdio tenant sentinel onto the credentials every request.
    // Every cache lookup in auth.ts and every ToolSessionStore op in
    // tool-search derives its scope from this field, so forgetting to set
    // it would silently share state across future stdio users.
    return {
      sessionId,
      jwtPayload,
      serviceNow: { ...context, tenantId: "stdio" },
      origin: "stdio",
    }
  }

  const server = createServer({ resolveContext, promptManager })

  await bootstrap(
    () => context,
    (c) => {
      context = c
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  mcpDebug("[Server] Connected via stdio transport")

  return {
    server,
    stop: async () => {
      mcpDebug("[Server] Stopping server...")
      await server.close()
      authManager.clearCache()
      mcpDebug("[Server] Server stopped")
    },
  }
}

/**
 * Run the stdio-specific startup sequence:
 *   1. Fetch enterprise credentials if no local creds available
 *   2. Discover tools via the auto-registry
 *   3. Populate the session-aware ToolSearch index
 *   4. Validate authentication (non-fatal)
 *   5. Log active tool-loading mode (lazy / domain-filter / full)
 */
const bootstrap = async (
  getContext: () => ServiceNowContext,
  setContext: (c: ServiceNowContext) => void,
): Promise<void> => {
  mcpDebug("[Server] ServiceNow Unified MCP Server starting...")
  mcpDebug("[Server] ========== ENVIRONMENT CHECK ==========")
  mcpDebug(`[Server] SNOW_LAZY_TOOLS = "${process.env.SNOW_LAZY_TOOLS || "NOT SET"}"`)
  mcpDebug(`[Server] SNOW_SESSION_ID = "${process.env.SNOW_SESSION_ID || "NOT SET"}"`)
  mcpDebug("[Server] ========================================")

  try {
    // STEP 0: Try enterprise portal fetch if no valid credentials from env vars.
    // When env vars are explicitly set (e.g. /auth instance switch), they take
    // priority; enterprise portal fetch is only used when no local credentials
    // are available.
    if (!hasValidCredentials(getContext())) {
      if (loadEnterpriseAuth()) {
        mcpDebug("[Server] Checking enterprise portal for credentials...")
        const enterpriseContext = await loadFromEnterprisePortal()
        if (enterpriseContext) {
          setContext(enterpriseContext)
          mcpDebug("[Server] ✅ Using SECURE enterprise credentials (fetched at runtime)")
          mcpDebug("[Server]    No ServiceNow secrets stored locally!")
        } else {
          mcpDebug("[Server] No credentials available from enterprise portal")
          mcpDebug("[Server] Falling back to local credentials (if any)...")
        }
      }
    } else {
      mcpDebug("[Server] Using credentials from environment/config (instance switch or explicit config)")
    }

    const current = getContext()
    mcpDebug("[Server] Instance:", current.instanceUrl || "NOT CONFIGURED")
    mcpDebug("[Server] Auth Mode:", current.enterprise ? "ENTERPRISE (secure)" : "LOCAL")

    // Initialize tool registry with auto-discovery
    mcpDebug("[Server] Discovering tools...")
    const discoveryResult = await toolRegistry.initialize()

    mcpDebug("[Server] Tool discovery complete:")
    mcpDebug(`  - Domains: ${discoveryResult.domains.length}`)
    mcpDebug(`  - Tools found: ${discoveryResult.toolsFound}`)
    mcpDebug(`  - Tools registered: ${discoveryResult.toolsRegistered}`)
    mcpDebug(`  - Tools failed: ${discoveryResult.toolsFailed}`)
    mcpDebug(`  - Duration: ${discoveryResult.duration}ms`)

    if (discoveryResult.toolsFailed > 0) {
      mcpDebug("[Server] Some tools failed to load:")
      discoveryResult.errors.forEach((err) => {
        mcpWarn(`  - ${err.filePath}: ${err.error}`)
      })
    }

    // Populate ToolSearch index for session-based tool enabling
    mcpDebug("[Server] Building tool search index...")
    const allTools = toolRegistry.getToolDefinitions()
    const toolIndexEntries = allTools.map((tool) => {
      const registeredTool = toolRegistry.getTool(tool.name)
      return {
        id: tool.name,
        description: tool.description.substring(0, 200),
        category: registeredTool?.domain || "unknown",
        keywords: extractKeywords(tool.name, tool.description),
        deferred: true, // All tools are deferred in lazy mode
      }
    })
    ToolSearch.registerTools(toolIndexEntries)
    mcpDebug(`[Server] Tool search index populated with ${toolIndexEntries.length} tools`)

    // Test authentication (only if we have credentials)
    if (hasValidCredentials(getContext())) {
      mcpDebug("[Server] Testing authentication...")
      try {
        await authManager.getAuthenticatedClient(getContext())
        mcpDebug("[Server] Authentication successful")
      } catch (error: any) {
        mcpDebug("[Server] Authentication test failed:", error.message)
        mcpDebug("[Server] Server will start, but tool calls may fail until credentials are valid")
      }
    } else {
      mcpDebug("[Server] ⚠️  No ServiceNow credentials configured!")
      mcpDebug("[Server] Tools will return authentication errors.")
      mcpDebug("[Server] To configure:")
      mcpDebug("[Server]   Enterprise users: snow-code auth login")
      mcpDebug("[Server]   Free users: Configure environment variables or auth.json")
    }

    // Get server statistics
    const stats = toolRegistry.getStatistics()
    mcpDebug("[Server] Server statistics:")
    mcpDebug(`  - Total tools: ${stats.totalTools}`)
    mcpDebug(`  - Total domains: ${stats.totalDomains}`)
    mcpDebug("  - Tools by domain:")
    Object.entries(stats.toolsByDomain).forEach(([domain, count]) => {
      mcpDebug(`    - ${domain}: ${count} tools`)
    })

    // Show lazy tools mode status (DEFAULT: enabled for token efficiency)
    const lazyToolsEnabled = process.env.SNOW_LAZY_TOOLS !== "false"
    const domainFilterEnabled = !!process.env.SNOW_TOOL_DOMAINS

    if (lazyToolsEnabled) {
      mcpDebug("[Server] 🚀 LAZY TOOLS MODE ACTIVE (default)")
      mcpDebug("[Server]    Token usage: ~2k (down from ~71k)")
      mcpDebug("[Server]    AI uses tool_search + tool_execute to access all tools")
      mcpDebug("[Server]    Set SNOW_LAZY_TOOLS=false to disable")
    } else if (domainFilterEnabled) {
      mcpDebug("[Server] 🔧 Domain filtering ACTIVE via SNOW_TOOL_DOMAINS")
    } else {
      mcpDebug("[Server] ⚠️  LAZY TOOLS DISABLED - all tools loaded (~71k tokens)")
      mcpDebug("[Server]    Remove SNOW_LAZY_TOOLS=false to enable lazy loading")
    }

    mcpDebug("[Server] Initialization complete ✅")
  } catch (error: any) {
    mcpDebug("[Server] Initialization failed:", error.message)
    throw error
  }
}

/**
 * Extract keywords from tool name and description for search indexing.
 */
const extractKeywords = (name: string, description: string): string[] => {
  const keywords = new Set<string>()

  // Extract from tool name (e.g., snow_query_incidents -> query, incidents)
  const nameParts = name.replace(/^snow_/, "").split("_")
  nameParts.forEach((part) => {
    if (part.length > 2) {
      keywords.add(part.toLowerCase())
    }
  })

  // Extract significant words from description
  const descWords = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !["this", "that", "with", "from", "will", "have", "been", "tool"].includes(w))

  // Take top 10 most relevant words from description
  descWords.slice(0, 10).forEach((w) => keywords.add(w))

  return Array.from(keywords)
}
