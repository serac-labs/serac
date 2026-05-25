/**
 * snow_get_logs - Access system logs
 *
 * Retrieve ServiceNow system logs with filtering by level, source,
 * and time range for debugging and monitoring.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

const SUPPORTED_LOG_TABLES = ["syslog", "syslog_app_scope", "syslog_transaction", "sys_script_execution_history"] as const
const SYSLOG_LIKE = ["syslog", "syslog_app_scope"] as const

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_logs",
  description:
    "Retrieve ServiceNow platform logs with filtering by level, source, and time range. Supports four log tables: 'syslog' (default — system log), 'syslog_app_scope' (scoped-app log), 'syslog_transaction' (HTTP transactions), 'sys_script_execution_history' (background-script execution traces).",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "monitoring",
  use_cases: ["automation", "logs", "monitoring", "debugging", "observability"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      log_table: {
        type: "string",
        enum: [...SUPPORTED_LOG_TABLES],
        description:
          "Log table to read. 'syslog' (default) for system log; 'syslog_app_scope' for scoped-app log; 'syslog_transaction' for HTTP transactions; 'sys_script_execution_history' for background-script traces.",
        default: "syslog",
      },
      level: {
        type: "string",
        enum: ["error", "warn", "info", "debug", "all"],
        description: "Log level filter (applies to syslog / syslog_app_scope only)",
        default: "all",
      },
      source: {
        type: "string",
        description: "Filter by log source (e.g., widget name, script name) — syslog / syslog_app_scope only",
      },
      limit: {
        type: "number",
        description: "Maximum number of log entries to return",
        default: 100,
        minimum: 1,
        maximum: 1000,
      },
      since: {
        type: "string",
        description: 'Get logs since this timestamp (ISO 8601 or relative like "1h", "30m")',
      },
      search: {
        type: "string",
        description: "Search term in log messages (syslog / syslog_app_scope only)",
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { log_table = "syslog", level = "all", source, limit = 100, since, search } = args

  if (!SUPPORTED_LOG_TABLES.includes(log_table)) {
    return createErrorResult(
      `Unsupported log_table '${log_table}'. Use one of: ${SUPPORTED_LOG_TABLES.join(", ")}`,
    )
  }

  const isSyslogLike = (SYSLOG_LIKE as readonly string[]).includes(log_table)

  try {
    const client = await getAuthenticatedClient(context)

    // Build query
    const queryParts: string[] = []

    // Level / source / search filters apply to syslog-style tables only
    if (isSyslogLike) {
      if (level !== "all") queryParts.push(`level=${level}`)
      if (source) queryParts.push(`sourceLIKE${source}`)
      if (search) queryParts.push(`messageLIKE${search}`)
    }

    // Time range filter
    if (since) {
      const sinceTimestamp = parseRelativeTime(since)
      queryParts.push(`sys_created_on>${sinceTimestamp}`)
    }

    const query = queryParts.join("^")
    const orderBy = query ? query + "^ORDERBYDESCsys_created_on" : "ORDERBYDESCsys_created_on"

    const fields = isSyslogLike
      ? "sys_created_on,level,source,message,sys_id"
      : undefined // let ServiceNow return the full record for non-syslog tables

    const response = await client.get(`/api/now/table/${log_table}`, {
      params: {
        sysparm_query: orderBy,
        sysparm_limit: limit,
        ...(fields ? { sysparm_fields: fields } : {}),
        sysparm_display_value: "true",
      },
    })

    const rows: any[] = response.data.result ?? []

    // For non-syslog tables, return raw rows (schema varies per table)
    if (!isSyslogLike) {
      const rawSummary = [
        `Fetched ${rows.length} ${log_table} entr${rows.length === 1 ? "y" : "ies"}`,
        since ? `Window: since ${since}` : "",
      ]
        .filter(Boolean)
        .join("\n")

      return createSuccessResult(
        { log_table, entries: rows, count: rows.length, filters: { since } },
        {},
        rawSummary,
      )
    }

    const logs = rows.map((log: any) => ({
      timestamp: log.sys_created_on,
      level: log.level,
      source: log.source,
      message: log.message,
      sys_id: log.sys_id,
    }))

    // Categorize by level
    const byLevel = {
      error: logs.filter((l: any) => l.level === "error").length,
      warn: logs.filter((l: any) => l.level === "warn").length,
      info: logs.filter((l: any) => l.level === "info").length,
      debug: logs.filter((l: any) => l.level === "debug").length,
    }

    // Build a human-readable summary with log excerpts
    const summaryLines: string[] = []
    summaryLines.push(`Found ${logs.length} log entries`)

    // Show level breakdown
    const levelBreakdown: string[] = []
    if (byLevel.error > 0) levelBreakdown.push(`${byLevel.error} errors`)
    if (byLevel.warn > 0) levelBreakdown.push(`${byLevel.warn} warnings`)
    if (byLevel.info > 0) levelBreakdown.push(`${byLevel.info} info`)
    if (byLevel.debug > 0) levelBreakdown.push(`${byLevel.debug} debug`)
    if (levelBreakdown.length > 0) {
      summaryLines.push(`Breakdown: ${levelBreakdown.join(", ")}`)
    }

    if (logs.length > 0) {
      summaryLines.push("")
      summaryLines.push("Recent Log Entries:")

      // Show first 10 log entries with message excerpts
      const previewCount = Math.min(logs.length, 10)
      for (let i = 0; i < previewCount; i++) {
        const log = logs[i]
        const levelIcon =
          log.level === "error" ? "❌" : log.level === "warn" ? "⚠️" : log.level === "info" ? "ℹ️" : "🔍"
        const messagePreview =
          log.message && log.message.length > 100
            ? log.message.substring(0, 100) + "..."
            : log.message || "(no message)"

        summaryLines.push(`  ${levelIcon} [${log.timestamp}] ${log.source || "unknown"}`)
        summaryLines.push(`     ${messagePreview}`)
      }

      if (logs.length > 10) {
        summaryLines.push(`  ... and ${logs.length - 10} more entries`)
      }
    }

    // Add active filters info
    const activeFilters: string[] = []
    if (level !== "all") activeFilters.push(`level=${level}`)
    if (source) activeFilters.push(`source=${source}`)
    if (since) activeFilters.push(`since=${since}`)
    if (search) activeFilters.push(`search=${search}`)
    if (activeFilters.length > 0) {
      summaryLines.push("")
      summaryLines.push(`Filters applied: ${activeFilters.join(", ")}`)
    }

    return createSuccessResult(
      {
        log_table,
        logs,
        count: logs.length,
        by_level: byLevel,
        filters: { level, source, since, search },
      },
      {},
      summaryLines.join("\n"),
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function parseRelativeTime(relative: string): string {
  const now = new Date()
  const match = relative.match(/^(\d+)([mhd])$/)

  if (!match) {
    // Assume it's an absolute timestamp
    return relative
  }

  const value = parseInt(match[1])
  const unit = match[2]

  let milliseconds = 0
  switch (unit) {
    case "m":
      milliseconds = value * 60 * 1000
      break
    case "h":
      milliseconds = value * 60 * 60 * 1000
      break
    case "d":
      milliseconds = value * 24 * 60 * 60 * 1000
      break
  }

  const since = new Date(now.getTime() - milliseconds)
  return since.toISOString()
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
