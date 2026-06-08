#!/usr/bin/env node
/**
 * Serac Enterprise MCP Proxy
 *
 * Forwards MCP tool requests from Claude Code to the Enterprise License Server.
 * This allows the open source Serac to use enterprise-hosted tools.
 *
 * Architecture:
 * Claude Code → stdio → This Proxy → HTTPS → License Server → External APIs
 *
 * IMPORTANT: Credentials (Jira, Azure DevOps, Confluence, GitHub, GitLab) are
 * fetched by the enterprise MCP server from the Portal API using the JWT token.
 * No local credentials are needed - just SNOW_ENTERPRISE_URL and SNOW_LICENSE_KEY.
 *
 * TOKEN RESOLUTION:
 * The proxy reads tokens from (in order):
 * 1. ~/.snow-code/enterprise.json (most recent device auth token)
 * 2. SNOW_LICENSE_KEY environment variable (from .mcp.json)
 *
 * Usage:
 * node server.js
 *
 * Environment Variables:
 * - SNOW_ENTERPRISE_URL: License server URL (required)
 * - SNOW_LICENSE_KEY: JWT token for authentication (optional if enterprise.json exists)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import fs from "fs"
import path from "path"
import os from "os"

import { mcpDebug } from "../shared/mcp-debug.js"
import { ENTERPRISE_META_TOOLS } from "./meta-tools.js"
import { registerHandlers } from "./handlers/register.js"
import type { ProxyPrompt } from "./handlers/types.js"

// Configuration from environment variables
const LICENSE_SERVER_URL = process.env.SNOW_ENTERPRISE_URL || "https://enterprise.serac.build"
const LAZY_TOOLS_ENABLED = process.env.SNOW_ENTERPRISE_LAZY_TOOLS !== "false"

/**
 * Check if a valid token source exists. Either `~/.snow-code/enterprise.json`
 * or the `SNOW_LICENSE_KEY` / `SNOW_ENTERPRISE_LICENSE_KEY` env var.
 */
function hasValidTokenSource(): boolean {
  const enterpriseJsonPath = path.join(os.homedir(), ".snow-code", "enterprise.json")
  try {
    if (fs.existsSync(enterpriseJsonPath)) {
      const content = fs.readFileSync(enterpriseJsonPath, "utf-8")
      const config = JSON.parse(content)
      if (config.token) return true
    }
  } catch {
    // Ignore errors, check env var next
  }

  const envKey = process.env.SNOW_LICENSE_KEY || process.env.SNOW_ENTERPRISE_LICENSE_KEY
  return !!envKey?.trim()
}

/**
 * Log the active configuration (with a token preview) at startup.
 */
function logConfiguration(): void {
  let tokenSource = "environment variable"
  let tokenPreview = "(none)"

  const enterpriseJsonPath = path.join(os.homedir(), ".snow-code", "enterprise.json")
  try {
    if (fs.existsSync(enterpriseJsonPath)) {
      const content = fs.readFileSync(enterpriseJsonPath, "utf-8")
      const config = JSON.parse(content)
      if (config.token) {
        tokenSource = "~/.snow-code/enterprise.json"
        tokenPreview = config.token.substring(0, 20) + "..."
      }
    }
  } catch {
    // Fall back to env var
  }

  if (tokenSource === "environment variable") {
    const envKey = process.env.SNOW_LICENSE_KEY || process.env.SNOW_ENTERPRISE_LICENSE_KEY
    if (envKey?.trim()) {
      tokenPreview = envKey.trim().substring(0, 20) + "..."
    }
  }

  mcpDebug("═══════════════════════════════════════════════════")
  mcpDebug("Serac Enterprise MCP Proxy")
  mcpDebug("═══════════════════════════════════════════════════")
  mcpDebug(`License Server: ${LICENSE_SERVER_URL}`)
  mcpDebug(`Token Source: ${tokenSource}`)
  mcpDebug(`JWT Token: ${tokenPreview}`)
  mcpDebug("")
  mcpDebug("Credentials are fetched from Portal API by enterprise server")
  mcpDebug("═══════════════════════════════════════════════════")
  mcpDebug("")
}

/**
 * Build a fully-wired enterprise proxy server. Caller is responsible for
 * validating configuration and connecting a transport.
 */
function createProxyServer(): Server {
  const server = new Server(
    {
      name: "serac-enterprise-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    },
  )

  // Prompts are currently empty — the proxy relies on tool descriptions
  // rather than prompt templates for AI guidance. The empty arrays are kept
  // so MCP clients that query ListPrompts get a valid response.
  const prompts: ProxyPrompt[] = []
  const promptContent: Record<string, string> = {}

  registerHandlers(server, {
    metaTools: ENTERPRISE_META_TOOLS,
    lazyEnabled: LAZY_TOOLS_ENABLED,
    prompts,
    promptContent,
  })

  return server
}

async function main(): Promise<void> {
  if (!LICENSE_SERVER_URL) {
    throw new Error("SNOW_ENTERPRISE_URL environment variable is required")
  }
  if (!hasValidTokenSource()) {
    throw new Error(
      "No valid token found. Either:\n" +
        "  1. Run: snow-code auth login (to create ~/.snow-code/enterprise.json)\n" +
        "  2. Or set SNOW_LICENSE_KEY environment variable",
    )
  }

  const server = createProxyServer()
  logConfiguration()

  const transport = new StdioServerTransport()
  await server.connect(transport)
  mcpDebug("[Proxy] ✓ Enterprise MCP Proxy running on stdio")
  mcpDebug("[Proxy] Ready to receive requests from Claude Code")
}

main().catch((error: any) => {
  mcpDebug("[Proxy] Failed to start:", error?.message ?? error)
  process.exit(1)
})
