/**
 * Enterprise MCP Proxy
 * Handles HTTPS communication with enterprise license server
 *
 * IMPORTANT: Credentials (Jira, Azure DevOps, Confluence, GitHub, GitLab) are
 * fetched by the enterprise MCP server from the Portal API using the JWT token.
 * No local credentials are needed.
 *
 * TOKEN RESOLUTION ORDER:
 * 1. ~/.snow-code/enterprise.json (most recent device auth token)
 * 2. SNOW_LICENSE_KEY environment variable (from .mcp.json)
 * This ensures the freshest token is always used, even if .mcp.json is stale.
 */

import axios, { AxiosError } from "axios"
import crypto from "crypto"
// Default import, NOT `import { machineIdSync }`. node-machine-id ships a
// webpack-bundled CommonJS file; cjs-module-lexer sees only `default` and
// `electron-machine-id` on it, so Node throws
// `SyntaxError: Named export 'machineIdSync' not found` at import time — before
// any of this module's code runs. That killed five of the published subpaths
// (".", "/server", "/http", "/stdio", "/enterprise-proxy") and both bins for
// every `npm install` consumer, while staying invisible under Bun (whose CJS
// interop is more forgiving) and therefore in the GHCR mcp-http image, whose
// CMD is bun. `.github/workflows/publish-mcp.yml`'s smoke gate now imports
// every subpath and both bins under node so this cannot silently return.
import nodeMachineId from "node-machine-id"
import fs from "fs"
import path from "path"
import os from "os"
import {
  type EnterpriseToolCallRequest,
  type EnterpriseToolCallResponse,
  type EnterpriseToolListResponse,
  type EnterpriseTool,
} from "./types.js"
import { mcpDebug } from "../shared/mcp-debug.js"

// Configuration from environment variables
const ENTERPRISE_URL = process.env.SNOW_ENTERPRISE_URL || "https://enterprise.serac.build"
const PORTAL_URL = process.env.SNOW_PORTAL_URL || "https://portal.serac.build"
const VERSION = (process.env.SERAC_VERSION || process.env.SNOW_FLOW_VERSION) || "8.30.31"

/**
 * Get the license key/token from the most reliable source
 * Priority:
 * 1. ~/.snow-code/enterprise.json (freshest token from device auth)
 * 2. SNOW_LICENSE_KEY environment variable (from .mcp.json)
 *
 * This solves the problem where users have multiple projects with different
 * .mcp.json files that may contain stale tokens.
 */
