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
 * Environment Variables:
 *   SERVICENOW_INSTANCE_URL - ServiceNow instance URL
 *   SERVICENOW_CLIENT_ID - OAuth client ID
 *   SERVICENOW_CLIENT_SECRET - OAuth client secret
 *   SERVICENOW_REFRESH_TOKEN - OAuth refresh token (optional, will be cached)
 */

import { startStdio } from "./transports/stdio.js"
import * as dotenv from "dotenv"
import * as path from "path"
import { mcpDebug } from "../shared/mcp-debug.js"

/**
 * Main entry point
 */
async function main() {
  try {
    // 🆕 Preserve MCP client env vars before loading .env
    // MCP clients (like Claude Code) set env vars from mcp.json which should take priority
    const mcpEnvVars = {
      SNOW_LAZY_TOOLS: process.env.SNOW_LAZY_TOOLS,
      SNOW_TOOL_DOMAINS: process.env.SNOW_TOOL_DOMAINS,
      SNOW_INSTANCE: process.env.SNOW_INSTANCE,
      SERVICENOW_INSTANCE_URL: process.env.SERVICENOW_INSTANCE_URL,
      SNOW_CLIENT_ID: process.env.SNOW_CLIENT_ID,
      SERVICENOW_CLIENT_ID: process.env.SERVICENOW_CLIENT_ID,
      SNOW_CLIENT_SECRET: process.env.SNOW_CLIENT_SECRET,
      SERVICENOW_CLIENT_SECRET: process.env.SERVICENOW_CLIENT_SECRET,
    }

    // Load environment variables from .env file
    // Note: dotenv should NOT override existing vars, but we preserve them anyway for safety
    const result = dotenv.config()

    if (result.error) {
      // Try loading from parent directory (common when MCP server is in subdirectory)
      const parentEnvPath = path.resolve(process.cwd(), "..", ".env")
      const parentResult = dotenv.config({ path: parentEnvPath })

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

    // Log active configuration mode
    if (process.env.SNOW_LAZY_TOOLS === "true") {
      mcpDebug("[Main] SNOW_LAZY_TOOLS=true (lazy loading mode enabled)")
    }
    if (process.env.SNOW_TOOL_DOMAINS) {
      mcpDebug(`[Main] SNOW_TOOL_DOMAINS=${process.env.SNOW_TOOL_DOMAINS}`)
    }

    // Bootstrap + connect stdio transport
    const { stop } = await startStdio()

    // Graceful shutdown handlers
    process.on("SIGINT", async () => {
      mcpDebug("\n[Main] Received SIGINT, shutting down gracefully...")
      await stop()
      process.exit(0)
    })

    process.on("SIGTERM", async () => {
      mcpDebug("\n[Main] Received SIGTERM, shutting down gracefully...")
      await stop()
      process.exit(0)
    })
  } catch (error: any) {
    mcpDebug("[Main] Fatal error:", error.message)
    mcpDebug(error.stack)
    process.exit(1)
  }
}

// Run server
main()
