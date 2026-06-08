import type { CommandModule } from "yargs"

// Hidden subcommand: runs the bundled Serac enterprise-proxy MCP stdio server
// in-process. The serac-dashboard plugin's config hook points the
// `serac-enterprise` MCP server's `command` at `[<serac binary>,
// x-servicenow-enterprise]` when running as a compiled binary (where the
// package's enterprise-proxy bin isn't on PATH), so the platform-brokered
// enterprise tools ship inside the single serac binary.
//
// In enterprise mode the platform brokers ServiceNow + all integrations: the
// proxy reads the dashboard JWT from SNOW_LICENSE_KEY (set by the config hook)
// or ~/.serac/enterprise.json and forwards tool calls to the license server.
export const ServiceNowEnterpriseMcpStdioCommand: CommandModule = {
  command: "x-servicenow-enterprise",
  describe: false,
  async handler() {
    const { startEnterpriseProxy } = await import("@serac-labs/servicenow-mcp/enterprise-proxy")
    await startEnterpriseProxy()
    // The stdio transport reads from stdin; keep the process alive until the
    // parent (the MCP client) closes it.
    await new Promise(() => {})
  },
}
