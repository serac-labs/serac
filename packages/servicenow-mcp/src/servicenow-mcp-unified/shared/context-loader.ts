/**
 * ServiceNow credential loading from local files and the enterprise portal.
 *
 * Transport-agnostic: these functions are used by the stdio transport at
 * startup (free users via env vars or local auth.json, enterprise users via
 * runtime fetch from the portal). The HTTP transport resolves credentials
 * per-request from the portal DB and does not use these loaders.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import https from "https"
import http from "http"

import { type ServiceNowContext } from "./types.js"
import { mcpDebug } from "../../shared/mcp-debug.js"

/**
 * Load ServiceNow credentials from auth.json files.
 * Checks multiple possible locations in priority order.
 * Returns undefined if no valid credentials found.
 */
export const loadFromAuthJson = (): ServiceNowContext | undefined => {
  // Possible auth.json locations in priority order
  // NOTE: snow-code uses xdg-basedir which returns different paths per platform:
  // - macOS: ~/Library/Application Support/
  // - Linux: ~/.local/share/
  // - Windows: %APPDATA%
  const authPaths = [
    // 1. macOS: ~/Library/Application Support/snow-code/auth.json (XDG data dir on macOS)
    ...(process.platform === "darwin"
      ? [path.join(os.homedir(), "Library", "Application Support", "snow-code", "auth.json")]
      : []),
    // 2. Windows: %APPDATA%/snow-code/auth.json
    ...(process.platform === "win32" && process.env.APPDATA
      ? [path.join(process.env.APPDATA, "snow-code", "auth.json")]
      : []),
    // 3. Linux/fallback: ~/.local/share/snow-code/auth.json (XDG data dir on Linux)
    path.join(os.homedir(), ".local", "share", "snow-code", "auth.json"),
    // 4. Serac specific auth (~/.serac, falling back to legacy ~/.snow-flow)
    path.join(os.homedir(), ".serac", "auth.json"),
    path.join(os.homedir(), ".snow-flow", "auth.json"),
    // 5. OpenCode (fallback for compatibility)
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
  ]

  for (const authPath of authPaths) {
    try {
      if (!fs.existsSync(authPath)) {
        continue
      }

      const authData = JSON.parse(fs.readFileSync(authPath, "utf-8"))

      // Check for servicenow credentials in auth.json structure
      let servicenowCreds = authData["servicenow"]

      // If not found, check if the root IS the servicenow config (for ~/.snow-flow/auth.json)
      if (!servicenowCreds && authData.instance && (authData.clientId || authData.username)) {
        servicenowCreds = authData
      }

      if (!servicenowCreds) {
        continue
      }

      // Validate credentials are not placeholders
      const isPlaceholder = (val?: string) => !val || val.includes("your-") || val.includes("placeholder")

      const instance = servicenowCreds.instance
      const authType = servicenowCreds.type // 'servicenow-oauth' or 'servicenow-basic'

      // Support both OAuth and Basic auth
      const clientId = servicenowCreds.clientId
      const clientSecret = servicenowCreds.clientSecret
      const username = servicenowCreds.username
      const password = servicenowCreds.password

      // Validate instance
      if (isPlaceholder(instance)) {
        continue
      }

      // Check for valid OAuth credentials
      const hasValidOAuth = clientId && clientSecret && !isPlaceholder(clientId) && !isPlaceholder(clientSecret)

      // Check for valid Basic auth credentials
      const hasValidBasic = username && password && !isPlaceholder(username) && !isPlaceholder(password)

      // Need either valid OAuth OR valid Basic auth
      if (!hasValidOAuth && !hasValidBasic) {
        continue
      }

      const effectiveAuthType = hasValidOAuth ? "OAuth" : "Basic"
      // Parse token expiry (from auth.json expiresAt field)
      let tokenExpiry: number | undefined
      if (servicenowCreds.expiresAt) {
        tokenExpiry =
          typeof servicenowCreds.expiresAt === "number"
            ? servicenowCreds.expiresAt
            : parseInt(servicenowCreds.expiresAt, 10)
      }

      mcpDebug("[Auth] ✅ Loaded credentials from:", authPath)
      mcpDebug("[Auth]    Instance:", instance)
      mcpDebug("[Auth]    Auth Type:", effectiveAuthType)
      if (hasValidOAuth) {
        mcpDebug("[Auth]    Client ID:", clientId ? "***" + clientId.slice(-4) : "MISSING")
        mcpDebug("[Auth]    Has Refresh Token:", !!servicenowCreds.refreshToken)
        mcpDebug("[Auth]    Has Access Token:", !!servicenowCreds.accessToken)
        if (tokenExpiry) {
          const expiresIn = Math.round((tokenExpiry - Date.now()) / 1000 / 60)
          mcpDebug("[Auth]    Token Expires In:", expiresIn > 0 ? `${expiresIn} minutes` : "EXPIRED")
        }
      } else {
        mcpDebug("[Auth]    Username:", username)
      }

      return {
        instanceUrl: instance.startsWith("http") ? instance : `https://${instance}`,
        clientId: hasValidOAuth ? clientId : "",
        clientSecret: hasValidOAuth ? clientSecret : "",
        accessToken: servicenowCreds.accessToken,
        refreshToken: servicenowCreds.refreshToken || servicenowCreds.refresh_token,
        tokenExpiry: tokenExpiry, // Pass token expiry so auth manager knows when to refresh
        username: hasValidBasic ? username : undefined,
        password: hasValidBasic ? password : undefined,
      }
    } catch (error: any) {
      mcpDebug("[Auth] Failed to load from", authPath, ":", error.message)
      continue
    }
  }

  // No valid auth.json found
  mcpDebug("[Auth] No valid auth.json found in any location")
  mcpDebug("[Auth] Checked paths:")
  authPaths.forEach((p) => mcpDebug("[Auth]   -", p))
  return undefined
}

