import type { CommandModule } from "yargs"

// Hidden subcommand: runs the bundled ServiceNow MCP stdio server in-process.
// The servicenow plugin's config hook points the MCP server's `command` at
// `[<serac binary>, x-servicenow-mcp]` when running as a compiled binary (where
// the standalone `servicenow-mcp-stdio` bin isn't on PATH), so the ~429
// ServiceNow tools ship inside the single serac binary. The server reads its
// SERVICENOW_* config from the environment the MCP client passes through.
export const ServiceNowMcpStdioCommand: CommandModule = {
  command: "x-servicenow-mcp",
  describe: false,
  async handler() {
    const { startStdio } = await import("@serac-labs/servicenow-mcp/stdio")
    await startStdio()
    // The stdio transport reads from stdin; keep the process alive until the
    // parent (the MCP client) closes it.
    await new Promise(() => {})
  },
}
