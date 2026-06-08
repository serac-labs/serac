/**
 * Wire enterprise-proxy MCP request handlers onto a Server instance.
 *
 * Single entry point — call this once after `new Server(...)` and before
 * connecting a transport.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

import { listTools } from "./list-tools.js"
import { callTool } from "./call-tool.js"
import { listPrompts } from "./list-prompts.js"
import { getPrompt } from "./get-prompt.js"
import type { ProxyHandlerDeps } from "./types.js"

export const registerHandlers = (server: Server, deps: ProxyHandlerDeps): void => {
  server.setRequestHandler(ListToolsRequestSchema, listTools(deps))
  server.setRequestHandler(CallToolRequestSchema, callTool(deps))
  server.setRequestHandler(ListPromptsRequestSchema, listPrompts(deps))
  server.setRequestHandler(GetPromptRequestSchema, getPrompt(deps))
}
