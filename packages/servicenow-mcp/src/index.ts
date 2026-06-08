export { startStdio, type StdioHandle } from "./servicenow-mcp-unified/transports/stdio.js"
export { createHttpApp, type HttpAppDeps } from "./servicenow-mcp-unified/transports/http.js"
export { createServer, type ServerDeps } from "./servicenow-mcp-unified/shared/server-factory.js"
export * from "./servicenow-mcp-unified/tools/blast-radius/index.js"
export type {
  ServiceNowContext,
  MCPToolDefinition,
  ToolResult,
  ToolExecutor,
  UserRole,
} from "./servicenow-mcp-unified/shared/types.js"