/**
 * Load enterprise auth data (JWT + portal URL) from ~/.snow-code/enterprise.json
 * or ~/.snow-flow/auth.json.
 */
export const loadEnterpriseAuth = (): { jwt: string; portalUrl: string; subdomain?: string } | undefined => {
  // Check for enterprise auth from device authorization flow
  const enterpriseAuthPaths = [
    // 1. Snow-Code enterprise config (from device auth flow)
    path.join(os.homedir(), ".snow-code", "enterprise.json"),
    // 2. Serac enterprise auth (~/.serac, falling back to legacy ~/.snow-flow)
    path.join(os.homedir(), ".serac", "auth.json"),
    path.join(os.homedir(), ".snow-flow", "auth.json"),
  ]

  for (const authPath of enterpriseAuthPaths) {
    try {
      if (!fs.existsSync(authPath)) {
        continue
      }

      const authData = JSON.parse(fs.readFileSync(authPath, "utf-8"))

      // Check for JWT token in different possible structures
      let jwt: string | undefined
      let subdomain: string | undefined

      // Structure 1: { token: "jwt...", subdomain: "acme" } (snow-code device auth)
      if (authData.token) {
        jwt = authData.token
        subdomain = authData.subdomain
      }
      // Structure 2: { jwt: "jwt...", customer: { ... } } (snow-flow enterprise auth)
      else if (authData.jwt) {
        jwt = authData.jwt
      }

      if (!jwt) {
        continue
      }

      // Check if token is expired (basic check - full validation happens on portal)
      try {
        const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString())
        if (payload.exp && payload.exp * 1000 < Date.now()) {
          mcpDebug("[Auth] Enterprise JWT expired, skipping enterprise portal fetch")
          continue
        }
      } catch {
        // Can't parse JWT, skip
        continue
      }

      // Determine portal URL based on subdomain
      let portalUrl = "https://portal.serac.build"
      if (subdomain && subdomain !== "portal") {
        portalUrl = `https://${subdomain}.serac.build`
      }

      mcpDebug("[Auth] Found enterprise auth from:", authPath)
      mcpDebug("[Auth]   Portal URL:", portalUrl)
      return { jwt, portalUrl, subdomain }
    } catch (error: any) {
      mcpDebug("[Auth] Failed to load enterprise auth from", authPath, ":", error.message)
      continue
    }
  }

  return undefined
}

