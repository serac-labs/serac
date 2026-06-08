/**
 * Shared types for the enterprise-proxy MCP request handlers.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js"

export interface ProxyPrompt {
  name: string
  description: string
  arguments: never[]
}

/**
 * Dependencies passed to every enterprise-proxy MCP request handler.
 *
 * The proxy is single-tenant (one licence-holder per process), so there's
 * no per-request context to resolve — static config is all the handlers
 * need.
 */
export interface ProxyHandlerDeps {
  /** Meta-tools (`enterprise_tool_search`, `enterprise_tool_execute`). */
  metaTools: Tool[]
  /** Whether lazy-tool mode is enabled for this process. */
  lazyEnabled: boolean
  /** Registered prompts — currently an empty list. */
  prompts: ProxyPrompt[]
  /** Prompt name → rendered content. */
  promptContent: Record<string, string>
}
