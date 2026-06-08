/**
 * Enterprise-proxy `ListTools` request handler.
 *
 * Fetches the current tool catalog from the enterprise license server,
 * optionally filtering down to meta-tools + session-enabled tools in
 * lazy mode. Degrades gracefully if the backend is unreachable.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { listEnterpriseTools } from "../proxy.js"
import { buildEnterpriseToolIndex, ToolSearch, getCurrentSessionId } from "../tool-cache.js"
import { mcpDebug } from "../../shared/mcp-debug.js"
import type { ProxyHandlerDeps } from "./types.js"

export const listTools = (deps: ProxyHandlerDeps) => async () => {
  try {
    mcpDebug("[Proxy] Fetching available tools from license server...")

    const tools = await listEnterpriseTools()
    const availableTools = tools as Tool[]

    mcpDebug(`[Proxy] ✓ ${availableTools.length} tools available`)

    if (!deps.lazyEnabled) {
      return { tools: availableTools }
    }

    // Lazy mode: return meta-tools + enabled tools for this session.
    buildEnterpriseToolIndex(tools)

    const sessionId = getCurrentSessionId()
    const enabledTools: Tool[] = []
    if (sessionId) {
      const enabledSet = await ToolSearch.getEnabledTools(sessionId)
      for (const toolId of enabledSet) {
        const found = availableTools.find((t) => t.name === toolId)
        if (found) enabledTools.push(found)
      }
    }

    mcpDebug(
      `[Proxy] Lazy mode: returning ${deps.metaTools.length} meta-tools + ${enabledTools.length} enabled tools`,
    )
    return {
      tools: [...deps.metaTools, ...enabledTools],
    }
  } catch (error: any) {
    mcpDebug("[Proxy] ✗ Failed to fetch tools:", error.message)

    if (deps.lazyEnabled) {
      // In lazy mode, always return meta-tools so search remains available
      mcpDebug("[Proxy] Returning meta-tools only due to backend error")
      return {
        tools: [...deps.metaTools],
      }
    }

    // Return empty tools list instead of crashing - allows graceful degradation
    mcpDebug("[Proxy] Returning empty tools list due to backend error")
    return {
      tools: [],
    }
  }
}
