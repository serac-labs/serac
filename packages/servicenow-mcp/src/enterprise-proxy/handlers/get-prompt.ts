/**
 * Enterprise-proxy `GetPrompt` request handler.
 */

import { mcpDebug } from "../../shared/mcp-debug.js"
import type { ProxyHandlerDeps } from "./types.js"

export const getPrompt = (deps: ProxyHandlerDeps) => async (request: any) => {
  const promptName = request.params.name
  mcpDebug(`[Proxy] Getting prompt: ${promptName}`)

  const content = deps.promptContent[promptName]
  if (!content) {
    throw new Error(`Prompt not found: ${promptName}`)
  }

  return {
    description: deps.prompts.find((p) => p.name === promptName)?.description ?? "",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: content,
        },
      },
    ],
  }
}
