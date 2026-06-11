/**
 * Shared TypeScript types for Unified MCP Server
 */

import { z } from "zod"

/**
 * Enterprise tier levels
 */
export type EnterpriseTier = "community" | "professional" | "team" | "enterprise"

/**
 * Enterprise license information
 */
export interface EnterpriseLicense {
  tier: EnterpriseTier
  company?: string // Company identifier (e.g., 'acme', 'example')
  companyName?: string // Display name (e.g., 'ACME Corp', 'Example Inc')
  licenseKey?: string // Format: SNOW-[TIER]-[ORG-ID]-[EXPIRY]-[CHECKSUM]
  expiresAt?: Date
  features: string[] // Enabled enterprise features
  theme?: string // Company-branded theme name
}

/**
 * ServiceNow instance authentication context
 */
export interface ServiceNowContext {
  instanceUrl: string
  clientId: string
  clientSecret: string
  refreshToken?: string
  accessToken?: string
  tokenExpiry?: number
  username?: string
  password?: string
  // Enterprise features
  enterprise?: EnterpriseLicense
  // Session-based tool enabling
  sessionId?: string
  /**
   * Tenant identifier used to scope every cache and persistence lookup
   * (OAuth tokens, connection pool, session-enabled tools, scripted-exec
   * endpoints). In HTTP mode this is the tenant's `customerId` (or
   * `organizationId` for portal users) as a string. In stdio mode it is the
   * sentinel `"stdio"`. Always populated by the transport's context resolver
   * — handlers and tools should treat an absent value as a programming error.
   */
  tenantId?: string
  /**
   * Which transport produced this context. Tools that do conditional
   * filesystem work (`snow_pull_artifact` writes its output to disk on
   * stdio, returns it inline on HTTP) read this; everything else can
   * ignore it. Populated by call-tool.ts before the executor runs.
   */
  origin?: "stdio" | "http"
  /**
   * OTAP classification of the connected instance. When "production", the
   * call-tool handler blocks write tools by default (reads stay free) unless the
   * caller passes `__confirmProd: true` after the user approves the change.
   * Populated by the transport's context resolver — HTTP from the portal's
   * instance record, stdio from SNOW_ENVIRONMENT_TYPE. Absent ⇒ not gated.
   */
  environmentType?: "production" | "development" | "test" | "uat" | "sandbox"
}

/**
 * User role for permission validation
 */
export type UserRole = "developer" | "stakeholder" | "admin"

/**
 * Tool permission level
 */
export type ToolPermission = "read" | "write" | "admin"

/**
 * Transports on which a tool is permitted to run.
 *
 * Tools that read or write machine-local filesystem paths (`os.tmpdir()`,
 * `os.homedir()`, `process.cwd()`-based paths) are unsafe in HTTP
 * multi-tenant context because every tenant's request lands in the same
 * process with the same file-visibility. Mark such tools as `["stdio"]`
 * so the HTTP transport refuses them.
 *
 * If this field is omitted, the tool is considered available on every
 * transport (`["stdio", "http"]` default).
 */
export type ToolTransport = "stdio" | "http"

/**
 * MCP Tool Definition (compliant with Model Context Protocol)
 */
export interface MCPToolDefinition {
  name: string
  description: string
  // Metadata for tool discovery (not sent to LLM)
  category?: string
  subcategory?: string
  use_cases?: string[]
  complexity?: "beginner" | "intermediate" | "advanced"
  frequency?: "low" | "medium" | "high"

  // 🆕 Permission enforcement
  // Optional for backward compatibility during migration
  permission?: ToolPermission // 'read', 'write', or 'admin' - defaults to 'write' (most restrictive)
  allowedRoles?: UserRole[] // Roles permitted to execute this tool - defaults to ['developer', 'admin']

  // 🆕 Transport-level allowlist. If omitted, tool runs on every transport.
  transports?: ToolTransport[]

  /**
   * Args that are forbidden on the HTTP transport, validated centrally
   * by call-tool.ts before the tool's executor runs. Use this to surgically
   * restrict caller-supplied filesystem paths (`*_file`, `file_path`,
   * `export_path`, `artifact_directory`, `output_dir`, ...) on a tool
   * that's otherwise HTTP-safe — instead of marking the entire tool
   * `transports: ["stdio"]`.
   *
   * The error message includes the arg name, so the agent learns to
   * use the corresponding inline-content alternative on the next call.
   */
  httpForbiddenArgs?: string[]

  /**
   * Update-set guard override. The call-tool handler blocks configuration
   * writes while no update set is active for the session (see
   * shared/update-set-guard.ts). The default classification is
   * category-based; set "required" or "exempt" here to correct an
   * individual tool instead of growing the central lists.
   */
  updateSet?: "required" | "exempt"

  inputSchema: {
    type: "object"
    properties: Record<string, any>
    required?: string[]
    additionalProperties?: boolean
  }
}

/**
 * Tool execution function signature
 */
export type ToolExecutor = (args: Record<string, any>, context: ServiceNowContext) => Promise<ToolResult>

/**
 * Tool result structure
 *
 * The `summary` field provides a human-readable formatted output
 * that is displayed at the TOP of tool results in the TUI.
 * This makes tool output more scannable and user-friendly.
 */