function getConfiguredLicenseKey(): string | undefined {
  // 1. First try to read from enterprise.json (most recent device auth). The
  //    Serac dashboard /auth flow writes ~/.serac/enterprise.json; the legacy
  //    pre-rebrand path was ~/.snow-code/enterprise.json — read whichever
  //    exists, preferring the new one, so existing installs keep working.
  const candidates = [
    path.join(os.homedir(), ".serac", "enterprise.json"),
    path.join(os.homedir(), ".snow-code", "enterprise.json"),
  ]
  for (const enterpriseJsonPath of candidates) {
    try {
      if (fs.existsSync(enterpriseJsonPath)) {
        const content = fs.readFileSync(enterpriseJsonPath, "utf-8")
        const config = JSON.parse(content)
        if (config.token) {
          mcpDebug(`[Enterprise Proxy] Using token from ${enterpriseJsonPath} (device auth)`, {
            tokenLength: config.token.length,
            subdomain: config.subdomain || "unknown",
          })
          return config.token.trim()
        }
      }
    } catch (err) {
      mcpDebug(`[Enterprise Proxy] Could not read ${enterpriseJsonPath}, trying next source`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 2. Fall back to environment variable (from .mcp.json)
  const envKey = process.env.SNOW_LICENSE_KEY || process.env.SNOW_ENTERPRISE_LICENSE_KEY
  if (envKey) {
    mcpDebug("[Enterprise Proxy] Using token from SNOW_LICENSE_KEY environment variable", {
      tokenLength: envKey.length,
    })
    return envKey.trim()
  }

  return undefined
}

// NOTE: We no longer cache the license key at module load time
// Instead, getJwtToken() calls getConfiguredLicenseKey() dynamically
// This ensures we always use the freshest token from enterprise.json

// Generate unique machine ID for tracking
let INSTANCE_ID: string
try {
  INSTANCE_ID = nodeMachineId.machineIdSync()
} catch {
  // Fallback if machine ID generation fails
  INSTANCE_ID = `fallback-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
}

// JWT token cache
let cachedJwtToken: string | null = null
let jwtTokenExpiry: number = 0

/**
 * Check if a string is a JWT token
 * JWT tokens are base64url encoded and have 3 parts separated by dots
 */
function isJwtToken(value: string): boolean {
  // JWT tokens start with "eyJ" (base64 encoded '{"')
  if (!value.startsWith("eyJ")) {
    return false
  }
  // JWT tokens have exactly 3 parts separated by dots
  const parts = value.split(".")
  return parts.length === 3
}

/**
 * Get JWT token for authentication
 *
 * Supports two modes:
 * 1. Direct JWT token: If SNOW_LICENSE_KEY is already a JWT token (from device auth),
 *    use it directly without exchanging.
 * 2. License key exchange: If SNOW_LICENSE_KEY is a raw license key (SNOW-ENT-*),
 *    exchange it for a JWT token via /api/auth/mcp/login.
 *
 * Caches the JWT token until it expires.
 */
async function getJwtToken(): Promise<string> {
  // Always read the latest token from enterprise.json (dynamic, not cached at startup)
  // This ensures we pick up new tokens after /auth without restarting the MCP server
  const currentLicenseKey = getConfiguredLicenseKey()

  // Check if the token has changed since last cached
  // If so, invalidate the cache to force using the new token
  if (cachedJwtToken && currentLicenseKey && cachedJwtToken !== currentLicenseKey) {
    mcpDebug("[Enterprise Proxy] Token in enterprise.json has changed, invalidating cache")
    cachedJwtToken = null
    jwtTokenExpiry = 0
  }

  // Return cached token if still valid (with 5 minute buffer)
  const now = Date.now()
  if (cachedJwtToken && jwtTokenExpiry > now + 5 * 60 * 1000) {
    mcpDebug("[Enterprise Proxy] Using cached JWT token", {
      expiresIn: Math.floor((jwtTokenExpiry - now) / 1000 / 60) + " minutes",
    })
    return cachedJwtToken
  }

  if (!currentLicenseKey) {
    throw new Error("SNOW_LICENSE_KEY or SNOW_ENTERPRISE_LICENSE_KEY not configured. Run: serac auth login")
  }

  // Check if the license key is already a JWT token (from device auth)
  // Device auth flow sets the token directly in enterprise.json
  if (isJwtToken(currentLicenseKey)) {
    mcpDebug("[Enterprise Proxy] Using JWT token directly from enterprise.json (device auth mode)", {
      tokenLength: currentLicenseKey.length,
      tokenPreview: currentLicenseKey.substring(0, 20) + "...",
    })

    // Cache the JWT token
    // Note: We don't know the exact expiry from the token without decoding it,
    // but device auth tokens are valid for 7 days. We'll use a shorter cache
    // to ensure we don't use an expired token.
    cachedJwtToken = currentLicenseKey
    jwtTokenExpiry = now + 6 * 24 * 60 * 60 * 1000 // 6 days cache (1 day buffer)

    return currentLicenseKey
  }

  // License key is a raw license key (SNOW-ENT-* format)
  // Exchange it for a JWT token via the portal API
  mcpDebug("[Enterprise Proxy] Exchanging license key for JWT token", {
    licenseKeyLength: currentLicenseKey.length,
    licenseKeyPreview: currentLicenseKey.substring(0, 20) + "...",
    portalUrl: PORTAL_URL,
    enterpriseUrl: ENTERPRISE_URL,
  })

  try {
    const response = await axios.post(
      `${PORTAL_URL}/api/auth/mcp/login`,
      {
        licenseKey: currentLicenseKey,
        machineId: INSTANCE_ID,
        role: "developer", // Default role for MCP connections
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Instance-ID": INSTANCE_ID,
          "X-Serac-Version": VERSION,
        },
        timeout: 10000,
      },
    )

    if (!response.data.success || !response.data.token) {
      throw new Error("Failed to obtain JWT token from enterprise server")
    }

    const jwtToken = response.data.token

    // Cache the JWT token (expires in 7 days according to backend, but we'll refresh earlier)
    cachedJwtToken = jwtToken
    jwtTokenExpiry = now + 7 * 24 * 60 * 60 * 1000 // 7 days

    mcpDebug("[Enterprise Proxy] Successfully obtained JWT token", {
      tokenLength: jwtToken.length,
      customer: response.data.customer?.name,
      role: response.data.customer?.role,
    })

    return jwtToken
  } catch (error) {
    cachedJwtToken = null
    jwtTokenExpiry = 0

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError
      mcpDebug("[Enterprise Proxy] Failed to obtain JWT token", {
        status: axiosError.response?.status,
        statusText: axiosError.response?.statusText,
        responseData: axiosError.response?.data,
        code: axiosError.code,
        message: axiosError.message,
      })

      if (axiosError.response?.status === 401) {
        throw new Error("License key invalid or expired.\n\n" + "Fix this by running: serac auth login")
      }

      if (axiosError.response?.status === 429) {
        const responseData = axiosError.response?.data as any
        throw new Error(
          `Seat limit reached: ${responseData.message || "All seats are currently in use"}\n\n` +
            "Please wait for an available seat or contact support to purchase additional seats.",
        )
      }

      if (axiosError.code === "ECONNREFUSED") {
        throw new Error(`Cannot connect to enterprise server at ${ENTERPRISE_URL}`)
      }
    }

    throw new Error(`Failed to obtain JWT token: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * List available enterprise tools from license server
 * @returns Array of enterprise tools
 */
export async function listEnterpriseTools(): Promise<EnterpriseTool[]> {
  const licenseKey = getConfiguredLicenseKey()
  if (!licenseKey) {
    mcpDebug("[Enterprise Proxy] SNOW_LICENSE_KEY not configured")
    throw new Error("SNOW_LICENSE_KEY or SNOW_ENTERPRISE_LICENSE_KEY not configured. Run: serac auth login")
  }

  try {
    // Get JWT token (cached or fetch new one)
    const jwtToken = await getJwtToken()

    // Log request info for debugging
    mcpDebug("[Enterprise Proxy] Fetching enterprise tools", {
      jwtTokenLength: jwtToken.length,
      enterpriseUrl: ENTERPRISE_URL,
      instanceId: INSTANCE_ID.substring(0, 16) + "...",
      version: VERSION,
    })

    mcpDebug("[Enterprise Proxy] Sending request to enterprise server", {
      url: `${ENTERPRISE_URL}/mcp/tools/list`,
      authHeaderLength: `Bearer ${jwtToken}`.length,
    })

    const response = await axios.get<EnterpriseToolListResponse>(`${ENTERPRISE_URL}/mcp/tools/list`, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        "X-Instance-ID": INSTANCE_ID,
        "X-Serac-Version": VERSION,
      },
      timeout: 10000, // 10 seconds for listing
    })

    mcpDebug(`[Enterprise Proxy] Successfully fetched ${response.data.tools?.length || 0} enterprise tools`)
    return response.data.tools || []
  } catch (error) {
    // If JWT token exchange failed, the error is already logged and thrown
    if (error instanceof Error && error.message.includes("JWT token")) {
      throw error
    }

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError

      // Log detailed error info
      mcpDebug("[Enterprise Proxy] Enterprise tools list request failed", {
        status: axiosError.response?.status,
        statusText: axiosError.response?.statusText,
        responseData: axiosError.response?.data,
        code: axiosError.code,
        message: axiosError.message,
      })

      if (axiosError.response?.status === 401) {
        // Clear cached JWT token on 401
        cachedJwtToken = null
        jwtTokenExpiry = 0

        // Check if the error is due to JWT malformation (common after KMS secret updates)
        const responseData = axiosError.response?.data as any
        if (responseData?.error && responseData.error.toLowerCase().includes("jwt")) {
          mcpDebug("[Enterprise Proxy] JWT token rejected by server - clearing cache", {
            serverError: responseData.error,
          })
          throw new Error(
            "JWT token is invalid or expired.\n\n" +
              "🔧 This usually happens after server configuration updates (e.g., KMS secrets).\n\n" +
              "Fix this by running: serac auth login\n\n" +
              "The JWT will be regenerated with the latest server configuration.",
          )
        }
        throw new Error("License key invalid or expired. Run: serac auth login")
      }
      if (axiosError.response?.status === 403) {
        throw new Error("Access denied. Please check your enterprise license.")
      }
      if (axiosError.code === "ECONNREFUSED") {
        throw new Error(`Cannot connect to enterprise server at ${ENTERPRISE_URL}`)
      }
    }

    mcpDebug("[Enterprise Proxy] Unexpected error listing tools", {
      error: error instanceof Error ? error.message : String(error),
    })

    throw new Error(`Failed to list enterprise tools: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Execute an enterprise tool via the license server
 * @param toolName - Name of the tool to execute
 * @param args - Arguments for the tool
 * @returns Tool execution result
 */
export async function proxyToolCall(toolName: string, args: Record<string, any>): Promise<any> {
  const licenseKey = getConfiguredLicenseKey()
  if (!licenseKey) {
    throw new Error("SNOW_LICENSE_KEY or SNOW_ENTERPRISE_LICENSE_KEY not configured. Run: serac auth login")
  }

  // Get JWT token (cached or fetch new one - reads dynamically from enterprise.json)
  const jwtToken = await getJwtToken()

  // Prepare request (credentials are fetched by enterprise server from Portal API)
  const request: EnterpriseToolCallRequest = {
    tool: toolName,
    arguments: args,
    // NOTE: Credentials no longer sent - enterprise server fetches from Portal API using JWT
  }

  try {
    const response = await axios.post<EnterpriseToolCallResponse>(`${ENTERPRISE_URL}/mcp/tools/call`, request, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        "Content-Type": "application/json",
        "X-Instance-ID": INSTANCE_ID,
        "X-Serac-Version": VERSION,
      },
      timeout: 120000, // 2 minutes for tool execution
    })

    if (!response.data.success) {
      throw new Error(response.data.error || "Tool execution failed")
    }

    return response.data.result
  } catch (error) {
    // If JWT token exchange failed, the error is already logged and thrown
    if (error instanceof Error && error.message.includes("JWT token")) {
      throw error
    }

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError

      // Handle specific HTTP errors
      if (axiosError.response?.status === 401) {
        // Clear cached JWT token on 401
        cachedJwtToken = null
        jwtTokenExpiry = 0

        throw new Error("License key invalid or expired. Run: serac auth login")
      }

      if (axiosError.response?.status === 403) {
        throw new Error("Access denied. Please check your enterprise license.")
      }

      if (axiosError.response?.status === 429) {
        const retryAfter = axiosError.response.headers["retry-after"] || "300"
        throw new Error(`Rate limit exceeded. Try again in ${retryAfter} seconds.`)
      }

      if (axiosError.response?.status === 404) {
        throw new Error(`Tool '${toolName}' not found in enterprise catalog.`)
      }

      if (axiosError.response?.data) {
        const errorData = axiosError.response.data as any
        if (errorData.error) {
          throw new Error(`Enterprise server error: ${errorData.error}`)
        }
      }

      if (axiosError.code === "ECONNREFUSED") {
        throw new Error(`Cannot connect to enterprise server at ${ENTERPRISE_URL}`)
      }

      if (axiosError.code === "ETIMEDOUT") {
        throw new Error("Request to enterprise server timed out. Tool execution may still be in progress.")
      }
    }

    throw new Error(`Tool execution failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Validate license key with enterprise server
 * @param licenseKey - License key to validate
 * @param role - User role (developer, stakeholder, admin)
 * @returns Validation response including JWT token
 */
export async function validateLicenseKey(
  licenseKey: string,
  role: string = "developer",
): Promise<{
  valid: boolean
  error?: string
  features?: string[]
  serverUrl?: string
  token?: string
  subdomain?: string
}> {
  try {
    // Use /api/auth/mcp/login to validate and get JWT token
    const response = await axios.post(
      `${PORTAL_URL}/api/auth/mcp/login`,
      {
        licenseKey: licenseKey.trim(),
        machineId: INSTANCE_ID,
        role: role,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Instance-ID": INSTANCE_ID,
          "X-Serac-Version": VERSION,
        },
        timeout: 10000,
      },
    )

    if (!response.data.success || !response.data.token) {
      return {
        valid: false,
        error: "Invalid license key - no token returned",
      }
    }

    // Return the JWT token so it can be saved to enterprise.json
    return {
      valid: true,
      features: ["jira", "azdo", "confluence"], // All features for enterprise
      serverUrl: ENTERPRISE_URL,
      token: response.data.token,
      subdomain: response.data.customer?.subdomain || response.data.subdomain,
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError
      if (axiosError.response?.status === 401) {
        return { valid: false, error: "Invalid license key" }
      }
      if (axiosError.response?.status === 403) {
        return { valid: false, error: "License key expired or inactive" }
      }
      if (axiosError.response?.status === 429) {
        return { valid: false, error: "Seat limit reached" }
      }
      const errorData = axiosError.response?.data as any
      if (errorData?.error) {
        return { valid: false, error: errorData.error }
      }
    }
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Validation failed",
    }
  }
}
