/**
 * ServiceNow OAuth Authentication for SnowCode
 * Handles OAuth2 flow for ServiceNow integration
 */

import crypto from "crypto"
import * as prompts from "@clack/prompts"
import { Auth } from "./index"

/**
 * OAuth HTML Templates with Serac minimalist branding
 */
const baseStyles = `
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #1E2531;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #FFFFFF;
    }

    .container {
      max-width: 600px;
      width: 100%;
      text-align: center;
    }

    .logo {
      margin-bottom: 3rem;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 1rem;
    }

    .logo-svg {
      width: 150px;
      height: auto;
    }

    .logo-text {
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -0.02em;
    }

    .snow {
      color: #FFFFFF;
    }

    .flow {
      color: #00D9FF;
    }

    .status-icon {
      font-size: 4rem;
      margin-bottom: 2rem;
      display: block;
    }

    h1 {
      font-size: 3rem;
      font-weight: 800;
      line-height: 1.2;
      margin-bottom: 1.5rem;
      letter-spacing: -0.02em;
    }

    .success-text {
      color: #00D9FF;
    }

    .error-text {
      color: #f5222d;
    }

    p {
      font-size: 1.25rem;
      color: #94A3B8;
      line-height: 1.6;
      margin-bottom: 1rem;
    }

    .instruction {
      font-size: 1.125rem;
      color: #FFFFFF;
      margin-top: 2rem;
      padding: 1.5rem;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .error-details {
      margin-top: 2rem;
      padding: 1.5rem;
      background: rgba(245, 34, 45, 0.1);
      border-radius: 12px;
      border: 1px solid rgba(245, 34, 45, 0.3);
      font-family: 'Courier New', monospace;
      font-size: 0.875rem;
      color: #f5222d;
      word-break: break-word;
    }

    .footer {
      margin-top: 3rem;
      font-size: 0.875rem;
      color: #64748B;
    }

    @media (max-width: 768px) {
      h1 {
        font-size: 2rem;
      }

      .status-icon {
        font-size: 3rem;
      }

      .logo-text {
        font-size: 1.5rem;
      }
    }
  </style>
`

const logoSVG = `
  <svg class="logo-svg" viewBox="0 0 100 70" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <!-- Mountain gradient (white to cyan) -->
      <linearGradient id="mountain-v" x1="50" y1="8" x2="50" y2="28" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FFFFFF"/>
        <stop offset="100%" stop-color="#00D9FF"/>
      </linearGradient>
    </defs>

    <!-- Icon centered and scaled up -->
    <g transform="translate(26, 2)">
      <!-- Mountain peaks (geometric, clear) - scaled up and better centered -->
      <path d="M6 26 L15 6 L24 16 L33 6 L42 26 Z"
            fill="url(#mountain-v)"
            stroke="#00D9FF"
            stroke-width="1.5"
            stroke-linejoin="round"/>
    </g>

    <!-- Text SNOW centered -->
    <text x="50" y="50" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="800" fill="#FFFFFF" letter-spacing="-0.02em">SNOW</text>

    <!-- Text FLOW centered -->
    <text x="50" y="66" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="800" fill="#00D9FF" letter-spacing="-0.02em">FLOW</text>
  </svg>
`

