/**
 * Enterprise MCP Proxy Types
 */

export interface EnterpriseCredentials {
  jira?: {
    host: string
    email: string
    apiToken: string
  }
  azure?: {
    organization: string
    pat: string
  }
  confluence?: {
    host: string
    email: string
    apiToken: string
  }
}

export interface EnterpriseProxyConfig {
  enterpriseUrl: string
  licenseKey: string
  credentials?: EnterpriseCredentials
  instanceId?: string
  version?: string
}

export interface EnterpriseToolCallRequest {
  tool: string
  arguments: Record<string, any>
  credentials?: Partial<EnterpriseCredentials>
}

export interface EnterpriseToolCallResponse {
  success: boolean
  tool: string
  result?: any
  error?: string
  usage?: {
    duration_ms: number
    timestamp: string
  }
}

export interface EnterpriseTool {
  name: string
  description?: string
  inputSchema: {
    type: "object"
    properties: Record<string, any>
    required?: string[]
  }
}

export interface EnterpriseToolListResponse {
  tools: EnterpriseTool[]
}

export interface EnterpriseToolCacheConfig {
  cacheTtlMs: number
  maxCacheSize: number
}

export interface LicenseValidationResponse {
  valid: boolean
  error?: string
  features?: string[]
  serverUrl?: string
  customer?: {
    id: string
    name: string
    status: string
  }
}
