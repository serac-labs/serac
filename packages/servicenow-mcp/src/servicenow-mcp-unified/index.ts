#!/usr/bin/env node
/**
 * ServiceNow Unified MCP Server Entry Point
 *
 * Consolidates 34 separate ServiceNow MCP servers into a single
 * unified server with auto-discovery of 235+ tools.
 *
 * Usage:
 *   node dist/mcp/servicenow-mcp-unified/index.js
 *
 * Flags:
 *   --doctor - diagnose the credential setup and exit, without starting the server
 *
 * Environment Variables:
 *   SNOW_INSTANCE_URL / SERVICENOW_INSTANCE_URL - ServiceNow instance URL
 *   SNOW_CLIENT_ID / SERVICENOW_CLIENT_ID - OAuth client ID
 *   SNOW_CLIENT_SECRET / SERVICENOW_CLIENT_SECRET - OAuth client secret
 *   SERVICENOW_REFRESH_TOKEN - OAuth refresh token (optional, will be cached)
 *   The full list, per credential field, is ENV_VARS in shared/context-loader.ts.
 */

import { startStdio } from "./transports/stdio.js"
import * as dotenv from "dotenv"
import * as path from "path"
import { mcpDebug } from "../shared/mcp-debug.js"
import { ENV_VARS } from "./shared/context-loader.js"
// Anonymous, content-free usage telemetry. This import lives in the stdio
// entry point and nowhere else: the HTTP transport must never emit, because
// it is the platform's multi-tenant server and its "sessions" are our own
// infrastructure, not people who installed anything. See the module header
// and transports/__tests__/telemetry-stdio-only.test.ts.
import { AnonymousTelemetry } from "../telemetry/anonymous-telemetry.js"

/**
 * Main entry point
 */
async function main() {
  try {
    // 🆕 Preserve MCP client env vars before loading .env
    // MCP clients (like Claude Code) set env vars from mcp.json which should take priority
    //
    // Built from ENV_VARS rather than listed by hand: this list used to name
    // eight variables and the loader read a different set, so a documented
    // variable could be missing from both without anything noticing.
    const mcpEnvVars = Object.fromEntries(
      [...Object.values(ENV_VARS).flat(), "SNOW_LAZY_TOOLS", "SNOW_TOOL_DOMAINS"].map((name) => [name, process.env[name]]),
    )

    // Load environment variables from .env file
    // Note: dotenv should NOT override existing vars, but we preserve them anyway for safety
    //
    // `quiet: true` is load-bearing, not cosmetic. This is the stdio transport:
    // stdout IS the JSON-RPC channel, and dotenv v17 prints an "[dotenv@17.2.3]
    // injecting env (0) from .env -- tip: ..." banner there on every call. That
    // banner is not JSON, so a strict MCP client fails to parse the stream
    // before the server has answered anything. Diagnostics belong on stderr,
    // which is what mcpDebug() below uses.
    const result = dotenv.config({ quiet: true })

    if (result.error) {
      // Try loading from parent directory (common when MCP server is in subdirectory)
      const parentEnvPath = path.resolve(process.cwd(), "..", ".env")
      const parentResult = dotenv.config({ path: parentEnvPath, quiet: true })

      if (parentResult.error) {
        mcpDebug("[Main] No .env file found - using environment variables from MCP configuration")
      } else {
        mcpDebug("[Main] Loaded environment from parent directory:", parentEnvPath)
      }
    } else {
      mcpDebug("[Main] Loaded environment from .env file")
    }

    // 🆕 Restore MCP client env vars (they take priority over .env)
    // This ensures mcp.json "env" settings override .env file settings
    for (const [key, value] of Object.entries(mcpEnvVars)) {
      if (value !== undefined) {
        if (process.env[key] !== value) {
          mcpDebug(`[Main] Restoring MCP config override: ${key}`)
        }
        process.env[key] = value
      }
    }

    // --doctor: diagnose the credential setup and exit. It runs here, after
    // .env is loaded and the MCP overrides are restored, so it reports the
    // credentials the server would actually have used — and before the
    // transport, so no JSON-RPC session is ever opened. That is what makes it
    // safe to print the report on stdout: this process will not speak the
    // protocol. Never write anything but JSON to stdout on the server path.
    if (process.argv.slice(2).includes("--doctor")) {
      const { runSetupDoctor, renderReport } = await import("./shared/setup-doctor.js")
      const report = await runSetupDoctor()
      console.log(renderReport(report))
      process.exit(report.ok ? 0 : 1)
    }

    // Log active configuration mode
    if (process.env.SNOW_LAZY_TOOLS === "true") {
      mcpDebug("[Main] SNOW_LAZY_TOOLS=true (lazy loading mode enabled)")
    }
    if (process.env.SNOW_TOOL_DOMAINS) {
      mcpDebug(`[Main] SNOW_TOOL_DOMAINS=${process.env.SNOW_TOOL_DOMAINS}`)
    }

    // Start the anonymous session ping. Deliberately after dotenv, so an
    // opt-out written into a project's .env (DO_NOT_TRACK,
    // SERAC_TELEMETRY_DISABLED) is honoured, and before the transport, so a
    // session that dies during bootstrap is still counted. Never awaited.
    AnonymousTelemetry.start()

    // Bootstrap + connect stdio transport
    const { stop } = await startStdio({ onToolCall: AnonymousTelemetry.recordToolCall })

    // Graceful shutdown handlers. The end ping is fired before `stop()` so it
    // travels while the server closes, then given a capped moment to settle
    // after — without that, `process.exit` kills the request mid-flight and
    // the delivered-but-unconfirmed ping gets re-sent on the next launch as a
    // duplicate. Nothing user-facing waits on this; the server is already down.
    process.on("SIGINT", async () => {
      mcpDebug("\n[Main] Received SIGINT, shutting down gracefully...")
      AnonymousTelemetry.finish("interrupt")
      await stop()
      await AnonymousTelemetry.settle()
      process.exit(0)
    })

    process.on("SIGTERM", async () => {
      mcpDebug("\n[Main] Received SIGTERM, shutting down gracefully...")
      AnonymousTelemetry.finish("interrupt")
      await stop()
      await AnonymousTelemetry.settle()
      process.exit(0)
    })
  } catch (error: any) {
    mcpDebug("[Main] Fatal error:", error.message)
    mcpDebug(error.stack)
    AnonymousTelemetry.finish("error", error)
    await AnonymousTelemetry.settle()
    process.exit(1)
  }
}

// Run server
main()
