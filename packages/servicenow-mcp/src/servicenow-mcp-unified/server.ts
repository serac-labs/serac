/**
 * Public API for the ServiceNow unified MCP server.
 *
 * Thin re-export layer — concrete implementations live in:
 *   - transports/stdio.ts      (stdio bootstrap + shutdown)
 *   - transports/http.ts       (HTTP/streamable MCP via Hono, multi-tenant)
 *   - shared/server-factory.ts (createServer factory used by every transport)
 *
 * Existing consumers (entry-point, tests) can continue to import from
 * `./server.js`. New code should prefer the more specific transport / factory
 * modules directly.
 */

export { startStdio, type StdioHandle } from "./transports/stdio.js"
export { createHttpApp, type HttpAppDeps } from "./transports/http.js"
export { createServer, type ServerDeps } from "./shared/server-factory.js"
