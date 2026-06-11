/**
 * Meta-Tools for Lazy Loading Mode
 *
 * When SNOW_LAZY_TOOLS=true, only these 2 tools are registered in tools/list.
 * This reduces token usage from ~71k to ~2k while keeping all functionality available.
 *
 * Workflow:
 * 1. AI calls tool_search({query: "incidents"})
 * 2. Returns list of matching tools with their schemas
 * 3. AI calls tool_execute({tool: "snow_query_incidents", args: {...}})
 * 4. Tool is executed and result returned
 *
 * Session-based tool enabling:
 * - When enable=true (default), found tools are enabled for the current session
 * - Enabled tools are persisted to disk and restored on restart
 * - This allows filtering tools/list to only show enabled tools
 *
 * @see https://www.anthropic.com/engineering/advanced-tool-use
 */

import { type MCPToolDefinition, type ServiceNowContext } from "../../shared/types.js"
import { toolRegistry } from "../../shared/tool-registry.js"
import { ToolSearch } from "../../shared/tool-search.js"
import { isWriteTool } from "../../shared/instance-map-hook.js"
import {
  guardKey,
  requiresUpdateSet,
  updateSetActive,
  recordUpdateSetSkip,
  observeUpdateSetTool,
  confirmationFlag,
  prodWriteBlockMessage,
  updateSetBlockMessage,
} from "../../shared/update-set-guard.js"

// ============================================================================
// tool_search - Search for available tools
// ============================================================================

export const tool_search_def: MCPToolDefinition = {
  name: "tool_search",
  description: `Search for available ServiceNow tools when you need specialized functionality.

This tool searches through ALL 235+ available tools including:
- Core operations (queries, CRUD, bulk operations)
- Deployment (widgets, UI pages, script includes)
- CMDB and asset management
- Change/incident/problem management
- Knowledge base and service catalog
- Automation (scripts, scheduled jobs, events)
- Security (ACLs, policies, compliance)
- Reporting (dashboards, KPIs, reports)
- And many more specialized tools

IMPORTANT: After this tool returns, the found tools become IMMEDIATELY AVAILABLE.
You can call them directly via tool_execute by their exact tool name.

Example workflow:
1. tool_search({query: "incident query"})
   → Returns: snow_query_incidents, snow_query_table, ... [ENABLED]
2. tool_execute({tool: "snow_query_incidents", args: {query: "priority=1"}})
   → Executes the tool and returns results`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'Search query to find relevant tools. Examples: "incident", "widget deploy", "cmdb", "update set", "knowledge article", "change request"',
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 10)",
        default: 10,
      },
      enable: {
        type: "boolean",
        description:
          "Enable found tools for this session (default: true). When enabled, tools are marked [ENABLED] and can be called directly.",
        default: true,
      },
    },
    required: ["query"],
  },
}

/**
 * Transport allowlist check shared by the meta path. call-tool.ts enforces
 * `transports` for direct dispatch; tool_search/tool_execute must apply the
 * same rule or they become a bypass for stdio-only tools over HTTP.
 * Fail closed: an absent origin is treated as "http".
 */
function allowedOnTransport(definition: { transports?: string[] } | undefined, origin: string | undefined): boolean {
  const transports = definition?.transports
  if (!transports) return true
  return transports.includes(origin ?? "http")
}

