/**
 * HTTP transport for the ServiceNow unified MCP server.
 *
 * Serves the MCP protocol over streamable HTTP via Hono, using the web-standard
 * variant of the MCP SDK's streamable HTTP transport (Request/Response based,
 * works on Bun / Node 18+ / Workers / Deno).
 *
 * Architecture (stateless):
 *   - Each incoming POST /mcp request gets a fresh Server + Transport
 *   - The caller-supplied `resolveContext` is invoked per request to produce
 *     tenant-scoped ServiceNow credentials (HTTP transport is multi-tenant by
 *     design; stdio is single-tenant)
 *   - No session state is retained between requests (sessionIdGenerator: undefined)
 *
 * The caller is responsible for:
 *   1. Running `await toolRegistry.initialize()` once at process startup
 *      so the tool registry has discovered all tools before requests arrive.
 *   2. Populating the ToolSearch index if lazy loading is expected.
 *   3. Serving the returned Hono app (e.g. via `Bun.serve({ fetch: app.fetch })`
 *      or `@hono/node-server`). This module does not start a listener itself.
 */

import { Hono } from "hono"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"

import { MCPPromptManager } from "../../shared/mcp-prompt-manager.js"
import { mcpDebug } from "../../shared/mcp-debug.js"
import { createServer } from "../shared/server-factory.js"
import { ContextResolver } from "../handlers/types.js"
import { setSessionStore } from "../shared/tool-search.js"
import { MemoryToolSessionStore, type ToolSessionStore } from "../shared/tool-session-store.js"

export interface HttpAppDeps {
  /**
   * Per-request context resolver. Called inside every `POST /mcp` invocation
   * to produce a `RequestContext` with tenant-scoped credentials.
   *
   * The resolver is expected to:
   *   - Validate the `Authorization: Bearer <jwt>` header
   *   - Map the JWT claim to a tenant in the portal DB
   *   - Decrypt ServiceNow credentials via KMS
   *   - Populate `serviceNow.tenantId` with the tenant identifier so that
   *     every cache and session-store lookup is tenant-scoped
   *   - Return a `RequestContext` with `origin: "http"`
   *
   * The concrete implementation lives outside this module — PR-6b will add
   * a `shared/context-resolver.ts` that wraps portal-DB + KMS access.
   */
  resolveContext: ContextResolver

  /**
   * Optional shared prompt manager. Defaulted per call if omitted, which is
   * fine for stateless prompts; pass one in to share state across requests.
   */
  promptManager?: MCPPromptManager

  /**
   * Optional session store for lazy-loading `tool_search` state.
   * Defaults to `MemoryToolSessionStore` (tenant-scoped, non-persistent) —
   * the correct choice for a stateless HTTP server. Callers can inject a
   * DB-backed store if they want session state to survive restarts.
   */
  sessionStore?: ToolSessionStore

  /**
   * Server name reported in MCP handshake. Defaults to "servicenow-unified".
   */
  serverName?: string

  /**
   * Server version reported in MCP handshake. Defaults to "1.0.0".
   */
  serverVersion?: string
}

/**
 * Build a Hono app that serves the ServiceNow unified MCP server over HTTP.
 */
export const createHttpApp = (deps: HttpAppDeps): Hono => {
  const app = new Hono()
  const promptManager = deps.promptManager ?? new MCPPromptManager("servicenow-unified")
  // In HTTP multi-tenant context, prompt registry mutations would leak across
  // requests. Freeze before the first request lands.
  if (!promptManager.isFrozen()) {
    promptManager.freeze()
  }

  // Install a tenant-scoped session store for lazy tool-enablement. The
  // default (`MemoryToolSessionStore`) uses `TenantScopedCache` under the
  // hood so two tenants with the same session ID cannot see each other's
  // enabled tools. This MUST run before the first request is handled.
  setSessionStore(deps.sessionStore ?? new MemoryToolSessionStore())

  // Health endpoint for load balancers and readiness probes
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "servicenow-mcp-unified",
      transport: "http",
    }),
  )

  // MCP streamable HTTP endpoint
  // Supports POST (JSON-RPC messages), GET (SSE stream), DELETE (session end)
  app.all("/mcp", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — fresh server per request
    })

    const server = createServer({
      resolveContext: deps.resolveContext,
      promptManager,
      name: deps.serverName,
      version: deps.serverVersion,
    })

    try {
      await server.connect(transport)
      return await transport.handleRequest(c.req.raw)
    } catch (error: any) {
      mcpDebug("[HTTP] MCP request failed:", error.message)
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error.message ?? "Internal error",
          },
          id: null,
        },
        500,
      )
    }
  })

  return app
}
