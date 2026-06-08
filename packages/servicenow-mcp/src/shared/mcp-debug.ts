/**
 * Debug logger for MCP servers.
 * Only writes to stderr when SNOW_MCP_DEBUG=true.
 * This prevents Claude Desktop from showing parse errors
 * for non-JSON stderr output.
 */
const DEBUG = process.env.SNOW_MCP_DEBUG === "true"

export function mcpDebug(...args: any[]) {
  if (DEBUG) console.error(...args)
}

export function mcpWarn(...args: any[]) {
  if (DEBUG) console.warn(...args)
}
