/**
 * Enterprise-proxy `CallTool` request handler.
 *
 * Routes meta-tool invocations (`enterprise_tool_search`,
 * `enterprise_tool_execute`) to the local tool-cache helpers, and forwards
 * every other tool call to the enterprise license server via `proxyToolCall`.
 */

import { ToolSearch, getCurrentSessionId } from "../tool-cache.js"
import { executeToolSearch, executeToolExecute } from "../meta-tools.js"
import { proxyToolCall } from "../proxy.js"
import { mcpDebug } from "../../shared/mcp-debug.js"
import type { ProxyHandlerDeps } from "./types.js"

export const callTool = (deps: ProxyHandlerDeps) => async (request: any) => {
  const toolName = request.params.name
  const toolArgs = request.params.arguments || {}

  // Route meta-tool calls in lazy mode
  if (deps.lazyEnabled) {
    if (toolName === "enterprise_tool_search") {
      return executeToolSearch(toolArgs as Record<string, unknown>)
    }
    if (toolName === "enterprise_tool_execute") {
      return executeToolExecute(toolArgs as Record<string, unknown>)
    }

    // For direct tool calls in lazy mode, check if tool is enabled
    const sessionId = getCurrentSessionId()
    if (sessionId) {
      const canExecute = await ToolSearch.canExecuteTool(sessionId, toolName)
      if (!canExecute) {
        mcpDebug(`[Proxy] Tool ${toolName} not enabled for session ${sessionId}`)
        return {
          content: [
            {
              type: "text",
              text: `Tool "${toolName}" is not enabled. Use enterprise_tool_search to find and enable it first.`,
            },
          ],
          isError: true,
        }
      }
    }
  }

  try {
    mcpDebug(`[Proxy] Executing tool: ${toolName}`)

    const startTime = Date.now()
    const result = await proxyToolCall(toolName, toolArgs)
    const duration = Date.now() - startTime

    mcpDebug(`[Proxy] ✓ Tool executed successfully (${duration}ms)`)

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    }
  } catch (error: any) {
    mcpDebug(`[Proxy] ✗ Tool execution failed: ${error.message}`)

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: error.message,
              tool: toolName,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    }
  }
}
