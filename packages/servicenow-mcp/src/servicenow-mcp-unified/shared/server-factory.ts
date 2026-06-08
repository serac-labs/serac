/**
 * Build an MCP Server with all request handlers wired up.
 *
 * Transport-agnostic: the caller supplies a `resolveContext` strategy and a
 * prompt manager, then hooks up whatever transport (stdio, streamable HTTP)
 * onto the returned Server instance.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { registerHandlers } from "../handlers/register.js"
import { HandlerDeps } from "../handlers/types.js"

export interface ServerDeps extends HandlerDeps {
  name?: string
  version?: string
}

export const createServer = (deps: ServerDeps): Server => {
  const server = new Server(
    {
      name: deps.name ?? "servicenow-unified",
      version: deps.version ?? "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    },
  )

  registerHandlers(server, deps)
  return server
}
