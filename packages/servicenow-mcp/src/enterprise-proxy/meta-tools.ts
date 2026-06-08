/**
 * Enterprise Meta-Tools for Lazy Loading
 *
 * Two meta-tools that replace the full 76+ enterprise tool list:
 * - enterprise_tool_search: Search and enable enterprise tools
 * - enterprise_tool_execute: Execute an enabled enterprise tool
 *
 * Prefix `enterprise_` prevents collision with the unified server's
 * `tool_search` / `tool_execute` (both MCP servers run simultaneously).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import {
  ToolSearch,
  getCurrentSessionId,
  fetchAndCacheTools,
  buildEnterpriseToolIndex,
  getCachedTool,
} from "./tool-cache.js"
import { proxyToolCall } from "./proxy.js"
import { mcpDebug } from "../shared/mcp-debug.js"

/**
 * The two meta-tools exposed in ListTools when lazy loading is active
 */
export const ENTERPRISE_META_TOOLS: Tool[] = [
  {
    name: "enterprise_tool_search",
    description:
      "Search through 76+ enterprise integration tools (Jira, Azure DevOps, Confluence, GitHub, GitLab, Process Mining). " +
      "Returns matching tools with their full schemas. Found tools are automatically enabled for the session so you can call them directly. " +
      "Always search before using an enterprise tool for the first time.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Search query — use tool names (e.g. "jira_create_issue"), domains (e.g. "confluence"), ' +
            'or actions (e.g. "create sprint", "search issues", "get page").',
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 10, max: 30).",
        },
        enable: {
          type: "boolean",
          description: "Whether to automatically enable found tools for direct calling (default: true).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "enterprise_tool_execute",
    description:
      "Execute an enterprise tool by name. Use enterprise_tool_search first to discover available tools. " +
      "After searching, tools are enabled and can also be called directly by name without this wrapper.",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: 'The exact tool name to execute (e.g. "jira_get_issue", "confluence_search_pages").',
        },
        args: {
          type: "object",
          description: "Arguments to pass to the tool. See the tool schema from enterprise_tool_search results.",
          additionalProperties: true,
        },
      },
      required: ["tool"],
    },
  },
]

/**
 * Handle enterprise_tool_search calls
 */
export async function executeToolSearch(args: Record<string, unknown>): Promise<{
  content: { type: string; text: string }[]
  isError?: boolean
}> {
  const query = args.query as string
  const limit = Math.min((args.limit as number) || 10, 30)
  const enable = args.enable !== false // default true

  if (!query) {
    return {
      content: [{ type: "text", text: 'Error: "query" parameter is required.' }],
      isError: true,
    }
  }

  try {
    // Ensure tools are cached and indexed
    const tools = await fetchAndCacheTools()
    buildEnterpriseToolIndex(tools)

    // Search the index
    const results = ToolSearch.search(query, limit)
    mcpDebug(`[Enterprise MetaTools] Search "${query}" returned ${results.length} results`)

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No enterprise tools found for "${query}". Try broader terms like "jira", "confluence", "azure", "sprint", "issue", "page".`,
          },
        ],
      }
    }

    // Enable found tools for the session
    const sessionId = getCurrentSessionId()
    if (enable && sessionId) {
      const toolIds = results.map((r) => r.id)
      await ToolSearch.enableTools(sessionId, toolIds)
      mcpDebug(`[Enterprise MetaTools] Enabled ${toolIds.length} tools for session ${sessionId}`)
    }

    // Build response with full tool schemas from cache
    const formatted = results.map((entry) => {
      const cached = getCachedTool(entry.id)
      const schema = cached?.inputSchema
        ? JSON.stringify(cached.inputSchema, null, 2)
        : "(schema unavailable — tool will still work)"
      return [
        `### ${entry.id}`,
        `**Category:** ${entry.category}`,
        `**Description:** ${entry.description}`,
        `**Input Schema:**`,
        "```json",
        schema,
        "```",
      ].join("\n")
    })

    const header =
      enable && sessionId
        ? `Found ${results.length} enterprise tools (enabled for this session — you can now call them directly):\n`
        : `Found ${results.length} enterprise tools:\n`

    return {
      content: [{ type: "text", text: header + "\n" + formatted.join("\n\n") }],
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    mcpDebug(`[Enterprise MetaTools] Search failed: ${msg}`)
    return {
      content: [{ type: "text", text: `Enterprise tool search failed: ${msg}` }],
      isError: true,
    }
  }
}

/**
 * Handle enterprise_tool_execute calls
 */
export async function executeToolExecute(args: Record<string, unknown>): Promise<{
  content: { type: string; text: string }[]
  isError?: boolean
}> {
  const toolName = args.tool as string
  const toolArgs = (args.args as Record<string, unknown>) || {}

  if (!toolName) {
    return {
      content: [{ type: "text", text: 'Error: "tool" parameter is required.' }],
      isError: true,
    }
  }

  // Check if tool is enabled for the session
  const sessionId = getCurrentSessionId()
  if (sessionId) {
    const canExecute = await ToolSearch.canExecuteTool(sessionId, toolName)
    if (!canExecute) {
      return {
        content: [
          {
            type: "text",
            text:
              `Tool "${toolName}" is not enabled for this session. ` +
              `Use enterprise_tool_search first to find and enable it.`,
          },
        ],
        isError: true,
      }
    }
  }

  // Proxy the call to the license server
  try {
    mcpDebug(`[Enterprise MetaTools] Executing tool: ${toolName}`)
    const startTime = Date.now()
    const result = await proxyToolCall(toolName, toolArgs as Record<string, any>)
    const duration = Date.now() - startTime
    mcpDebug(`[Enterprise MetaTools] Tool ${toolName} completed in ${duration}ms`)

    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    mcpDebug(`[Enterprise MetaTools] Tool ${toolName} failed: ${msg}`)
    return {
      content: [{ type: "text", text: `Enterprise tool error (${toolName}): ${msg}` }],
      isError: true,
    }
  }
}
