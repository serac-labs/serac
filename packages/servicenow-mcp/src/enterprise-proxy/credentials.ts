/**
 * Enterprise Credentials Gathering
 * Reads credentials from environment variables based on tool name
 *
 * @deprecated This file is no longer used. Credentials are now fetched by the
 * enterprise MCP server from the Portal API using the JWT token. The portal
 * handles KMS decryption, so no local credentials are needed.
 *
 * This file is kept for backwards compatibility but will be removed in a future version.
 */

import { EnterpriseCredentials } from "./types.js"

/**
 * Gather credentials from environment variables based on tool name
 * @param toolName - Name of the tool being called (e.g., snow_jira_create_issue)
 * @returns Credentials object with only relevant credentials populated
 *
 * Atlassian Credential Sharing:
 * Jira and Confluence use the same Atlassian credentials (email + API token).
 * If one is missing, we'll try to use the other as fallback.
 */
export function gatherCredentials(toolName: string): Partial<EnterpriseCredentials> {
  const credentials: Partial<EnterpriseCredentials> = {}

  // Support both naming conventions for Atlassian credentials:
  // - JIRA_* / CONFLUENCE_* (manual config / .env.example)
  // - ATLASSIAN_* + JIRA_HOST/CONFLUENCE_HOST (snow-code auth login)
  const jiraHost = process.env.JIRA_HOST || process.env.JIRA_BASE_URL || ""
  const jiraEmail = process.env.JIRA_EMAIL || process.env.ATLASSIAN_EMAIL || ""
  const jiraApiToken = process.env.JIRA_API_TOKEN || process.env.ATLASSIAN_API_TOKEN || ""

  const confluenceHost = process.env.CONFLUENCE_HOST || process.env.CONFLUENCE_BASE_URL || ""
  const confluenceEmail = process.env.CONFLUENCE_EMAIL || process.env.ATLASSIAN_EMAIL || ""
  const confluenceApiToken = process.env.CONFLUENCE_API_TOKEN || process.env.ATLASSIAN_API_TOKEN || ""

  // Support both naming conventions for Azure DevOps:
  // - AZURE_DEVOPS_* (manual config)
  // - AZURE_* (snow-code auth login)
  // - AZDO_* (proxy server convention)
  const azureOrg = process.env.AZURE_DEVOPS_ORG || process.env.AZURE_ORG || process.env.AZDO_ORG_URL || ""
  const azurePat = process.env.AZURE_DEVOPS_PAT || process.env.AZURE_PAT || process.env.AZDO_PAT || ""

  // Jira tools (jira_* or snow_jira_*)
  if (toolName.startsWith("jira_") || toolName.startsWith("snow_jira_")) {
    if (jiraHost && jiraEmail && jiraApiToken) {
      credentials.jira = {
        host: jiraHost,
        email: jiraEmail,
        apiToken: jiraApiToken,
      }
    }
    // Fallback: Try Confluence credentials if Jira not set (Atlassian credential sharing)
    else if (confluenceHost && confluenceEmail && confluenceApiToken) {
      credentials.jira = {
        host: confluenceHost.replace("/wiki", "").replace("https://", "").replace("http://", ""),
        email: confluenceEmail,
        apiToken: confluenceApiToken,
      }
    }
  }

  // Azure DevOps tools (azure_* or snow_azure_*)
  if (toolName.startsWith("azure_") || toolName.startsWith("snow_azure_")) {
    if (azureOrg && azurePat) {
      credentials.azure = {
        organization: azureOrg,
        pat: azurePat,
      }
    }
  }

  // Confluence tools (confluence_* or snow_confluence_*)
  if (toolName.startsWith("confluence_") || toolName.startsWith("snow_confluence_")) {
    if (confluenceHost && confluenceEmail && confluenceApiToken) {
      credentials.confluence = {
        host: confluenceHost,
        email: confluenceEmail,
        apiToken: confluenceApiToken,
      }
    }
    // Fallback: Try Jira credentials if Confluence not set (Atlassian credential sharing)
    else if (jiraHost && jiraEmail && jiraApiToken) {
      credentials.confluence = {
        host: jiraHost.includes("://") ? jiraHost : "https://" + jiraHost,
        email: jiraEmail,
        apiToken: jiraApiToken,
      }
    }
  }

  return credentials
}

