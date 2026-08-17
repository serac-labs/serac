/**
 * Register all MCP request handlers on a Server instance.
 *
 * This is the single entry point that wires up handler functions to the
 * MCP protocol schemas. Any transport (stdio, HTTP, ...) can call this with
 * its own `HandlerDeps` — the handlers themselves stay transport-agnostic.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { mcpDebug } from "../../shared/mcp-debug.js"
import { listTools } from "./list-tools.js"
import { callTool } from "./call-tool.js"
import { listPrompts } from "./list-prompts.js"
import { getPrompt } from "./get-prompt.js"
import { type HandlerDeps } from "./types.js"

export const registerHandlers = (server: Server, deps: HandlerDeps): void => {
  server.setRequestHandler(ListToolsRequestSchema, listTools(deps))
  // callTool gets the Server itself because one tool changes the tool list:
  // tool_search enables deferred tools for the session, and the client only
  // learns about it from notifications/tools/list_changed.
  server.setRequestHandler(CallToolRequestSchema, callTool(deps, server))
  server.setRequestHandler(ListPromptsRequestSchema, listPrompts(deps))
  server.setRequestHandler(GetPromptRequestSchema, getPrompt(deps))

  // Error handler
  server.onerror = (error) => {
    mcpDebug("[Server] MCP Error:", error)
  }
}
