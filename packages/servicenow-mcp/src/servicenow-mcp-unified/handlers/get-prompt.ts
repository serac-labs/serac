/**
 * MCP `GetPrompt` request handler.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import { mcpDebug } from "../../shared/mcp-debug.js"
import { HandlerDeps } from "./types.js"

export const getPrompt = (deps: HandlerDeps) => async (request: any) => {
  const { name, arguments: args } = request.params
  mcpDebug(`[Server] Getting prompt: ${name}`)

  try {
    const prompt = deps.promptManager.getPrompt(name)
    if (!prompt) {
      throw new McpError(ErrorCode.InvalidRequest, `Prompt not found: ${name}`)
    }

    // Execute the prompt to get the messages
    const result = await deps.promptManager.executePrompt(name, (args as Record<string, string>) || {})

    return {
      description: result.description || prompt.description,
      messages: result.messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
    }
  } catch (error: any) {
    mcpDebug(`[Server] Prompt execution failed: ${name}`, error.message)
    throw new McpError(ErrorCode.InternalError, error.message)
  }
}