/**
 * Check if all required credentials are available for a tool
 * @param toolName - Name of the tool
 * @returns true if credentials are available, false otherwise
 *
 * Considers Atlassian credential sharing: returns true if fallback available.
 */
export function hasRequiredCredentials(toolName: string): boolean {
  const credentials = gatherCredentials(toolName)

  if (toolName.startsWith("jira_") || toolName.startsWith("snow_jira_")) {
    return !!credentials.jira
  }

  if (toolName.startsWith("azure_") || toolName.startsWith("snow_azure_")) {
    return !!credentials.azure
  }

  if (toolName.startsWith("confluence_") || toolName.startsWith("snow_confluence_")) {
    return !!credentials.confluence
  }

  return false
}

/**
 * Get list of missing credential environment variables for a tool
 * @param toolName - Name of the tool
 * @returns Array of missing environment variable names
 *
 * Considers Atlassian credential sharing: won't report missing if fallback available.
 * Supports both naming conventions (JIRA_*, ATLASSIAN_*, AZURE_*, AZDO_*, etc.)
 */
export function getMissingCredentials(toolName: string): string[] {
  const missing: string[] = []

  // Check for Jira credentials (both naming conventions)
  const jiraHost = process.env.JIRA_HOST || process.env.JIRA_BASE_URL
  const jiraEmail = process.env.JIRA_EMAIL || process.env.ATLASSIAN_EMAIL
  const jiraApiToken = process.env.JIRA_API_TOKEN || process.env.ATLASSIAN_API_TOKEN

  // Check for Confluence credentials (both naming conventions)
  const confluenceHost = process.env.CONFLUENCE_HOST || process.env.CONFLUENCE_BASE_URL
  const confluenceEmail = process.env.CONFLUENCE_EMAIL || process.env.ATLASSIAN_EMAIL
  const confluenceApiToken = process.env.CONFLUENCE_API_TOKEN || process.env.ATLASSIAN_API_TOKEN

  // Check for Azure DevOps credentials (all naming conventions)
  const azureOrg = process.env.AZURE_DEVOPS_ORG || process.env.AZURE_ORG || process.env.AZDO_ORG_URL
  const azurePat = process.env.AZURE_DEVOPS_PAT || process.env.AZURE_PAT || process.env.AZDO_PAT

  if (toolName.startsWith("jira_") || toolName.startsWith("snow_jira_")) {
    const hasJira = jiraHost && jiraEmail && jiraApiToken
    const hasConfluence = confluenceHost && confluenceEmail && confluenceApiToken

    if (!hasJira && !hasConfluence) {
      // No Atlassian credentials at all
      if (!jiraHost) missing.push("JIRA_HOST or ATLASSIAN credentials")
      if (!jiraEmail) missing.push("JIRA_EMAIL or ATLASSIAN_EMAIL")
      if (!jiraApiToken) missing.push("JIRA_API_TOKEN or ATLASSIAN_API_TOKEN")
    }
    // If Confluence credentials available, they'll be used as fallback (no warnings needed)
  }

  if (toolName.startsWith("azure_") || toolName.startsWith("snow_azure_")) {
    if (!azureOrg) missing.push("AZURE_ORG or AZDO_ORG_URL")
    if (!azurePat) missing.push("AZURE_PAT or AZDO_PAT")
  }

  if (toolName.startsWith("confluence_") || toolName.startsWith("snow_confluence_")) {
    const hasConfluence = confluenceHost && confluenceEmail && confluenceApiToken
    const hasJira = jiraHost && jiraEmail && jiraApiToken

    if (!hasConfluence && !hasJira) {
      // No Atlassian credentials at all
      if (!confluenceHost) missing.push("CONFLUENCE_HOST or ATLASSIAN credentials")
      if (!confluenceEmail) missing.push("CONFLUENCE_EMAIL or ATLASSIAN_EMAIL")
      if (!confluenceApiToken) missing.push("CONFLUENCE_API_TOKEN or ATLASSIAN_API_TOKEN")
    }
    // If Jira credentials available, they'll be used as fallback (no warnings needed)
  }

  return missing
}