const OAuthTemplates = {
  success: `
    <html>
      <head>
        <title>Serac - Authentication Successful</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        ${baseStyles}
      </head>
      <body>
        <div class="container">
          <div class="logo">
            ${logoSVG}
          </div>

          <span class="status-icon">✓</span>

          <h1 class="success-text">
            Connected!
          </h1>

          <p>
            Your ServiceNow instance is now connected to Serac.
          </p>

          <div class="instruction">
            You can close this window and return to your terminal.
          </div>

          <div class="footer">
            Serac: ServiceNow Multi-Agent Development Framework
          </div>
        </div>
      </body>
    </html>
  `,

  error: (error: string) => `
    <html>
      <head>
        <title>Serac - Authentication Error</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        ${baseStyles}
      </head>
      <body>
        <div class="container">
          <div class="logo">
            ${logoSVG}
          </div>

          <span class="status-icon error-text">✕</span>

          <h1 class="error-text">
            Authentication Failed
          </h1>

          <p>
            We couldn't complete the authentication process.
          </p>

          <div class="error-details">
            ${escapeHtml(error)}
          </div>

          <div class="instruction">
            Please close this window and try again.
          </div>

          <div class="footer">
            Need help? Check the Serac documentation.
          </div>
        </div>
      </body>
    </html>
  `,

  securityError: `
    <html>
      <head>
        <title>Serac - Security Error</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        ${baseStyles}
      </head>
      <body>
        <div class="container">
          <div class="logo">
            ${logoSVG}
          </div>

          <span class="status-icon error-text">⚠</span>

          <h1 class="error-text">
            Security Error
          </h1>

          <p>
            Invalid state parameter detected - possible CSRF attack.
          </p>

          <div class="instruction">
            Please close this window and start the authentication process again.
          </div>

          <div class="footer">
            Your security is our priority.
          </div>
        </div>
      </body>
    </html>
  `,

  missingCode: `
    <html>
      <head>
        <title>Serac - Missing Authorization Code</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        ${baseStyles}
      </head>
      <body>
        <div class="container">
          <div class="logo">
            ${logoSVG}
          </div>

          <span class="status-icon error-text">✕</span>

          <h1 class="error-text">
            Missing Authorization
          </h1>

          <p>
            No authorization code was received from ServiceNow.
          </p>

          <div class="instruction">
            Make sure you approve the authorization request in ServiceNow, then try again.
          </div>

          <div class="footer">
            Serac: ServiceNow Multi-Agent Development Framework
          </div>
        </div>
      </body>
    </html>
  `,

  tokenExchangeFailed: (error: string) => `
    <html>
      <head>
        <title>Serac - Token Exchange Failed</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        ${baseStyles}
      </head>
      <body>
        <div class="container">
          <div class="logo">
            ${logoSVG}
          </div>

          <span class="status-icon error-text">✕</span>

          <h1 class="error-text">
            Token Exchange Failed
          </h1>

          <p>
            Unable to exchange authorization code for access token.
          </p>

          <div class="error-details">
            ${escapeHtml(error)}
          </div>

          <div class="instruction">
            Please verify your OAuth configuration (Client ID and Client Secret) and try again.
          </div>

          <div class="footer">
            Serac: ServiceNow Multi-Agent Development Framework
          </div>
        </div>
      </body>
    </html>
  `,
}

/**
 * Escape HTML special characters to prevent XSS in error templates
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

export interface ServiceNowAuthResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
}

export interface ServiceNowOAuthOptions {
  instance: string
  clientId: string
  clientSecret: string
}

/**
 * Detect if running in a remote/headless environment where a browser cannot be opened.
 * Checks for: GitHub Codespaces, SSH sessions, Docker/containers, Gitpod,
 * VS Code Remote, WSL, and Linux without DISPLAY.
 */
export function isRemoteEnvironment(): boolean {
  // GitHub Codespaces
  if (process.env.CODESPACES === "true" || !!process.env.CODESPACE_NAME) {
    return true
  }

  // SSH session
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY) {
    return true
  }

  // Gitpod
  if (process.env.GITPOD_WORKSPACE_ID) {
    return true
  }

  // VS Code Remote Containers
  if (process.env.VSCODE_REMOTE_CONTAINERS_SESSION) {
    return true
  }

  // WSL
  if (process.env.WSL_DISTRO_NAME) {
    return true
  }

  // Docker / container: check /.dockerenv
  try {
    const fs = require("fs")
    if (fs.existsSync("/.dockerenv")) {
      return true
    }
  } catch {
    // Ignore filesystem errors
  }

  // Linux without DISPLAY (no graphical environment)
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return true
  }

  return false
}

/**
 * Timing-safe string comparison to prevent timing attacks on security tokens.
 * Returns true if both strings are equal, using constant-time comparison.
 */
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  return crypto.timingSafeEqual(bufA, bufB)
}

