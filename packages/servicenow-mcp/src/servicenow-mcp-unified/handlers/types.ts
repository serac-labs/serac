/**
 * Shared types for MCP request handlers.
 */

import { MCPPromptManager } from "../../shared/mcp-prompt-manager.js"
import { RequestContext } from "../shared/types.js"

/**
 * Resolves a per-request `RequestContext` from a transport-specific request.
 *
 * - Stdio transport returns a closure that produces a context with static
 *   ServiceNow credentials (loaded once at startup) plus per-request session
 *   ID derived from env vars / ToolSearch session file / JWT header.
 * - HTTP transport reads the inbound `Authorization` header from
 *   `extra.requestInfo.headers` (populated by the MCP SDK's web-standard
 *   streamable HTTP transport) and forwards it to a resolver endpoint that
 *   verifies the JWT, looks up the tenant, and decrypts credentials.
 *
 * `extra` is the `RequestHandlerExtra` from the MCP SDK; its `requestInfo`
 * field is the only reliable place the HTTP headers live. The JSON-RPC
 * `request` param never carries them. stdio transports pass `undefined`.
 */
export type ContextResolver = (request: any, extra?: any) => Promise<RequestContext>

/**
 * Dependencies passed to every MCP request handler.
 */
export interface HandlerDeps {
  resolveContext: ContextResolver
  promptManager: MCPPromptManager
}