export async function tool_search_exec(
  args: { query: string; limit?: number; enable?: boolean },
  context: ServiceNowContext,
): Promise<any> {
  const limit = args.limit || 10
  const enableTools = args.enable !== false // Default to true
  const sessionId = context.sessionId
  // Tenant-scope every ToolSearch call so two HTTP tenants with the same
  // session ID cannot enable each other's tools. Stdio fallback is "stdio".
  const tenantId = context.tenantId ?? "stdio"

  // Use ToolSearch.search() for consistent behavior with snow-flow
  // This searches the tool index populated at server startup
  const searchResults = ToolSearch.search(args.query, limit).filter((entry) =>
    allowedOnTransport(toolRegistry.getTool(entry.id)?.definition, context.origin),
  )

  // If no results from index, fall back to toolRegistry direct search
  // This handles the case where the index hasn't been populated yet
  if (searchResults.length === 0) {
    // Fallback: search toolRegistry directly
    const query = args.query.toLowerCase()
    const queryWords = query.split(/\s+/).filter((w) => w.length > 2)
    const allTools = toolRegistry
      .getToolDefinitions()
      .filter((tool) => allowedOnTransport(tool, context.origin))

    const scored = allTools.map((tool) => {
      let score = 0
      const nameLower = tool.name.toLowerCase()
      const descLower = tool.description.toLowerCase()

      if (nameLower === query) score += 100
      if (nameLower.includes(query)) score += 50
      const queryPart = query.replace(/^snow_?/, "")
      if (nameLower.includes(queryPart)) score += 40
      if (descLower.includes(query)) score += 20

      for (const word of queryWords) {
        if (nameLower.includes(word)) score += 15
        if (descLower.includes(word)) score += 5
      }

      const registeredTool = toolRegistry.getTool(tool.name)
      if (registeredTool && registeredTool.domain.toLowerCase().includes(query)) {
        score += 30
      }

      return { tool, score, domain: registeredTool?.domain || "unknown" }
    })

    const fallbackResults = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    if (fallbackResults.length === 0) {
      const domains = toolRegistry.getAvailableDomains().slice(0, 15)
      return {
        success: false,
        message: `No tools found matching "${args.query}"`,
        suggestion: `Try different keywords. Available domains: ${domains.join(", ")}`,
        available_domains: domains,
      }
    }

    // Enable and format fallback results
    if (enableTools && sessionId) {
      const toolNames = fallbackResults.map((r) => r.tool.name)
      await ToolSearch.enableTools(sessionId, toolNames, tenantId)
      console.error(`[tool_search] Enabled ${toolNames.length} tools for session ${sessionId}`)
    }

    const formattedTools = fallbackResults.map((r, i) => {
      const params = r.tool.inputSchema?.properties || {}
      const required = r.tool.inputSchema?.required || []
      const paramList = Object.entries(params).map(([name, prop]: [string, any]) => {
        const isRequired = required.includes(name)
        const type = prop.type || "any"
        return `    ${isRequired ? "*" : ""}${name}: ${type}${prop.description ? ` - ${prop.description.substring(0, 80)}` : ""}`
      })
      const status = enableTools && sessionId ? "[ENABLED]" : "[AVAILABLE]"
      return {
        rank: i + 1,
        name: r.tool.name,
        status,
        domain: r.domain,
        description: r.tool.description.substring(0, 200) + (r.tool.description.length > 200 ? "..." : ""),
        parameters: paramList.length > 0 ? paramList.slice(0, 5) : ["(no parameters)"],
        has_more_params: paramList.length > 5,
      }
    })

    const enabledMsg =
      enableTools && sessionId
        ? `\n\n✓ ${fallbackResults.length} tool(s) are now ENABLED for this session.\nCall them via tool_execute. Example:\ntool_execute({tool: "${fallbackResults[0]?.tool.name}", args: {...}})`
        : ""

    return {
      success: true,
      query: args.query,
      count: fallbackResults.length,
      enabled: enableTools && !!sessionId,
      sessionId: sessionId || null,
      tools: formattedTools,
      usage_hint: `To use a tool, call: tool_execute({tool: "${fallbackResults[0]?.tool.name}", args: {...}})${enabledMsg}`,
    }
  }

  // Process results from ToolSearch.search()
  // Enable found tools for this session if requested and sessionId is available
  if (enableTools && sessionId) {
    const toolIDs = searchResults.map((t) => t.id)
    await ToolSearch.enableTools(sessionId, toolIDs, tenantId)
    console.error(`[tool_search] Enabled ${toolIDs.length} tools for session ${sessionId}`)
  }

  // Format results with schema info from toolRegistry
  const formattedTools = searchResults.map((entry, i) => {
    const tool = toolRegistry.getTool(entry.id)
    const toolDef = tool?.definition
    const params = toolDef?.inputSchema?.properties || {}
    const required = toolDef?.inputSchema?.required || []

    const paramList = Object.entries(params).map(([name, prop]: [string, any]) => {
      const isRequired = required.includes(name)
      const type = prop.type || "any"
      return `    ${isRequired ? "*" : ""}${name}: ${type}${prop.description ? ` - ${prop.description.substring(0, 80)}` : ""}`
    })

    // Determine status based on deferred flag and enable setting
    const status = entry.deferred ? (enableTools && sessionId ? "[ENABLED]" : "[DEFERRED]") : "[AVAILABLE]"

    return {
      rank: i + 1,
      name: entry.id,
      status,
      domain: entry.category,
      description: entry.description + (entry.description.length >= 200 ? "..." : ""),
      parameters: paramList.length > 0 ? paramList.slice(0, 5) : ["(no parameters)"],
      has_more_params: paramList.length > 5,
    }
  })

  // Build enabled message (consistent with snow-flow)
  const enabledMsg =
    enableTools && sessionId
      ? `\n\n✓ ${searchResults.length} tool(s) are now ENABLED for this session.\nCall them via tool_execute. Example:\ntool_execute({tool: "${searchResults[0]?.id}", args: {...}})`
      : ""

  return {
    success: true,
    query: args.query,
    count: searchResults.length,
    enabled: enableTools && !!sessionId,
    sessionId: sessionId || null,
    tools: formattedTools,
    usage_hint: `To use a tool, call: tool_execute({tool: "${searchResults[0]?.id}", args: {...}})${enabledMsg}`,
  }
}

// ============================================================================
// tool_execute - Execute any tool by name
// ============================================================================