export class ServiceNowOAuth {
  private stateParameter?: string
  private codeVerifier?: string
  private codeChallenge?: string

  // Rate limiting
  private lastTokenRequest: number = 0
  private tokenRequestCount: number = 0
  private readonly TOKEN_REQUEST_WINDOW_MS = 60000 // 1 minute
  private readonly MAX_TOKEN_REQUESTS_PER_WINDOW = 10

  /**
   * Check rate limiting for token requests
   */
  private checkTokenRequestRateLimit(): boolean {
    const now = Date.now()

    if (now - this.lastTokenRequest > this.TOKEN_REQUEST_WINDOW_MS) {
      this.tokenRequestCount = 0
      this.lastTokenRequest = now
    }

    if (this.tokenRequestCount >= this.MAX_TOKEN_REQUESTS_PER_WINDOW) {
      prompts.log.warn("Rate limit exceeded: Too many token requests. Please wait before retrying.")
      return false
    }

    this.tokenRequestCount++
    return true
  }

  /**
   * Generate a random state parameter for CSRF protection
   */
  private generateState(): string {
    return crypto.randomBytes(16).toString("base64url")
  }

  /**
   * Generate PKCE code verifier and challenge
   */
  private generatePKCE() {
    this.codeVerifier = crypto.randomBytes(32).toString("base64url")
    const hash = crypto.createHash("sha256")
    hash.update(this.codeVerifier)
    this.codeChallenge = hash.digest("base64url")
  }

  /**
   * Normalize instance URL
   */
  private normalizeInstanceUrl(instance: string): string {
    let normalized = instance.replace(/\/+$/, "")

    if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
      normalized = `https://${normalized}`
    }

    // SECURITY: Use URL parsing to validate hostname instead of string includes
    try {
      const parsed = new URL(normalized)
      const hostname = parsed.hostname.toLowerCase()

      // SECURITY: Enforce HTTPS for non-local instances to prevent token leakage
      const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname.startsWith("192.168.")
      if (parsed.protocol === "http:" && !isLocal) {
        normalized = normalized.replace(/^http:/, "https:")
      }

      // Check if it's already a valid ServiceNow or local URL
      const isServiceNow = hostname.endsWith(".service-now.com") || hostname.endsWith(".servicenow.com")

      if (!isServiceNow && !isLocal) {
        // Assume it's just the instance name, append .service-now.com
        normalized = `https://${hostname}.service-now.com`
      }
    } catch {
      // If URL parsing fails, treat input as instance name
      const instanceName = normalized.replace(/^https?:\/\//, "")
      normalized = `https://${instanceName}.service-now.com`
    }

    return normalized
  }

  /**
   * Validate client secret format
   */
  private validateClientSecret(secret: string): { valid: boolean; reason?: string } {
    if (!secret || secret.trim() === "") {
      return { valid: false, reason: "Client secret is required" }
    }

    if (secret.length < 32) {
      return {
        valid: false,
        reason: "Client secret is too short (should be 32+ characters)",
      }
    }

    const commonPasswords = ["password", "admin", "secret", "client", "snow"]
    const lowerSecret = secret.toLowerCase()
    for (const common of commonPasswords) {
      if (lowerSecret.includes(common)) {
        return {
          valid: false,
          reason: `Client secret appears to be a common password - it should be a random string from ServiceNow`,
        }
      }
    }

    return { valid: true }
  }

