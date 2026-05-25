/**
 * snow_get_slow_queries - View slow database queries
 *
 * Retrieve slow query logs to identify performance issues,
 * optimize GlideRecord queries, and improve system responsiveness.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_slow_queries",
  description:
    "Retrieve slow database query logs for identifying performance issues, optimizing GlideRecord queries, and improving system responsiveness",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "monitoring",
  use_cases: ["performance", "optimization", "monitoring", "debugging"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Filter by table name (e.g., incident, task, cmdb_ci)",
      },
      min_duration: {
        type: "number",
        description: "Minimum query duration in milliseconds to include",
        default: 1000,
      },
      source: {
        type: "string",
        description: "Filter by source (script name, business rule, etc.)",
      },
      user: {
        type: "string",
        description: "Filter by user who executed the query",
      },
      limit: {
        type: "number",
        description: "Maximum number of slow queries to return",
        default: 50,
        minimum: 1,
        maximum: 500,
      },
      since: {
        type: "string",
        description: 'Get queries since this timestamp (ISO 8601 or relative like "1h", "30m", "7d")',
      },
      include_query_text: {
        type: "boolean",
        description: "Include the actual query/encoded query text",
        default: true,
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var table = args.table
  var min_duration = args.min_duration || 1000
  var source = args.source
  var user = args.user
  var limit = args.limit || 50
  var since = args.since
  var include_query_text = args.include_query_text !== false

  try {
    var client = await getAuthenticatedClient(context)

    // Try to get slow queries from syslog (where slow query warnings are logged)
    var queryParts: string[] = []

    // Look for slow query messages
    queryParts.push("messageLIKESlow")
    queryParts.push("messageLIKEquery")

    // Or look for query performance entries
    // queryParts.push('sourceLIKEquery');

    // Time range filter
    if (since) {
      var sinceTimestamp = parseRelativeTime(since)
      queryParts.push("sys_created_on>" + sinceTimestamp)
    }

    // Source filter
    if (source) {
      queryParts.push("sourceLIKE" + source)
    }

    // Table filter (in message)
    if (table) {
      queryParts.push("messageLIKE" + table)
    }

    var query = queryParts.join("^")

    // Get slow query logs from syslog
    var syslogResponse = await client.get("/api/now/table/syslog", {
      params: {
        sysparm_query: query + "^ORDERBYDESCsys_created_on",
        sysparm_limit: limit,
        sysparm_fields: "sys_id,sys_created_on,source,message,level,sys_created_by",
      },
    })

    // Also try to get from sys_slow_query_log if it exists
    var slowQueryLogs: any[] = []
    try {
      var slowQueryResponse = await client.get("/api/now/table/sys_slow_query_log", {
        params: {
          sysparm_query: (since ? "sys_created_on>" + sinceTimestamp : "") + "^ORDERBYDESCsys_created_on",
          sysparm_limit: limit,
          sysparm_fields: "sys_id,sys_created_on,table,query,duration,source,user,stack_trace",
        },
      })
      slowQueryLogs = slowQueryResponse.data.result || []
    } catch (e) {
      // Table might not exist, that's okay
    }

    // Also try syslog_transaction for slow API calls
    var slowTransactions: any[] = []
    try {
      var transQuery = "response_time>" + min_duration
      if (since) {
        transQuery += "^sys_created_on>" + sinceTimestamp
      }
      if (user) {
        transQuery += "^user.user_nameLIKE" + user
      }

      var transResponse = await client.get("/api/now/table/syslog_transaction", {
        params: {
          sysparm_query: transQuery + "^ORDERBYDESCresponse_time",
          sysparm_limit: Math.min(limit, 100),
          sysparm_fields: "sys_id,sys_created_on,url,http_method,response_time,user,status_code",
        },
      })
      slowTransactions = transResponse.data.result || []
    } catch (e) {
      // Table might not be accessible
    }

    // Process syslog entries
    var syslogQueries = (syslogResponse.data.result || [])
      .map(function (log: any) {
        var duration = extractDuration(log.message)
        return {
          sys_id: log.sys_id,
          type: "syslog",
          timestamp: log.sys_created_on,
          source: log.source,
          message: include_query_text ? log.message : truncateMessage(log.message),
          level: log.level,
          user: log.sys_created_by,
          duration_ms: duration,
          table: extractTable(log.message),
        }
      })
      .filter(function (q: any) {
        return q.duration_ms === null || q.duration_ms >= min_duration
      })

    // Process slow query log entries
    var formattedSlowQueries = slowQueryLogs
      .map(function (log: any) {
        return {
          sys_id: log.sys_id,
          type: "slow_query_log",
          timestamp: log.sys_created_on,
          table: log.table,
          query: include_query_text ? log.query : "[query hidden]",
          duration_ms: parseInt(log.duration) || 0,
          source: log.source,
          user: log.user,
          has_stack_trace: !!log.stack_trace,
        }
      })
      .filter(function (q: any) {
        return q.duration_ms >= min_duration
      })

    // Process slow transactions
    var formattedTransactions = slowTransactions.map(function (log: any) {
      return {
        sys_id: log.sys_id,
        type: "slow_transaction",
        timestamp: log.sys_created_on,
        url: log.url,
        http_method: log.http_method,
        duration_ms: parseInt(log.response_time) || 0,
        user: log.user,
        status_code: log.status_code,
      }
    })

    // Combine all results
    var allQueries = syslogQueries.concat(formattedSlowQueries).concat(formattedTransactions)

    // Sort by duration (slowest first)
    allQueries.sort(function (a: any, b: any) {
      return (b.duration_ms || 0) - (a.duration_ms || 0)
    })

    // Limit total results
    allQueries = allQueries.slice(0, limit)

    // Calculate statistics
    var stats = {
      total: allQueries.length,
      from_syslog: syslogQueries.length,
      from_slow_query_log: formattedSlowQueries.length,
      from_transactions: formattedTransactions.length,
      avg_duration_ms: 0,
      max_duration_ms: 0,
      min_duration_ms: 0,
    }

    var durations = allQueries
      .filter(function (q: any) {
        return q.duration_ms !== null && q.duration_ms > 0
      })
      .map(function (q: any) {
        return q.duration_ms
      })

    if (durations.length > 0) {
      durations.sort(function (a: number, b: number) {
        return a - b
      })
      var sum = durations.reduce(function (a: number, b: number) {
        return a + b
      }, 0)
      stats.avg_duration_ms = Math.round(sum / durations.length)
      stats.max_duration_ms = durations[durations.length - 1]
      stats.min_duration_ms = durations[0]
    }

    // Group by table
    var byTable: any = {}
    allQueries.forEach(function (q: any) {
      var tableName = q.table || "Unknown"
      if (!byTable[tableName]) {
        byTable[tableName] = { count: 0, total_duration_ms: 0 }
      }
      byTable[tableName].count++
      byTable[tableName].total_duration_ms += q.duration_ms || 0
    })

    // Calculate average per table
    Object.keys(byTable).forEach(function (t) {
      byTable[t].avg_duration_ms = Math.round(byTable[t].total_duration_ms / byTable[t].count)
    })

    // Group by source
    var bySource: any = {}
    allQueries.forEach(function (q: any) {
      var sourceName = q.source || "Unknown"
      bySource[sourceName] = (bySource[sourceName] || 0) + 1
    })

    // Top slowest queries
    var topSlowest = allQueries.slice(0, 10).map(function (q: any) {
      return {
        duration_ms: q.duration_ms,
        table: q.table,
        source: q.source,
        type: q.type,
        timestamp: q.timestamp,
      }
    })

    return createSuccessResult({
      slow_queries: allQueries,
      count: allQueries.length,
      statistics: stats,
      by_table: byTable,
      by_source: bySource,
      top_slowest: topSlowest,
      filters: {
        table: table,
        min_duration: min_duration,
        source: source,
        user: user,
        since: since,
      },
      recommendations: generateRecommendations(byTable, topSlowest),
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function extractDuration(message: string): number | null {
  // Try to extract duration from message like "Query took 5234ms" or "Slow query: 5.2s"
  var msMatch = message.match(/(\d+)\s*ms/i)
  if (msMatch) {
    return parseInt(msMatch[1])
  }

  var secMatch = message.match(/(\d+\.?\d*)\s*s(?:ec)?/i)
  if (secMatch) {
    return Math.round(parseFloat(secMatch[1]) * 1000)
  }

  return null
}

function extractTable(message: string): string | null {
  // Try to extract table name from message
  var tableMatch = message.match(/table[:\s]+(\w+)/i)
  if (tableMatch) {
    return tableMatch[1]
  }

  var fromMatch = message.match(/from\s+(\w+)/i)
  if (fromMatch) {
    return fromMatch[1]
  }

  return null
}

function truncateMessage(message: string): string {
  if (message.length > 200) {
    return message.substring(0, 200) + "..."
  }
  return message
}

function generateRecommendations(byTable: any, topSlowest: any[]): string[] {
  var recommendations: string[] = []

  // Find tables with many slow queries
  Object.keys(byTable).forEach(function (table) {
    if (byTable[table].count > 5 && byTable[table].avg_duration_ms > 2000) {
      recommendations.push(
        'Table "' +
          table +
          '" has ' +
          byTable[table].count +
          " slow queries (avg " +
          byTable[table].avg_duration_ms +
          "ms). Consider adding indexes or optimizing queries.",
      )
    }
  })

  // Check for very slow queries
  topSlowest.forEach(function (q) {
    if (q.duration_ms > 10000) {
      recommendations.push(
        'Query on "' +
          (q.table || "unknown") +
          '" took ' +
          q.duration_ms +
          "ms. Review for missing indexes or inefficient filters.",
      )
    }
  })

  if (recommendations.length === 0) {
    recommendations.push("No major performance issues detected in the analyzed queries.")
  }

  return recommendations
}

function parseRelativeTime(relative: string): string {
  var now = new Date()
  var match = relative.match(/^(\d+)([mhd])$/)

  if (!match) {
    return relative
  }

  var value = parseInt(match[1])
  var unit = match[2]

  var milliseconds = 0
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

  var sinceDate = new Date(now.getTime() - milliseconds)
  return sinceDate.toISOString()
}

export const version = "1.0.0"
export const author = "Serac Team"
