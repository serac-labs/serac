/**
 * Portal Credential Synchronization
 *
 * Synchronizes local credentials (auth.json) to the Enterprise Portal
 * so users can manage their third-party integrations via the web UI.
 */

import { Auth } from "./index"
import type z from "zod/v4"

export namespace PortalSync {
  interface CredentialPayload {
    service: string
    credentialType?: "api_token" | "basic_auth"
    baseUrl: string
    email?: string
    username?: string
    apiToken?: string
    password?: string
  }

  /**
   * Extract third-party credentials from Enterprise auth and format for portal
   */
  function extractCredentialsFromAuth(auth: z.infer<typeof Auth.Enterprise>): CredentialPayload[] {
    const credentials: CredentialPayload[] = []

    // Jira credentials (uses unified Atlassian credentials)
    if (auth.jiraBaseUrl && auth.atlassianApiToken) {
      credentials.push({
        service: "jira",
        credentialType: "api_token",
        baseUrl: auth.jiraBaseUrl,
        email: auth.atlassianEmail,
        apiToken: auth.atlassianApiToken,
      })
    }

    // Azure DevOps credentials
    if (auth.azureOrg && auth.azurePat) {
      const baseUrl = `https://dev.azure.com/${auth.azureOrg}`
      credentials.push({
        service: "azure-devops",
        credentialType: "api_token",
        baseUrl,
        apiToken: auth.azurePat,
      })
    }

    // Confluence credentials (uses unified Atlassian credentials)
    if (auth.confluenceUrl && auth.atlassianApiToken) {
      credentials.push({
        service: "confluence",
        credentialType: "api_token",
        baseUrl: auth.confluenceUrl,
        email: auth.atlassianEmail,
        apiToken: auth.atlassianApiToken,
      })
    }

    return credentials
  }

  /**
   * Sync credentials from local auth.json to Enterprise Portal
   *
   * @param licenseKey - Enterprise license key for authentication
   * @param portalUrl - Optional custom portal URL (defaults to production)
   * @returns Success status and sync results
   */
  export async function syncToPortal(
    licenseKey: string,
    portalUrl?: string,
  ): Promise<{
    success: boolean
    message?: string
    results?: Array<{ service: string; success: boolean; action?: string; error?: string }>
    error?: string
  }> {
    try {
      // Get enterprise auth from local storage
      const auth = await Auth.get("enterprise")

      if (!auth || auth.type !== "enterprise") {
        return {
          success: false,
          error: "No enterprise authentication found in local storage",
        }
      }

      // Extract third-party credentials
      const credentials = extractCredentialsFromAuth(auth)

      if (credentials.length === 0) {
        return {
          success: true,
          message: "No third-party credentials to sync",
        }
      }

      // Determine portal URL
      const baseUrl = portalUrl || (process.env.SERAC_PORTAL_URL || process.env.SNOW_FLOW_PORTAL_URL) || "https://dashboard.serac.build"

      // SECURITY: Ensure credentials are only sent over HTTPS (except localhost for dev)
      const parsedUrl = new URL(baseUrl)
      if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost" && parsedUrl.hostname !== "127.0.0.1") {
        return {
          success: false,
          error: "Refusing to send credentials over non-HTTPS connection. Portal URL must use HTTPS.",
        }
      }

      const syncUrl = `${baseUrl}/api/credentials/sync-from-cli`

      // Send credentials to portal
      const response = await fetch(syncUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          licenseKey,
          credentials,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        return {
          success: false,
          error: data.error || `HTTP ${response.status}: ${response.statusText}`,
        }
      }

      return {
        success: true,
        message: data.message || "Credentials synced successfully",
        results: data.results,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Quick sync helper - automatically syncs if enterprise auth exists
   */
  export async function autoSync(portalUrl?: string): Promise<void> {
    const auth = await Auth.get("enterprise")

    if (!auth || auth.type !== "enterprise") {
      // Silently skip if no enterprise auth
      return
    }

    if (!auth.licenseKey) {
      console.warn("Enterprise auth found but no license key - skipping portal sync")
      return
    }

    const result = await syncToPortal(auth.licenseKey, portalUrl)

    if (result.success) {
      console.log(`✓ Synced ${result.results?.length || 0} credentials to portal`)
    } else {
      console.warn(`⚠ Failed to sync credentials to portal: ${result.error}`)
    }
  }

  /**
   * Credential from portal (decrypted)
   */
  interface PortalCredential {
    service: "jira" | "azure-devops" | "confluence" | "github" | "gitlab"
    credentialType: "api_token" | "basic_auth"
    baseUrl: string
    email?: string
    username?: string
    apiToken?: string
    password?: string
  }

  /**
   * Fetch credentials from Enterprise Portal
   * Returns decrypted credentials that can be used locally
   *
   * @param licenseKey - Enterprise license key for authentication
   * @param portalUrl - Optional custom portal URL (defaults to production)
   * @returns Credentials from portal
   */
  export async function fetchFromPortal(
    licenseKey: string,
    portalUrl?: string,
  ): Promise<{
    success: boolean
    credentials?: PortalCredential[]
    message?: string
    error?: string
  }> {
    try {
      // Validate license key
      if (!licenseKey || licenseKey.trim() === "") {
        return {
          success: false,
          error: "No license key provided",
        }
      }

      // Determine portal URL
      const baseUrl = portalUrl || (process.env.SERAC_PORTAL_URL || process.env.SNOW_FLOW_PORTAL_URL) || "https://dashboard.serac.build"

      // SECURITY: Ensure credentials are only fetched over HTTPS (except localhost for dev)
      const parsedUrl = new URL(baseUrl)
      if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost" && parsedUrl.hostname !== "127.0.0.1") {
        return {
          success: false,
          error: "Refusing to fetch credentials over non-HTTPS connection. Portal URL must use HTTPS.",
        }
      }

      const fetchUrl = `${baseUrl}/api/credentials/fetch-for-cli`

      // Fetch credentials from portal
      const response = await fetch(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ licenseKey }),
        signal: AbortSignal.timeout(15000),
      })

