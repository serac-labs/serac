/**
 * Shared Error Handling Module
 *
 * Provides unified error handling, retry logic, and recovery strategies
 * for all ServiceNow MCP tools. Replaces 34 duplicate error handlers
 * with consistent, predictable error management.
 *
 * Features:
 * - Standardized error formats
 * - Automatic retry with exponential backoff
 * - Error classification (retryable vs fatal)
 * - Detailed error messages for debugging
 * - Rollback coordination
 */

import { AxiosError } from "axios"
import { type RetryConfig, type ServiceNowError, type ToolResult } from "./types.js"
import { mcpDebug } from "../../shared/mcp-debug.js"

/**
 * Error classification
 */
export enum ErrorType {
  // Network errors (retryable)
  NETWORK_ERROR = "NETWORK_ERROR",
  TIMEOUT = "TIMEOUT",
  TIMEOUT_ERROR = "TIMEOUT_ERROR", // Alias for TIMEOUT
  CONNECTION_RESET = "CONNECTION_RESET",

  // Auth errors (may need token refresh)
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",

  // ServiceNow API errors
  INVALID_REQUEST = "INVALID_REQUEST",
  RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND",
  NOT_FOUND = "NOT_FOUND", // Alias for RESOURCE_NOT_FOUND
  NOT_FOUND_ERROR = "NOT_FOUND_ERROR", // Additional alias
  RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",
  SERVICENOW_API_ERROR = "SERVICENOW_API_ERROR", // Generic API error
  VALIDATION_ERROR = "VALIDATION_ERROR", // Validation failure

  // ServiceNow business logic errors
  ES5_SYNTAX_ERROR = "ES5_SYNTAX_ERROR",
  WIDGET_COHERENCE_ERROR = "WIDGET_COHERENCE_ERROR",
  UPDATE_SET_CONFLICT = "UPDATE_SET_CONFLICT",
  DEPENDENCY_MISSING = "DEPENDENCY_MISSING",
  PLUGIN_MISSING = "PLUGIN_MISSING", // Plugin not installed

  // Critical errors (not retryable)
  DEPLOYMENT_FAILED = "DEPLOYMENT_FAILED",
  DATA_CORRUPTION = "DATA_CORRUPTION",
  ROLLBACK_FAILED = "ROLLBACK_FAILED",

  // Unknown errors
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

/**
 * Standard error structure
 */
export class SnowFlowError extends Error {
  type: ErrorType
  retryable: boolean
  details: any
  originalError?: Error
  timestamp: Date
  context?: {
    tool?: string
    args?: any
    instanceUrl?: string
  }

  constructor(
    type: ErrorType,
    message: string,
    options: {
      retryable?: boolean
      details?: any
      originalError?: Error
      context?: any
    } = {},
  ) {
    super(message)
    this.name = "SnowFlowError"
    this.type = type
    this.retryable = options.retryable ?? this.isRetryableByType(type)
    this.details = options.details
    this.originalError = options.originalError
    this.context = options.context
    this.timestamp = new Date()

    // Capture stack trace
    Error.captureStackTrace(this, SnowFlowError)
  }

  /**
   * Determine if error type is retryable by default
   */
  private isRetryableByType(type: ErrorType): boolean {
    const retryableTypes = [
      ErrorType.NETWORK_ERROR,
      ErrorType.TIMEOUT,
      ErrorType.CONNECTION_RESET,
      ErrorType.RATE_LIMIT_EXCEEDED,
    ]
    return retryableTypes.includes(type)
  }

  /**
   * Convert to ToolResult format
   */
  toToolResult(): ToolResult {
    return {
      success: false,
      error: this.message,
      metadata: {
        errorType: this.type,
        retryable: this.retryable,
        details: this.details,
        timestamp: this.timestamp.toISOString(),
        ...this.context,
      },
    }
  }
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  backoff: "exponential",
  initialDelay: 1000,
  maxDelay: 10000,
  retryableErrors: ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "RATE_LIMIT_EXCEEDED", "NETWORK_ERROR", "TIMEOUT"],
}

/**
 * Retry operation with exponential backoff
 */
export async function retryWithBackoff<T>(operation: () => Promise<T>, config: Partial<RetryConfig> = {}): Promise<T> {
  const retryConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config }
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    try {
      mcpDebug(`[ErrorHandler] Attempt ${attempt}/${retryConfig.maxAttempts}`)
      return await operation()
    } catch (error: any) {
      lastError = error

      // Check if error is retryable
      const snowFlowError = classifyError(error)
      if (!snowFlowError.retryable) {
        mcpDebug("[ErrorHandler] Non-retryable error:", snowFlowError.type)
        throw snowFlowError
      }

      // Last attempt - throw error
      if (attempt === retryConfig.maxAttempts) {
        mcpDebug("[ErrorHandler] All retry attempts exhausted")
        throw snowFlowError
      }

      // Calculate backoff delay
      const delay = calculateBackoff(attempt, retryConfig)
      mcpDebug(`[ErrorHandler] Retrying in ${delay}ms (attempt ${attempt}/${retryConfig.maxAttempts})`)

      // Wait before retry
      await sleep(delay)
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError || new Error("Retry failed")
}

