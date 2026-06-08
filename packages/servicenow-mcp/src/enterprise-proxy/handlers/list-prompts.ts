/**
 * Enterprise-proxy `ListPrompts` request handler.
 */

import { mcpDebug } from "../../shared/mcp-debug.js"
import type { ProxyHandlerDeps } from "./types.js"

export const listPrompts = (deps: ProxyHandlerDeps) => async () => {
  mcpDebug(`[Proxy] Listing ${deps.prompts.length} prompts`)
  return {
    prompts: deps.prompts,
  }
}