  /**
   * Generate authorization URL
   */
  private generateAuthUrl(instance: string, clientId: string): string {
    const baseUrl = instance.startsWith("http") ? instance : `https://${instance}`

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
      state: this.stateParameter!,
      code_challenge: this.codeChallenge!,
      code_challenge_method: "S256",
    })

    return `${baseUrl}/oauth_auth.do?${params.toString()}`
  }

  /**
   * Exchange authorization code for tokens
   */
  private async exchangeCodeForTokens(
    instance: string,
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri?: string,
  ): Promise<ServiceNowAuthResult> {
    if (!this.checkTokenRequestRateLimit()) {
      return {
        success: false,
        error: "Rate limit exceeded. Please wait before retrying.",
      }
    }

    const baseUrl = instance.startsWith("http") ? instance : `https://${instance}`
    const tokenUrl = `${baseUrl}/oauth_token.do`

    // redirect_uri MUST match the one used in authorization request
    const finalRedirectUri = redirectUri || "http://localhost:3005/callback"

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: finalRedirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: this.codeVerifier!,
    })

    try {
      const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      })

      if (!response.ok) {
        const errorText = await response.text()
        return {
          success: false,
          error: `Token exchange failed: ${response.status} ${errorText}`,
        }
      }

      const data = await response.json()

      if (data.error) {
        // SECURITY: Clear PKCE and state parameters after use to minimize exposure window
        this.clearAuthState()
        return {
          success: false,
          error: `OAuth error: ${data.error} - ${data.error_description || ""}`,
        }
      }

      // SECURITY: Clear PKCE and state parameters after successful exchange
      this.clearAuthState()
      return {
        success: true,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
      }
    } catch (error) {
      this.clearAuthState()
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Clear sensitive auth state (PKCE verifier, code challenge, state parameter)
   * after they have been used in a token exchange to minimize exposure window.
   */
  private clearAuthState(): void {
    this.stateParameter = undefined
    this.codeVerifier = undefined
    this.codeChallenge = undefined
  }

  /**
   * Detect if running in GitHub Codespaces
   */
  private isCodespace(): boolean {
    // Check multiple Codespace indicators
    const hasCodespacesEnv = process.env.CODESPACES === "true"
    const hasCodespaceName = !!process.env.CODESPACE_NAME
    const hasForwardingDomain = !!process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN

    // Debug logging
    if (hasCodespacesEnv || hasCodespaceName || hasForwardingDomain) {
      prompts.log.info(`🔍 Codespace detection:`)
      prompts.log.message(`   CODESPACES=${process.env.CODESPACES}`)
      prompts.log.message(`   CODESPACE_NAME=${process.env.CODESPACE_NAME}`)
      prompts.log.message(
        `   GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN=${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`,
      )
    }

    return hasCodespacesEnv || (hasCodespaceName && hasForwardingDomain)
  }

  /**
   * Get Codespace forwarded URL for port 3005
   */
  private getCodespaceForwardedUrl(): string | null {
    const codespaceName = process.env.CODESPACE_NAME
    const forwardingDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN

    if (!codespaceName || !forwardingDomain) {
      return null
    }

    return `https://${codespaceName}-3005.${forwardingDomain}/callback`
  }

  /**
   * Prepare a headless OAuth flow: generates PKCE, state, and returns the auth URL.
   * The caller must show this URL to the user, then call exchangeCallbackUrl() with
   * the callback URL that ServiceNow redirects to.
   */
  prepareHeadlessAuth(options: ServiceNowOAuthOptions): {
    authUrl: string
    redirectUri: string
    normalizedInstance: string
    error?: string
  } {
    const normalizedInstance = this.normalizeInstanceUrl(options.instance)

    const secretValidation = this.validateClientSecret(options.clientSecret)
    if (!secretValidation.valid) {
      return {
        authUrl: "",
        redirectUri: "",
        normalizedInstance,
        error: secretValidation.reason,
      }
    }

    this.stateParameter = this.generateState()
    this.generatePKCE()

    const redirectUri = "http://localhost:3005/callback"
    const authUrl = this.generateAuthUrlWithCallback(normalizedInstance, options.clientId, redirectUri)

    return { authUrl, redirectUri, normalizedInstance }
  }

  /**
   * Exchange a callback URL (pasted by the user) for tokens.
   * Used in headless environments where the localhost callback server can't receive the redirect.
   */
  async exchangeCallbackUrl(
    callbackUrl: string,
    instance: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ): Promise<ServiceNowAuthResult> {
    try {
      const { URL } = require("url")
      const parsedUrl = new URL(callbackUrl.trim())

      const code = parsedUrl.searchParams.get("code")
      const error = parsedUrl.searchParams.get("error")
      const state = parsedUrl.searchParams.get("state")

      if (!state || !this.stateParameter || !timingSafeCompare(state, this.stateParameter)) {
        return { success: false, error: "Invalid state parameter - possible CSRF attack" }
      }

      if (error) {
        return { success: false, error: `OAuth error: ${error}` }
      }

      if (!code) {
        return { success: false, error: "No authorization code found in callback URL" }
      }

      const tokenResult = await this.exchangeCodeForTokens(instance, clientId, clientSecret, code, redirectUri)

      if (tokenResult.success && tokenResult.accessToken) {
        await Auth.set("servicenow", {
          type: "servicenow-oauth",
          instance,
          clientId,
          clientSecret,
          accessToken: tokenResult.accessToken,
          refreshToken: tokenResult.refreshToken,
          expiresAt: tokenResult.expiresIn ? Date.now() + tokenResult.expiresIn * 1000 : undefined,
        })
      }

      return tokenResult
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Invalid callback URL format",
      }
    }
  }

  /**
   * Main authentication flow with localhost callback server
   */
  async authenticate(options: ServiceNowOAuthOptions): Promise<ServiceNowAuthResult> {
    try {
      const normalizedInstance = this.normalizeInstanceUrl(options.instance)

      // Validate client secret
      const secretValidation = this.validateClientSecret(options.clientSecret)
      if (!secretValidation.valid) {
        prompts.log.error(`Invalid OAuth Client Secret: ${secretValidation.reason}`)
        prompts.log.info("To get a valid OAuth secret:")
        prompts.log.message("   1. Log into ServiceNow as admin")
        prompts.log.message("   2. Navigate to: System OAuth > Application Registry")
        prompts.log.message("   3. Create a new OAuth application")
        prompts.log.message("   4. Set Redirect URL to: http://localhost:3005/callback")
        prompts.log.message("   5. Copy the generated Client Secret")
        return {
          success: false,
          error: secretValidation.reason,
        }
      }

      prompts.log.step("Starting ServiceNow OAuth flow")
      prompts.log.info(`Instance: ${normalizedInstance}`)

      // Generate state and PKCE
      this.stateParameter = this.generateState()
      this.generatePKCE()

      // Always use localhost - simplest approach for all environments
      const port = 3005
      const redirectUri = `http://localhost:${port}/callback`

      prompts.log.message("")

      // Generate authorization URL
      const authUrl = this.generateAuthUrlWithCallback(normalizedInstance, options.clientId, redirectUri)

      prompts.log.step("Opening browser for authentication...")
      prompts.log.info(`Authorization URL: ${authUrl}`)
      prompts.log.message("")

      // Auto-open browser
      this.openBrowser(authUrl)

      // Start callback server
      // In remote environments (Codespaces, Gitpod, etc), the callback won't reach localhost
      // The user will be prompted to paste the callback URL after clicking Approve
      const result = await this.startCallbackServer(
        port,
        normalizedInstance,
        options.clientId,
        options.clientSecret,
        redirectUri,
      )

      if (result.success && result.accessToken) {
        // Save to SnowCode auth store
        await Auth.set("servicenow", {
          type: "servicenow-oauth",
          instance: normalizedInstance,
          clientId: options.clientId,
          clientSecret: options.clientSecret,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined,
        })

        prompts.log.success("Tokens saved securely")
      }

      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      prompts.log.error(`Authentication failed: ${errorMessage}`)
      return {
        success: false,
        error: errorMessage,
      }
    }
  }

  /**
   * Generate authorization URL with localhost callback
   */
  private generateAuthUrlWithCallback(instance: string, clientId: string, redirectUri: string): string {
    const baseUrl = instance.startsWith("http") ? instance : `https://${instance}`

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state: this.stateParameter!,
      code_challenge: this.codeChallenge!,
      code_challenge_method: "S256",
    })

    return `${baseUrl}/oauth_auth.do?${params.toString()}`
  }

  /**
   * Auto-open browser
   */
  private openBrowser(url: string): void {
    try {
      const { spawn } = require("child_process")
      let browserProcess: any

      if (process.platform === "darwin") {
        browserProcess = spawn("open", [url], { detached: true, stdio: "ignore" })
      } else if (process.platform === "win32") {
        browserProcess = spawn("cmd", ["/c", "start", url], { detached: true, stdio: "ignore" })
      } else if (process.platform === "linux") {
        // Try multiple Linux browser openers
        const openers = ["xdg-open", "gnome-open", "kde-open"]
        for (const opener of openers) {
          try {
            browserProcess = spawn(opener, [url], { detached: true, stdio: "ignore" })
            break
          } catch (e) {
            continue
          }
        }
      }

      if (browserProcess && browserProcess.unref) {
        browserProcess.unref()
      }
    } catch (err) {
      prompts.log.warn("Could not auto-open browser. Please manually open the URL above.")
    }
  }

  /**
   * Start localhost callback server with Codespaces URL pasting fallback
   */
  private async startCallbackServer(
    port: number,
    instance: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ): Promise<ServiceNowAuthResult> {
    const inRemoteEnv = isRemoteEnvironment()

    return new Promise((resolve) => {
      const { createServer } = require("http")
      const { URL } = require("url")
      let resolved = false

      const server = createServer(async (req: any, res: any) => {
        if (resolved) return

        try {
          const url = new URL(req.url!, `http://localhost:${port}`)

          if (url.pathname === "/callback") {
            const code = url.searchParams.get("code")
            const error = url.searchParams.get("error")
            const state = url.searchParams.get("state")

            // Validate state parameter
            if (!state || !this.stateParameter || !timingSafeCompare(state, this.stateParameter)) {
              res.writeHead(400, { "Content-Type": "text/html" })
              res.end(OAuthTemplates.securityError)
              server.close()
              resolved = true
              resolve({ success: false, error: "Invalid state parameter" })
              return
            }

            if (error) {
              res.writeHead(400, { "Content-Type": "text/html" })
              res.end(OAuthTemplates.error(`OAuth error: ${error}`))
              server.close()
              resolved = true
              resolve({ success: false, error: `OAuth error: ${error}` })
              return
            }

            if (!code) {
              res.writeHead(400, { "Content-Type": "text/html" })
              res.end(OAuthTemplates.missingCode)
              server.close()
              resolved = true
              resolve({ success: false, error: "No authorization code received" })
              return
            }

            // Exchange code for tokens
            const spinner = prompts.spinner()
            spinner.start("Exchanging authorization code for tokens")
            const tokenResult = await this.exchangeCodeForTokens(instance, clientId, clientSecret, code, redirectUri)

            if (tokenResult.success) {
              res.writeHead(200, { "Content-Type": "text/html" })
              res.end(OAuthTemplates.success)
              spinner.stop("Authentication successful")
              server.close()
              resolved = true
              resolve(tokenResult)
            } else {
              res.writeHead(500, { "Content-Type": "text/html" })
              res.end(OAuthTemplates.tokenExchangeFailed(tokenResult.error || "Unknown error"))
              spinner.stop("Token exchange failed")
              server.close()
              resolved = true
              resolve(tokenResult)
            }
          } else {
            res.writeHead(404, { "Content-Type": "text/plain" })
            res.end("Not Found")
          }
        } catch (error) {
          res.writeHead(500, { "Content-Type": "text/plain" })
          res.end("Internal Server Error")
          server.close()
          resolved = true
          resolve({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })

      // SECURITY: Bind to 127.0.0.1 only to prevent network exposure of the callback server
      server.listen(port, "127.0.0.1", async () => {
        prompts.log.info(`Callback server started on http://localhost:${port}/callback`)
        prompts.log.info("Waiting for OAuth callback...")

        // In remote/headless environments, the callback won't work automatically
        if (inRemoteEnv) {
          prompts.log.message("")
          prompts.log.info("Remote/headless environment detected")
          prompts.log.message("")
          prompts.log.info("After clicking 'Approve' in ServiceNow:")
          prompts.log.message("   1. Your browser will show a 'Can't reach this page' or 404 error")
          prompts.log.message("   2. Copy the FULL URL from your browser address bar")
          prompts.log.message("      (it starts with: http://localhost:3005/callback?code=...)")
          prompts.log.message("   3. Paste it below in a few seconds")
          prompts.log.message("")

          // Wait a bit to see if automatic callback works (unlikely in Codespaces)
          await new Promise((resolve) => setTimeout(resolve, 3000))

          if (!resolved) {
            try {
              const callbackUrl = await prompts.text({
                message: "Paste the callback URL here (or press Enter to keep waiting):",
                placeholder: "http://localhost:3005/callback?code=...&state=...",
                validate: (value) => {
                  if (!value || value.trim() === "") {
                    return undefined // Allow empty to continue waiting
                  }
                  if (!value.includes("/callback")) {
                    return "URL must contain '/callback'"
                  }
                  return undefined
                },
              })

              if (!prompts.isCancel(callbackUrl) && callbackUrl && callbackUrl.trim() !== "") {
                // Parse the pasted URL
                try {
                  const parsedUrl = new URL(callbackUrl.replace("localhost:3005", "localhost:" + port))
                  const code = parsedUrl.searchParams.get("code")
                  const error = parsedUrl.searchParams.get("error")
                  const state = parsedUrl.searchParams.get("state")

                  // Validate state parameter
                  if (!state || !this.stateParameter || !timingSafeCompare(state, this.stateParameter)) {
                    server.close()
                    resolved = true
                    resolve({ success: false, error: "Invalid state parameter - possible CSRF attack" })
                    return
                  }

                  if (error) {
                    server.close()
                    resolved = true
                    resolve({ success: false, error: `OAuth error: ${error}` })
                    return
                  }

                  if (!code) {
                    prompts.log.warn("No authorization code found in URL, continuing to wait for callback...")
                  } else {
                    // Exchange code for tokens
                    const spinner = prompts.spinner()
                    spinner.start("Exchanging authorization code for tokens")
                    const tokenResult = await this.exchangeCodeForTokens(
                      instance,
                      clientId,
                      clientSecret,
                      code,
                      redirectUri,
                    )

                    if (tokenResult.success) {
                      spinner.stop("Authentication successful")
                      server.close()
                      resolved = true
                      resolve(tokenResult)
                    } else {
                      spinner.stop("Token exchange failed")
                      server.close()
                      resolved = true
                      resolve(tokenResult)
                    }
                  }
                } catch (urlError) {
                  prompts.log.warn("Invalid URL format, continuing to wait for callback...")
                }
              }
            } catch (promptError) {
              // If prompt fails, just continue waiting
              prompts.log.warn("Continuing to wait for automatic callback...")
            }
          }
        }
      })

      // Timeout after 5 minutes
      setTimeout(() => {
        if (!resolved) {
          server.close()
          resolved = true
          resolve({
            success: false,
            error: "Authentication timeout (5 minutes)",
          })
        }
      }, 300000)
    })
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(
    instance: string,
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<ServiceNowAuthResult> {
    if (!this.checkTokenRequestRateLimit()) {
      return {
        success: false,
        error: "Rate limit exceeded",
      }
    }

    const baseUrl = instance.startsWith("http") ? instance : `https://${instance}`
    const tokenUrl = `${baseUrl}/oauth_token.do`

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    })

    try {
      const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      })

      if (!response.ok) {
        return {
          success: false,
          error: `Token refresh failed: ${response.status}`,
        }
      }

      const data = await response.json()

      if (data.error) {
        return {
          success: false,
          error: `OAuth error: ${data.error}`,
        }
      }

      // Update stored tokens
      await Auth.set("servicenow", {
        type: "servicenow-oauth",
        instance,
        clientId,
        clientSecret,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      })

      return {
        success: true,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresIn: data.expires_in,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