      const data = await response.json()

      if (!response.ok) {
        return {
          success: false,
          error: data.error || data.details || `HTTP ${response.status}: ${response.statusText}`,
        }
      }

      return {
        success: true,
        credentials: data.credentials || [],
        message: data.message,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        error: errorMessage.includes("timeout") ? "Connection timeout" : errorMessage,
      }
    }
  }

  /**
   * Fetch credentials from portal and store them locally
   *
   * @param licenseKey - Enterprise license key
   * @param portalUrl - Optional portal URL
   * @returns Result of the operation
   */
  export async function pullFromPortal(
    licenseKey: string,
    portalUrl?: string,
  ): Promise<{
    success: boolean
    message?: string
    credentials?: {
      jira?: { baseUrl: string; email?: string; apiToken?: string }
      azureDevOps?: { org: string; pat?: string }
      confluence?: { baseUrl: string; email?: string; apiToken?: string }
      github?: { apiToken?: string }
      gitlab?: { baseUrl?: string; apiToken?: string }
    }
    error?: string
  }> {
    try {
      // Fetch credentials from portal
      const result = await fetchFromPortal(licenseKey, portalUrl)

      if (!result.success || !result.credentials) {
        return {
          success: false,
          error: result.error || "No credentials found",
        }
      }

      if (result.credentials.length === 0) {
        return {
          success: true,
          message: "No credentials configured in portal",
          credentials: {},
        }
      }

      // Convert portal credentials to local auth format
      const credentials: {
        jira?: { baseUrl: string; email?: string; apiToken?: string }
        azureDevOps?: { org: string; pat?: string }
        confluence?: { baseUrl: string; email?: string; apiToken?: string }
        github?: { apiToken?: string }
        gitlab?: { baseUrl?: string; apiToken?: string }
      } = {}

      for (const cred of result.credentials) {
        switch (cred.service) {
          case "jira":
            credentials.jira = {
              baseUrl: cred.baseUrl,
              email: cred.email,
              apiToken: cred.apiToken,
            }
            break
          case "azure-devops":
            // Extract org from baseUrl (https://dev.azure.com/ORG)
            const orgMatch = cred.baseUrl.match(/dev\.azure\.com\/([^\/]+)/)
            credentials.azureDevOps = {
              org: orgMatch ? orgMatch[1] : cred.baseUrl,
              pat: cred.apiToken,
            }
            break
          case "confluence":
            credentials.confluence = {
              baseUrl: cred.baseUrl,
              email: cred.email,
              apiToken: cred.apiToken,
            }
            break
          case "github":
            credentials.github = {
              apiToken: cred.apiToken,
            }
            break
          case "gitlab":
            credentials.gitlab = {
              baseUrl: cred.baseUrl || "https://gitlab.com",
              apiToken: cred.apiToken,
            }
            break
        }
      }

      return {
        success: true,
        message: `Found ${result.credentials.length} credential(s) in portal`,
        credentials,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * AI provider credential from enterprise portal (decrypted, in-memory only)
   */
  export interface AiProviderCredential {
    providerType: string
    apiKey: string
    endpointUrl?: string | null
    isDefault?: boolean
    config?: Record<string, unknown> | null
  }

  /**
   * Fetch AI provider credentials from Enterprise Portal.
   * Credentials are kept in-memory only — never written to disk.
   *
   * @param portalUrl - Enterprise portal base URL
   * @param token - JWT token from enterprise auth
   * @returns Decrypted AI provider credentials
   */
  export async function fetchAiProvidersFromPortal(
    portalUrl: string,
    token: string,
  ): Promise<{ success: boolean; providers?: AiProviderCredential[]; error?: string }> {
    try {
      // SECURITY: Ensure credentials are only sent over HTTPS (except localhost for dev)
      const parsedUrl = new URL(portalUrl)
      if (
        parsedUrl.protocol !== "https:" &&
        parsedUrl.hostname !== "localhost" &&
        parsedUrl.hostname !== "127.0.0.1"
      ) {
        return {
          success: false,
          error: "Refusing to send credentials over non-HTTPS connection. Portal URL must use HTTPS.",
        }
      }

      const response = await fetch(`${portalUrl}/api/chat/providers/for-cli`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) return { success: false, error: `HTTP ${response.status}` }
      const data = (await response.json()) as { providers?: AiProviderCredential[] }
      return { success: true, providers: data.providers ?? [] }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