export const tool_execute_def: MCPToolDefinition = {
  name: "tool_execute",
  description: `Execute any ServiceNow tool by name. Use this after tool_search to call the tools you found.

This is the gateway to ALL 235+ ServiceNow tools. After searching with tool_search,
use this tool to execute the found tools.

Example:
1. tool_search({query: "query incidents"})
   → Found: snow_query_incidents
2. tool_execute({
     tool: "snow_query_incidents",
     args: { query: "priority=1^state!=7", limit: 10 }
   })
   → Returns the query results

The 'args' parameter should match the tool's input schema from tool_search results.`,
  inputSchema: {
    type: "object",
    properties: {
      tool: {
        type: "string",
        description: "The exact tool name to execute (from tool_search results)",
      },
      args: {
        type: "object",
        description: "Arguments to pass to the tool (must match tool's input schema)",
        additionalProperties: true,
      },
    },
    required: ["tool", "args"],
  },
}

export async function tool_execute_exec(
  args: { tool: string; args: Record<string, any> },
  context: ServiceNowContext,
): Promise<any> {
  const toolName = args.tool
  const toolArgs = args.args || {}
  const sessionId = context.sessionId
  // See tool_search_exec — tenantId scopes every ToolSessionStore lookup.
  const tenantId = context.tenantId ?? "stdio"

  // Get tool from registry
  const tool = toolRegistry.getTool(toolName)

  if (!tool) {
    // Try to find similar tools
    const allTools = toolRegistry.getToolDefinitions()
    const similar = allTools
      .filter((t) => t.name.includes(toolName) || toolName.includes(t.name.replace("snow_", "")))
      .slice(0, 5)
      .map((t) => t.name)

    return {
      success: false,
      error: `Tool not found: ${toolName}`,
      suggestion:
        similar.length > 0
          ? `Did you mean one of these? ${similar.join(", ")}`
          : "Use tool_search to find available tools",
      hint: 'Use tool_search({query: "your task"}) to find the right tool',
    }
  }

  // Enforce the transport allowlist exactly like the direct dispatch path in
  // call-tool.ts — tool_execute must not be a bypass for stdio-only tools
  // (local filesystem + child processes) over the multi-tenant HTTP transport.
  if (!allowedOnTransport(tool.definition, context.origin)) {
    return {
      success: false,
      error:
        `Tool "${toolName}" is not available over the ${context.origin ?? "http"} transport ` +
        `(allowed transports: ${(tool.definition.transports ?? []).join(", ")}).`,
    }
  }
  const forbidden = tool.definition.httpForbiddenArgs
  if ((context.origin ?? "http") === "http" && forbidden) {
    for (const arg of forbidden) {
      if (toolArgs[arg] !== undefined) {
        return {
          success: false,
          error:
            `Tool "${toolName}" cannot accept the "${arg}" argument over HTTP transport ` +
            `(it would touch the shared filesystem). Use the inline-content equivalent instead.`,
        }
      }
    }
  }

  // Mirror the write-guards from the direct dispatch path (call-tool.ts):
  // without them tool_execute is a bypass around the prod-write and
  // update-set confirmations. Same messages, same lenient flag parsing.
  const prodWrite = context.environmentType === "production" && isWriteTool(tool.definition)
  if (prodWrite && !confirmationFlag(toolArgs.__confirmProd)) {
    return { success: false, error: prodWriteBlockMessage(toolName) }
  }
  const usKey = guardKey(context.tenantId, sessionId, context.instanceUrl)
  if (confirmationFlag(toolArgs.__skipUpdateSet)) {
    recordUpdateSetSkip(usKey)
  }
  if (requiresUpdateSet(tool.definition, toolArgs) && !updateSetActive(usKey)) {
    return { success: false, error: updateSetBlockMessage(toolName) }
  }

  // Check if tool is deferred and needs to be enabled first
  const canExecute = await ToolSearch.canExecuteTool(sessionId, toolName, tenantId)
  if (!canExecute) {
    const toolStatus = await ToolSearch.getToolStatus(sessionId, toolName, tenantId)
    const queryHint = toolName.replace("snow_", "").replace(/_/g, " ")
    return {
      success: false,
      error: `Tool "${toolName}" is ${toolStatus} and must be enabled first`,
      hint: `Use tool_search({query: "${queryHint}"}) to enable this tool`,
      status: toolStatus,
    }
  }

  // Execute the tool. Strip the guard flags so executors never see them,
  // and feed update-set lifecycle tools into the guard state — in lazy
  // mode (TUI) snow_ensure_active_update_set runs through THIS path, so
  // without the observe call the guard could never be lifted.
  const execArgs = Object.fromEntries(
    Object.entries(toolArgs).filter(([k]) => k !== "__confirmProd" && k !== "__skipUpdateSet"),
  )
  try {
    console.error(`[MetaTool] Executing via tool_execute: ${toolName}`)
    const result = await tool.executor(execArgs, context)
    observeUpdateSetTool(toolName, execArgs, result, usKey)
    return {
      success: true,
      tool: toolName,
      result,
    }
  } catch (error: any) {
    return {
      success: false,
      tool: toolName,
      error: error.message,
      hint: "Check tool_search results for correct parameter format",
    }
  }
}

// ============================================================================
// Export meta-tools array for easy registration
// ============================================================================

export const META_TOOLS = [
  { definition: tool_search_def, executor: tool_search_exec },
  { definition: tool_execute_def, executor: tool_execute_exec },
]