/**
 * Make HTTPS request to the enterprise portal.
 */
export const fetchFromPortal = (url: string, jwt: string): Promise<any> => {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const isHttps = parsedUrl.protocol === "https:"
    const httpModule = isHttps ? https : http

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
        "User-Agent": "Serac-MCP/1.0",
      },
    }

    const req = httpModule.request(options, (res) => {
      let data = ""
      res.on("data", (chunk) => {
        data += chunk
      })
      res.on("end", () => {
        try {
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error("Unauthorized - enterprise JWT may be expired"))
            return
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Portal returned status ${res.statusCode}: ${data}`))
            return
          }
          const parsed = JSON.parse(data)
          resolve(parsed)
        } catch (e: any) {
          reject(new Error(`Failed to parse portal response: ${e.message}`))
        }
      })
    })

    req.on("error", (e) => {
      reject(new Error(`Portal request failed: ${e.message}`))
    })

    req.setTimeout(10000, () => {
      req.destroy()
      reject(new Error("Portal request timed out"))
    })

    req.end()
  })
}

/**
 * Fetch ServiceNow credentials from the enterprise portal (runtime, no local secrets!).
 *
 * SECURITY: This is the preferred method for enterprise users.
 * ServiceNow credentials are fetched at runtime using the enterprise JWT,
 * so no client secrets are stored locally on the developer's machine.
 */
export const loadFromEnterprisePortal = async (): Promise<ServiceNowContext | undefined> => {
  const enterpriseAuth = loadEnterpriseAuth()
  if (!enterpriseAuth) {
    return undefined
  }

  mcpDebug("[Auth] 🔐 Fetching ServiceNow credentials from enterprise portal (secure mode)...")

  try {
    // Call the portal API to get ServiceNow credentials
    const response = await fetchFromPortal(
      `${enterpriseAuth.portalUrl}/api/user-credentials/servicenow/default`,
      enterpriseAuth.jwt,
    )

    if (!response.success || !response.instance) {
      mcpDebug("[Auth] Enterprise portal returned no ServiceNow instance")
      mcpDebug("[Auth] Response:", JSON.stringify(response))
      return undefined
    }

    const instance = response.instance

    // Validate required fields
    if (!instance.instanceUrl || !instance.clientId || !instance.clientSecret) {
      mcpDebug("[Auth] Enterprise portal returned incomplete credentials")
      return undefined
    }

    mcpDebug("[Auth] ✅ Fetched ServiceNow credentials from enterprise portal")
    mcpDebug("[Auth]    Instance:", instance.instanceUrl)
    mcpDebug("[Auth]    Client ID:", instance.clientId ? "***" + instance.clientId.slice(-4) : "MISSING")
    mcpDebug("[Auth]    Environment:", instance.environmentType || "unknown")

    return {
      instanceUrl: instance.instanceUrl,
      clientId: instance.clientId,
      clientSecret: instance.clientSecret,
      refreshToken: undefined, // Enterprise uses M2M OAuth, no refresh token needed
      username: undefined,
      password: undefined,
      enterprise: {
        tier: "enterprise",
        company: enterpriseAuth.subdomain,
        features: ["secure-credentials", "runtime-fetch"],
      },
    }
  } catch (error: any) {
    mcpDebug("[Auth] Failed to fetch credentials from enterprise portal:", error.message)
    return undefined
  }
}

/**
 * Load ServiceNow context from environment variables OR auth.json fallback.
 * Note: Server will start even without credentials (unauthenticated mode).
 *
 * Priority (for synchronous loading):
 * 1. Environment variables (SERVICENOW_* or SNOW_*)
 * 2. snow-code auth.json (platform-specific XDG path + fallbacks)
 * 3. Unauthenticated mode (empty credentials)
 *
 * Note: Enterprise portal fetch (highest priority) is async — callers run it
 * in `initialize()` after the sync bootstrap succeeds.
 */
export const loadContext = (): ServiceNowContext => {
  // STEP 1: Try environment variables first
  // Handle SNOW_INSTANCE with or without https:// prefix to avoid double-prefix issue
  const snowInstance = process.env.SNOW_INSTANCE
  const normalizedSnowInstance = snowInstance
    ? snowInstance.startsWith("http://") || snowInstance.startsWith("https://")
      ? snowInstance
      : `https://${snowInstance}`
    : undefined
  const instanceUrl = process.env.SERVICENOW_INSTANCE_URL || normalizedSnowInstance
  const clientId = process.env.SERVICENOW_CLIENT_ID || process.env.SNOW_CLIENT_ID
  const clientSecret = process.env.SERVICENOW_CLIENT_SECRET || process.env.SNOW_CLIENT_SECRET
  const refreshToken = process.env.SERVICENOW_REFRESH_TOKEN || process.env.SNOW_REFRESH_TOKEN
  const username = process.env.SERVICENOW_USERNAME || process.env.SNOW_USERNAME
  const password = process.env.SERVICENOW_PASSWORD || process.env.SNOW_PASSWORD

  // Helper: Convert empty strings to undefined (treat empty as missing)
  const normalizeCredential = (val?: string) => (val && val.trim() !== "" ? val : undefined)

  // Check for placeholder values
  const isPlaceholder = (val?: string) => !val || val.includes("your-") || val.includes("placeholder")

  // Check if env vars are valid
  const hasValidEnvVars =
    instanceUrl &&
    clientId &&
    clientSecret &&
    !isPlaceholder(instanceUrl) &&
    !isPlaceholder(clientId) &&
    !isPlaceholder(clientSecret)

  if (hasValidEnvVars) {
    mcpDebug("[Auth] Using credentials from environment variables")
    return {
      instanceUrl: instanceUrl!,
      clientId: clientId!,
      clientSecret: clientSecret!,
      refreshToken: normalizeCredential(refreshToken),
      username: normalizeCredential(username),
      password: normalizeCredential(password),
    }
  }

  // STEP 2: Try snow-code auth.json fallback (free users / local credentials)
  const authJsonContext = loadFromAuthJson()
  if (authJsonContext) {
    return authJsonContext
  }

  // STEP 3: No valid credentials found - start in unauthenticated mode
  // Note: Enterprise users will get credentials from portal in initialize()
  mcpDebug("[Auth] No local ServiceNow credentials found")
  mcpDebug("[Auth] Checked:")
  mcpDebug("[Auth]   1. Environment variables (SERVICENOW_* or SNOW_*)")
  mcpDebug("[Auth]   2. snow-code auth.json (see logged paths above)")
  mcpDebug("[Auth] Will attempt enterprise portal fetch in initialize()...")

  // Return empty context - may be updated in initialize() if enterprise auth exists
  return {
    instanceUrl: "",
    clientId: "",
    clientSecret: "",
    refreshToken: undefined,
    username: undefined,
    password: undefined,
  }
}

/**
 * Check if a context has valid credentials (OAuth or Basic auth).
 */
export const hasValidCredentials = (context: ServiceNowContext): boolean => {
  // Must have instance URL
  if (!context.instanceUrl) {
    return false
  }

  // Check for valid OAuth credentials
  const hasOAuth = !!(context.clientId && context.clientSecret)

  // Check for valid Basic auth credentials
  const hasBasic = !!(context.username && context.password)

  return hasOAuth || hasBasic
}
