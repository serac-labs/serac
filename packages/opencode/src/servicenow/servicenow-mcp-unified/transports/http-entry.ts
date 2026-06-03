#!/usr/bin/env bun
/**
 * MCP HTTP Server — Bun entry point
 * ----------------------------------------------------------------------
 * Starts the Hono-based MCP server on a fixed port and wires up an HTTP
 * callback-based `ContextResolver` (see http-resolver.ts) so that tenant
 * credential resolution lives in the deployment that owns the tenant DB
 * (e.g. snow-flow-enterprise's portal backend), not in this image.
 *
 * Env vars (all required at runtime):
 *   MCP_RESOLVER_URL      — full URL of the downstream resolver endpoint
 *   MCP_INTERNAL_TOKEN    — shared secret sent on `X-Internal-Auth`
 *   MCP_HTTP_PORT         — listen port (default 8082)
 *   MCP_HTTP_IDLE_TIMEOUT — Bun.serve idle timeout in seconds (default 240, max 255)
 *
 * Intended runtime: Bun. The image is built from `Dockerfile.mcp-http`
 * and published as `ghcr.io/serac-labs/serac-mcp-http`. Callers that
 * need to self-host can also run it via `bun run http-entry.ts`.
 */

import { toolRegistry } from "../shared/tool-registry.js"
import { ToolSearch } from "../shared/tool-search.js"
import { createHttpApp } from "./http.js"
import { createHttpResolver } from "./http-resolver.js"
import { mcpDebug, mcpWarn } from "../../shared/mcp-debug.js"

/**
 * Derive search keywords from a tool's name + description. Mirrors the
 * stdio transport's helper so both transports produce the same index.
 */
const extractKeywords = (name: string, description: string): string[] => {
  const keywords = new Set<string>()
  const nameParts = name.replace(/^snow_/, "").split("_")
  for (const part of nameParts) {
    if (part.length > 2) keywords.add(part.toLowerCase())
  }
  const descWords = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !["this", "that", "with", "from", "will", "have", "been", "tool"].includes(w))
  for (const w of descWords.slice(0, 10)) keywords.add(w)
  return Array.from(keywords)
}

async function main(): Promise<void> {
  const resolverUrl = process.env.MCP_RESOLVER_URL
  const internalToken = process.env.MCP_INTERNAL_TOKEN
  const port = Number(process.env.MCP_HTTP_PORT ?? 8082)
  // Bun.serve defaults idleTimeout to 10s, which kills any tool call that
  // takes longer than that (cold credential resolution, heavier ServiceNow
  // round-trips, Flow Designer publish) — the client then sees an opaque
  // `fetch failed`. Tool calls are request/response over a single connection,
  // so we raise this to Bun's maximum (255s). Configurable via env.
  const idleTimeout = Math.min(255, Number(process.env.MCP_HTTP_IDLE_TIMEOUT ?? 240))

  if (!resolverUrl || !internalToken) {
    throw new Error(
      "mcp-http entry requires MCP_RESOLVER_URL and MCP_INTERNAL_TOKEN env vars. " +
        "See transports/http-resolver.ts for the contract the endpoint must implement.",
    )
  }

  mcpDebug("[mcp-http] discovering tools…")
  const discovery = await toolRegistry.initialize()
  mcpDebug(
    `[mcp-http] tool discovery done: ${discovery.toolsRegistered} registered, ` +
      `${discovery.toolsFailed} failed across ${discovery.domains.length} domains`,
  )
  if (discovery.toolsFailed > 0) {
    for (const err of discovery.errors) {
      mcpWarn(`[mcp-http] tool load failed: ${err.filePath} — ${err.error}`)
    }
  }

  // Populate the ToolSearch index so `listTools` can surface the full catalog
  // (235+ tools). Without this, the HTTP list-tools handler sees an empty
  // index + SNOW_LAZY_TOOLS defaulting to on, and filters everything except
  // the two meta tools (tool_search / tool_execute) — which makes the LLM
  // think ServiceNow is read-only.
  const allTools = toolRegistry.getToolDefinitions()
  const toolIndexEntries = allTools.map((tool) => {
    const registeredTool = toolRegistry.getTool(tool.name)
    return {
      id: tool.name,
      description: tool.description.substring(0, 200),
      category: registeredTool?.domain || "unknown",
      keywords: extractKeywords(tool.name, tool.description),
      // HTTP callers (portal chat) do their own token budgeting + tool
      // enablement on the client side. Marking everything non-deferred
      // here means `listTools` returns the full catalog so the portal's
      // tool_search overlay can match against write/deploy tools, not
      // just the two meta tools.
      deferred: false,
    }
  })
  ToolSearch.registerTools(toolIndexEntries)
  mcpDebug(`[mcp-http] tool search index populated with ${toolIndexEntries.length} tools`)

  const app = createHttpApp({
    resolveContext: createHttpResolver({ url: resolverUrl, internalToken }),
  })

  // Bun's native server. Runs on Node too via `@hono/node-server`, but the
  // published image is Bun-based so we use the built-in server here.
  // idleTimeout is raised from Bun's 10s default (see above) so long-running
  // tool calls aren't severed mid-flight.
  const server = (globalThis as any).Bun?.serve?.({ fetch: app.fetch, port, idleTimeout })
  if (!server) {
    throw new Error(
      "Bun.serve is not available. This entry point is intended for the Bun runtime " +
        "shipped with Dockerfile.mcp-http.",
    )
  }

  mcpDebug(`[mcp-http] listening on :${port}`)
  mcpDebug(`[mcp-http] resolver endpoint: ${resolverUrl}`)

  const shutdown = async (signal: string) => {
    mcpDebug(`[mcp-http] received ${signal}, stopping…`)
    try {
      await server.stop?.(true)
    } catch {
      // ignore
    }
    process.exit(0)
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch(() => process.exit(1))
  })
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch(() => process.exit(1))
  })
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  // eslint-disable-next-line no-console
  console.error(`[mcp-http] fatal: ${msg}`)
  process.exit(1)
})
