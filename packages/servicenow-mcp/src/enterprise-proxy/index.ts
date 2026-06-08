#!/usr/bin/env node
/**
 * Serac Enterprise MCP Proxy
 * Bridges SnowCode CLI (stdio MCP) with Enterprise License Server (HTTPS REST)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { proxyToolCall, listEnterpriseTools } from "./proxy.js"
import { mcpDebug } from "../shared/mcp-debug.js"
import { fetchAndCacheTools, buildEnterpriseToolIndex, ToolSearch, getCurrentSessionId } from "./tool-cache.js"
import { ENTERPRISE_META_TOOLS, executeToolSearch, executeToolExecute } from "./meta-tools.js"

const VERSION = (process.env.SERAC_VERSION || process.env.SNOW_FLOW_VERSION) || "8.30.31"
const LAZY_TOOLS_ENABLED = process.env.SNOW_ENTERPRISE_LAZY_TOOLS !== "false"

/**
 * Create MCP Server
 */
const server = new Server(
  {
    name: "serac-enterprise-proxy",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
)

/**
 * Handle tools/list request
 * Returns list of available enterprise tools from license server
 * In lazy mode: returns only meta-tools + session-enabled tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  mcpDebug("[Enterprise Proxy] Received tools/list request from MCP client")

  try {
    const tools = await listEnterpriseTools()

    mcpDebug(`[Enterprise Proxy] Fetched ${tools.length} tools from license server`)

    if (LAZY_TOOLS_ENABLED) {
      // Build search index from fetched tools
      buildEnterpriseToolIndex(tools)

      // Collect session-enabled tools to include alongside meta-tools
      const sessionId = getCurrentSessionId()
      const enabledTools: { name: string; description: string; inputSchema: any }[] = []
      if (sessionId) {
        const enabledSet = await ToolSearch.getEnabledTools(sessionId)
        for (const toolId of enabledSet) {
          const found = tools.find((t) => t.name === toolId)
          if (found) {
            enabledTools.push({
              name: found.name,
              description: found.description || `Enterprise tool: ${found.name}`,
              inputSchema: found.inputSchema,
            })
          }
        }
      }

      mcpDebug(
        `[Enterprise Proxy] Lazy mode: returning ${ENTERPRISE_META_TOOLS.length} meta-tools + ${enabledTools.length} enabled tools`,
      )
      return {
        tools: [...ENTERPRISE_META_TOOLS, ...enabledTools],
      }
    }

    mcpDebug(`[Enterprise Proxy] Returning ${tools.length} tools to MCP client`)
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description || `Enterprise tool: ${tool.name}`,
        inputSchema: tool.inputSchema,
      })),
    }
  } catch (error) {
    mcpDebug("[Enterprise Proxy] Failed to list tools", {
      error: error instanceof Error ? error.message : String(error),
    })

    if (LAZY_TOOLS_ENABLED) {
      // In lazy mode, always return meta-tools so search remains available
      mcpDebug("[Enterprise Proxy] Returning meta-tools only due to backend error")
      return { tools: [...ENTERPRISE_META_TOOLS] }
    }

    mcpDebug("[Enterprise Proxy] Returning empty tools list due to backend error")
    return { tools: [] }
  }
})

/**
 * Handle tools/call request
 * Proxies tool call to enterprise license server via HTTPS
 * In lazy mode: routes meta-tool calls and enforces tool enabling
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  mcpDebug(`[Enterprise Proxy] Received tool call: ${name}`, {
    arguments: args,
  })

  // Route meta-tool calls in lazy mode
  if (LAZY_TOOLS_ENABLED) {
    if (name === "enterprise_tool_search") {
      return executeToolSearch((args || {}) as Record<string, unknown>)
    }
    if (name === "enterprise_tool_execute") {
      return executeToolExecute((args || {}) as Record<string, unknown>)
    }

    // For direct tool calls in lazy mode, check if tool is enabled
    const sessionId = getCurrentSessionId()
    if (sessionId) {
      const canExecute = await ToolSearch.canExecuteTool(sessionId, name)
      if (!canExecute) {
        mcpDebug(`[Enterprise Proxy] Tool ${name} not enabled for session ${sessionId}`)
        return {
          content: [
            {
              type: "text",
              text: `Tool "${name}" is not enabled. Use enterprise_tool_search to find and enable it first.`,
            },
          ],
          isError: true,
        }
      }
    }
  }

  try {
    const result = await proxyToolCall(name, args || {})

    mcpDebug(`[Enterprise Proxy] Tool call succeeded: ${name}`)

    // Format result as MCP response
    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
      isError: false,
    }
  } catch (error) {
    // Return error as MCP response
    const errorMessage = error instanceof Error ? error.message : String(error)

    mcpDebug(`[Enterprise Proxy] Tool call failed: ${name}`, {
      error: errorMessage,
    })

    return {
      content: [
        {
          type: "text",
          text: `Enterprise tool error: ${errorMessage}`,
        },
      ],
      isError: true,
    }
  }
})

/**
 * Start MCP Server with stdio transport
 */
async function main() {
  try {
    mcpDebug("[Enterprise Proxy] Starting Enterprise Proxy MCP Server", {
      version: VERSION,
      enterpriseUrl: process.env.SNOW_ENTERPRISE_URL || "https://enterprise.serac.build",
      licenseKeyConfigured: !!process.env.SNOW_LICENSE_KEY,
      cwd: process.cwd(),
    })

    const transport = new StdioServerTransport()
    await server.connect(transport)

    // Log to stderr (stdout is reserved for MCP protocol)
    mcpDebug("[Enterprise Proxy] Serac Enterprise MCP Proxy started")
    mcpDebug(`[Enterprise Proxy] Version: ${VERSION}`)
    mcpDebug(
      `[Enterprise Proxy] Enterprise URL: ${process.env.SNOW_ENTERPRISE_URL || "https://enterprise.serac.build"}`,
    )
    mcpDebug(`[Enterprise Proxy] License Key: ${process.env.SNOW_LICENSE_KEY ? "✓ Configured" : "✗ Not configured"}`)

    mcpDebug("[Enterprise Proxy] Enterprise Proxy successfully started and ready for requests")
  } catch (error) {
    mcpDebug("[Enterprise Proxy] Fatal startup error", {
      error: error instanceof Error ? error.message : String(error),
    })
    mcpDebug("[Enterprise Proxy] Fatal error:", error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

// Handle process signals
process.on("SIGINT", () => {
  mcpDebug("[Enterprise Proxy] Received SIGINT, shutting down...")
  process.exit(0)
})

process.on("SIGTERM", () => {
  mcpDebug("[Enterprise Proxy] Received SIGTERM, shutting down...")
  process.exit(0)
})

// Start server
main().catch((error) => {
  mcpDebug("[Enterprise Proxy] Startup failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
