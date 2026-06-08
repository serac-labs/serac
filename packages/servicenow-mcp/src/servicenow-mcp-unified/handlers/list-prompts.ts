/**
 * MCP `ListPrompts` request handler.
 */

import { mcpDebug } from "../../shared/mcp-debug.js"
import { HandlerDeps } from "./types.js"

export const listPrompts = (deps: HandlerDeps) => async () => {
  const prompts = deps.promptManager.listPrompts()
  mcpDebug(`[Server] Listing ${prompts.length} prompts`)

  return {
    prompts: prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments?.map((arg) => ({
        name: arg.name,
        description: arg.description,
        required: arg.required,
      })),
    })),
  }
}