/**
 * Calculate backoff delay
 */
function calculateBackoff(attempt: number, config: RetryConfig): number {
  let delay: number

  if (config.backoff === "exponential") {
    // Exponential: initialDelay * 2^(attempt-1)
    delay = config.initialDelay * Math.pow(2, attempt - 1)
  } else {
    // Linear: initialDelay * attempt
    delay = config.initialDelay * attempt
  }

  // Cap at maxDelay
  return Math.min(delay, config.maxDelay)
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Classify error into SnowFlowError
 */
export function classifyError(error: any): SnowFlowError {
  // Already a SnowFlowError
  if (error instanceof SnowFlowError) {
    return error
  }

  // Axios error (HTTP/network)
  if (error.isAxiosError) {
    return classifyAxiosError(error as AxiosError)
  }

  // ServiceNow API error
  if (error.response?.data?.error) {
    return classifyServiceNowError(error)
  }

  // Generic JavaScript error
  return new SnowFlowError(ErrorType.UNKNOWN_ERROR, error.message || "Unknown error occurred", {
    retryable: false,
    details: {
      name: error.name,
      stack: error.stack,
    },
    originalError: error,
  })
}

/**
 * Classify Axios error
 */
function classifyAxiosError(error: AxiosError): SnowFlowError {
  const code = error.code
  const status = error.response?.status

  // Network errors
  if (code === "ECONNRESET") {
    return new SnowFlowError(ErrorType.CONNECTION_RESET, "Connection reset by ServiceNow instance", {
      retryable: true,
      details: { code, url: error.config?.url },
      originalError: error,
    })
  }

  if (code === "ETIMEDOUT" || code === "ECONNABORTED") {
    return new SnowFlowError(ErrorType.TIMEOUT, "Request timed out", {
      retryable: true,
      details: { code, timeout: error.config?.timeout },
      originalError: error,
    })
  }

  if (code === "ENOTFOUND" || code === "ECONNREFUSED") {
    return new SnowFlowError(ErrorType.NETWORK_ERROR, "Network error: Cannot reach ServiceNow instance", {
      retryable: true,
      details: { code, url: error.config?.url },
      originalError: error,
    })
  }

  // HTTP status codes
  if (status === 401) {
    return new SnowFlowError(ErrorType.UNAUTHORIZED, "Authentication failed - token may be expired", {
      retryable: true, // Token refresh will be attempted
      details: { status, url: error.config?.url },
      originalError: error,
    })
  }

  if (status === 403) {
    return new SnowFlowError(ErrorType.FORBIDDEN, "Access forbidden - insufficient permissions", {
      retryable: false,
      details: { status, url: error.config?.url },
      originalError: error,
    })
  }

  if (status === 404) {
    return new SnowFlowError(ErrorType.RESOURCE_NOT_FOUND, "Resource not found in ServiceNow", {
      retryable: false,
      details: { status, url: error.config?.url },
      originalError: error,
    })
  }

  if (status === 429) {
    return new SnowFlowError(ErrorType.RATE_LIMIT_EXCEEDED, "ServiceNow API rate limit exceeded", {
      retryable: true,
      details: { status, retryAfter: error.response?.headers["retry-after"] },
      originalError: error,
    })
  }

  // Generic HTTP error
  return new SnowFlowError(ErrorType.INVALID_REQUEST, `HTTP ${status}: ${error.message}`, {
    retryable: false,
    details: { status, url: error.config?.url, data: error.response?.data },
    originalError: error,
  })
}

/**
 * Classify ServiceNow API error
 */
function classifyServiceNowError(error: any): SnowFlowError {
  const snowError: ServiceNowError = error.response?.data
  const message = snowError?.error?.message || "ServiceNow API error"
  const detail = snowError?.error?.detail

  // Check for specific error patterns
  if (detail?.includes("ES5") || detail?.includes("const") || detail?.includes("let")) {
    return new SnowFlowError(ErrorType.ES5_SYNTAX_ERROR, "ES5 syntax violation detected", {
      retryable: false,
      details: { message, detail },
      originalError: error,
    })
  }

  if (detail?.includes("coherence") || detail?.includes("data.")) {
    return new SnowFlowError(ErrorType.WIDGET_COHERENCE_ERROR, "Widget coherence validation failed", {
      retryable: false,
      details: { message, detail },
      originalError: error,
    })
  }

  if (detail?.includes("update set") || detail?.includes("conflict")) {
    return new SnowFlowError(ErrorType.UPDATE_SET_CONFLICT, "Update Set conflict detected", {
      retryable: false,
      details: { message, detail },
      originalError: error,
    })
  }

  // Generic ServiceNow error
  return new SnowFlowError(ErrorType.INVALID_REQUEST, message, {
    retryable: false,
    details: { message, detail, status: snowError?.status },
    originalError: error,
  })
}

/**
 * Handle error with context
 */
export function handleError(
  error: any,
  toolName: string,
  context: { args?: any; instanceUrl?: string } = {},
): SnowFlowError {
  const snowFlowError = classifyError(error)
  snowFlowError.context = {
    tool: toolName,
    ...context,
  }

  // Log error with context
  mcpDebug(`[ErrorHandler] Error in ${toolName}:`, {
    type: snowFlowError.type,
    message: snowFlowError.message,
    retryable: snowFlowError.retryable,
    details: snowFlowError.details,
  })

  return snowFlowError
}

/**
 * Keys on `data` that are structural/metadata, not the artifact itself.
 * Used by `detectArtifact` to skip them when scanning for a wrapper key.
 */
const ARTIFACT_SKIP_KEYS = new Set([
  "created",
  "updated",
  "deleted",
  "action",
  "tips",
  "usage",
  "warnings",
  "errors",
  "script_source",
  "script_size",
  "metadata",
  "summary",
  "success",
  "message",
  "status",
  "was_updated",
  "upsert",
])

/**
 * Detect a ServiceNow artifact reference from tool result `data`.
 *
 * Looks for two common patterns:
 *   1. `{ sys_id: "...", name: "...", ... }` at the top level of `data`
 *   2. `{ <wrapperKey>: { sys_id: "...", ... } }` — the dominant pattern
 *      across snow_create_* tools (e.g. `business_rule`, `widget`,
 *      `script_include`).
 *
 * Returns `undefined` if no sys_id can be found — read-only tools, tools
 * returning lists, or tools with no artifact.
 */
function detectArtifact(data: any): ToolResult["artifact"] | undefined {
  if (!data || typeof data !== "object") return undefined

  // Top-level sys_id
  if (typeof data.sys_id === "string" && data.sys_id.length > 0) {
    return {
      sys_id: data.sys_id,
      type: typeof data.artifact_type === "string" ? data.artifact_type : undefined,
      name: typeof data.name === "string" ? data.name : undefined,
      url: typeof data.url === "string" ? data.url : undefined,
      table: typeof data.table === "string" ? data.table : undefined,
    }
  }

  // Nested wrapper with sys_id
  for (const [key, value] of Object.entries(data)) {
    if (ARTIFACT_SKIP_KEYS.has(key)) continue
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const v = value as Record<string, any>
    if (typeof v.sys_id !== "string" || v.sys_id.length === 0) continue
    return {
      sys_id: v.sys_id,
      // Prefer an explicit `type` field on the inner object (some tools carry
      // the ServiceNow artifact kind there); fall back to the wrapper key.
      type: typeof v.type === "string" ? v.type : key,
      name: typeof v.name === "string" ? v.name : undefined,
      url: typeof v.url === "string" ? v.url : undefined,
      table: typeof v.table === "string" ? v.table : typeof v.collection === "string" ? v.collection : undefined,
    }
  }

  return undefined
}

/**
 * Create success ToolResult
 *
 * @param data - The result data
 * @param metadata - Optional metadata
 * @param summary - Optional human-readable summary (displayed at top of output)
 * @param artifact - Optional explicit artifact reference. Overrides auto-detection.
 */
export function createSuccessResult(
  data: any,
  metadata: any = {},
  summary?: string,
  artifact?: ToolResult["artifact"],
): ToolResult {
  var result: ToolResult = {
    success: true,
    data,
    metadata,
  }
  if (summary) {
    result.summary = summary
  }
  const hoisted = artifact ?? detectArtifact(data)
  if (hoisted?.sys_id) {
    result.artifact = hoisted
  }
  return result
}

/**
 * Create error ToolResult
 */
export function createErrorResult(error: SnowFlowError | string, metadata: any = {}): ToolResult {
  if (typeof error === "string") {
    return {
      success: false,
      error,
      metadata,
    }
  }

  return error.toToolResult()
}

/**
 * Wrap tool execution with error handling
 */
export async function executeWithErrorHandling<T>(
  toolName: string,
  operation: () => Promise<T>,
  options: {
    retry?: boolean
    retryConfig?: Partial<RetryConfig>
    context?: any
  } = {},
): Promise<ToolResult> {
  try {
    let result: T

    if (options.retry) {
      result = await retryWithBackoff(operation, options.retryConfig)
    } else {
      result = await operation()
    }

    // Check if result is already a ToolResult (has success/error field)
    // If so, just add metadata and return it (avoid double wrapping)
    if (result && typeof result === "object" && ("success" in result || "error" in result)) {
      const toolResult = result as any
      // Add tool metadata if not already present
      return {
        ...toolResult,
        metadata: {
          tool: toolName,
          timestamp: new Date().toISOString(),
          ...(toolResult.metadata || {}),
        },
      }
    }

    // Otherwise, wrap the result
    return createSuccessResult(result, {
      tool: toolName,
      timestamp: new Date().toISOString(),
    })
  } catch (error: any) {
    const snowFlowError = handleError(error, toolName, options.context)
    return createErrorResult(snowFlowError)
  }
}
