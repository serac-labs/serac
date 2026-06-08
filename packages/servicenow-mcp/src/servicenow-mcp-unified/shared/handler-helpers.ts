/**
 * Pure helper functions used by MCP request handlers.
 *
 * Extracted from ServiceNowUnifiedServer so that handler logic is
 * transport-agnostic and independent of the server class instance.
 */

/**
 * Format arguments for logging (show key parameters without overwhelming output)
 */
export const formatArgsForLogging = (args: any): string => {
  if (!args || typeof args !== "object") {
    return ""
  }

  const parts: string[] = []
  const maxValueLength = 100

  // Helper: truncate long strings
  const truncate = (value: any): string => {
    const str = String(value)
    if (str.length > maxValueLength) {
      return str.substring(0, maxValueLength) + "..."
    }
    return str
  }

  // Helper: format value for display
  const formatValue = (value: any): string => {
    if (value === null || value === undefined) {
      return "null"
    }
    if (typeof value === "object") {
      // For objects/arrays, show just the type
      if (Array.isArray(value)) {
        return `Array(${value.length})`
      }
      return `{${Object.keys(value).length} keys}`
    }
    return truncate(value)
  }

  // Show key parameters (up to 5 most relevant ones)
  const keyParams = ["table", "query", "action", "sys_id", "name", "type", "identifier"]
  const shownParams = new Set<string>()

  // First, show key parameters if they exist
  for (const key of keyParams) {
    if (key in args && shownParams.size < 5) {
      parts.push(`${key}=${formatValue(args[key])}`)
      shownParams.add(key)
    }
  }

  // Then, show remaining parameters (up to 5 total)
  for (const [key, value] of Object.entries(args)) {
    if (shownParams.size >= 5) break
    if (!shownParams.has(key) && !["script", "template", "client_script", "server_script", "css"].includes(key)) {
      parts.push(`${key}=${formatValue(value)}`)
      shownParams.add(key)
    }
  }

  // Show count of additional parameters if any
  const totalParams = Object.keys(args).length
  if (totalParams > shownParams.size) {
    parts.push(`...+${totalParams - shownParams.size} more`)
  }

  return parts.join(", ")
}

/**
 * Determine if operation should be retried automatically
 */
export const isRetryableOperation = (toolName: string): boolean => {
  // Operations that benefit from automatic retry
  const retryableOperations = [
    "snow_query_table",
    "snow_discover_table_fields",
    "snow_get_by_sysid",
    "snow_comprehensive_search",
    "snow_analyze_query",
  ]

  return retryableOperations.includes(toolName)
}