export interface ToolResult {
  success: boolean
  data?: any
  error?: string
  /**
   * Human-readable summary displayed at the top of output.
   * Format: Multi-line string with key information.
   * Example:
   * ```
   * ✓ Created workflow "Auto-Assign Incidents"
   *   sys_id: abc123def456
   *   Table: incident
   *   Activities: 5
   * ```
   */
  summary?: string
  /**
   * Artifact reference for write tools (create/update/deploy/edit).
   * Hoisted to top-level so post-hooks (activity tracking, governance) can
   * extract it without parsing the per-tool data shape.
   *
   * Populated automatically by `createSuccessResult` when the data contains
   * a `sys_id` — either at the top level or inside a single wrapper key
   * (e.g. `{ business_rule: { sys_id, name, table, ... } }`). Tools can
   * also pass an explicit `artifact` argument to override the auto-detection.
   */
  artifact?: {
    sys_id: string
    type?: string
    name?: string
    url?: string
    table?: string
  }
  metadata?: {
    executionTime?: number
    apiCalls?: number
    updateSetId?: string
    [key: string]: any
  }
}

/**
 * Registered tool (definition + executor)
 */
export interface RegisteredTool {
  definition: MCPToolDefinition
  executor: ToolExecutor
  domain: string // 'deployment', 'operations', 'ui-builder', etc.
  filePath: string
  metadata: {
    addedAt: Date
    version: string
    author?: string
  }
}

/**
 * Tool registry configuration
 */
export interface ToolRegistryConfig {
  toolsDirectory: string
  autoDiscovery: boolean
  enableCaching: boolean
  cacheMaxAge: number
  validateOnRegister: boolean
}

/**
 * Error handling configuration
 */
export interface RetryConfig {
  maxAttempts: number
  backoff: "linear" | "exponential"
  initialDelay: number
  maxDelay: number
  retryableErrors: string[]
}

/**
 * OAuth token response from ServiceNow
 */
export interface OAuthTokenResponse {
  access_token: string
  refresh_token: string
  token_type: "Bearer"
  expires_in: number
  scope: string
}

/**
 * JWT Payload (for enterprise MCP authentication)
 */
export interface JWTPayload {
  customerId: number
  company?: string
  tier: EnterpriseTier
  features: string[]
  role: UserRole // 'developer', 'stakeholder', or 'admin'
  userId?: number // NULL for MCP proxy connections
  sessionId: string // Unique session identifier
  instanceId?: string // Machine fingerprint
  iat: number // Issued at
  exp: number // Expires at
}

/**
 * Per-request context that MCP handlers receive.
 *
 * Transport-agnostic: each transport (stdio, HTTP, ...) is responsible for
 * producing a `RequestContext` from its own inputs. Handlers never read
 * headers, files, or env vars directly — they work with whatever the
 * transport's resolver hands them.
 */
export interface RequestContext {
  // Tenant identity (HTTP transport sets these; stdio leaves them undefined)
  customerId?: number
  organizationId?: number
  portalUserId?: number
  // Session ID used for session-based tool enabling
  sessionId?: string
  // JWT payload parsed from request headers (HTTP) or from auth.json (stdio)
  jwtPayload?: JWTPayload
  // Resolved ServiceNow credentials (plaintext)
  serviceNow: ServiceNowContext
  // Which transport produced this context
  origin: "stdio" | "http"
}

/**
 * ServiceNow API error structure
 */
export interface ServiceNowError {
  error: {
    message: string
    detail: string
  }
  status: string
}

/**
 * Tool discovery result
 */
export interface ToolDiscoveryResult {
  toolsFound: number
  toolsRegistered: number
  toolsFailed: number
  domains: string[]
  errors: Array<{
    filePath: string
    error: string
  }>
  duration: number
}

/**
 * Validation result for tool definitions
 */
export interface ToolValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Tool metadata (for tool-definitions.json)
 */
export interface ToolMetadata {
  name: string
  domain: string
  description: string
  version: string
  author?: string
  tags?: string[]
  examples?: Array<{
    description: string
    input: Record<string, any>
    expectedOutput?: any
  }>
}

/**
 * Server statistics
 */
export interface ServerStats {
  uptime: number
  totalToolCalls: number
  successfulCalls: number
  failedCalls: number
  averageExecutionTime: number
  toolUsage: Record<string, number>
  errorsByType: Record<string, number>
}

/**
 * Widget coherence validation result (Serac specific)
 */
export interface WidgetCoherenceResult {
  coherent: boolean
  issues: Array<{
    type: "missing_data" | "orphaned_method" | "action_mismatch" | "invalid_reference"
    severity: "critical" | "warning"
    description: string
    location?: string
    fix?: string
  }>
  analysis: {
    serverInitializedData: string[]
    clientMethods: string[]
    htmlReferences: string[]
    inputActions: string[]
  }
}

/**
 * ES5 validation result (Serac specific)
 */
export interface ES5ValidationResult {
  valid: boolean
  violations: Array<{
    type:
      | "const"
      | "let"
      | "arrow_function"
      | "template_literal"
      | "destructuring"
      | "for_of"
      | "default_param"
      | "class"
    line: number
    column: number
    code: string
    fix: string
  }>
}

/**
 * Update Set context (Serac specific)
 */
export interface UpdateSetContext {
  sys_id: string
  name: string
  state: "in progress" | "complete" | "committed"
  description?: string
  isCurrent: boolean
}
