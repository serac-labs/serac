/**
 * snow_get_inbound_http_logs - View incoming HTTP request logs
 *
 * Retrieve inbound REST API transaction logs to monitor
 * API usage, performance, and troubleshoot incoming requests.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_inbound_http_logs",
  description: "Retrieve inbound REST API transaction logs for monitoring API usage and debugging incoming requests",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "monitoring",
  use_cases: ["api", "rest", "monitoring", "debugging", "http", "transactions"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["success", "error", "all"],
        description: "Filter by response status (success = 2xx, error = 4xx/5xx)",
        default: "all",
      },
      url_path: {
        type: "string",
        description: "Filter by request URL path (partial match)",
      },
      http_method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "all"],
        description: "Filter by HTTP method",
        default: "all",
      },
      user: {
        type: "string",
        description: "Filter by user who made the request",
      },
      source_ip: {
        type: "string",
        description: "Filter by source IP address",
      },
      limit: {
        type: "number",
        description: "Maximum number of log entries to return",
        default: 50,
        minimum: 1,
        maximum: 500,
      },
      since: {
        type: "string",
        description: 'Get logs since this timestamp (ISO 8601 or relative like "1h", "30m", "7d")',
      },
      min_response_time: {
        type: "number",
        description: "Only show requests slower than this (milliseconds) - useful for performance debugging",
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var status = args.status || "all"
  var url_path = args.url_path
  var http_method = args.http_method || "all"
  var user = args.user
  var source_ip = args.source_ip
  var limit = args.limit || 50
  var since = args.since
  var min_response_time = args.min_response_time

  try {
    var client = await getAuthenticatedClient(context)

    // Build query
    var queryParts: string[] = []

    // Status filter
    if (status === "success") {
      queryParts.push("status_code>=200^status_code<300")
    } else if (status === "error") {
      queryParts.push("status_code>=400")
    }

    // URL path filter
    if (url_path) {
      queryParts.push("urlLIKE" + url_path)
    }

    // HTTP method filter
    if (http_method !== "all") {
      queryParts.push("http_method=" + http_method)
    }

    // User filter
    if (user) {
      queryParts.push("user.user_nameLIKE" + user)
    }

    // Source IP filter
    if (source_ip) {
      queryParts.push("client_ip=" + source_ip)
    }

    // Time range filter
    if (since) {
      var sinceTimestamp = parseRelativeTime(since)
      queryParts.push("sys_created_on>" + sinceTimestamp)
    }

    // Response time filter (for slow query analysis)
    if (min_response_time) {
      queryParts.push("response_time>" + min_response_time)
    }

    var query = queryParts.join("^")

    // Get inbound transaction logs from syslog_transaction
    var response = await client.get("/api/now/table/syslog_transaction", {
      params: {
        sysparm_query: query + "^ORDERBYDESCsys_created_on",
        sysparm_limit: limit,
        sysparm_fields:
          "sys_id,sys_created_on,url,http_method,status_code,response_time,client_ip,user,session_id,source",
      },
    })

    var logs = response.data.result.map(function (log: any) {
      return {
        sys_id: log.sys_id,
        timestamp: log.sys_created_on,
        url: log.url,
        http_method: log.http_method,
        status_code: log.status_code,
        response_time_ms: log.response_time,
        client_ip: log.client_ip,
        user: log.user,
        session_id: log.session_id,
        source: log.source,
      }
    })

    // Calculate statistics
    var stats = {
      total: logs.length,
      success: 0,
      client_error: 0,
      server_error: 0,
      avg_response_time_ms: 0,
      max_response_time_ms: 0,
      p95_response_time_ms: 0,
    }

    var responseTimes: number[] = []
    logs.forEach(function (log: any) {
      var statusCode = parseInt(log.status_code) || 0
      if (statusCode >= 200 && statusCode < 300) {
        stats.success++
      } else if (statusCode >= 400 && statusCode < 500) {
        stats.client_error++
      } else if (statusCode >= 500) {
        stats.server_error++
      }
      var responseTime = parseInt(log.response_time_ms) || 0
      responseTimes.push(responseTime)
    })

    if (responseTimes.length > 0) {
      responseTimes.sort(function (a, b) {
        return a - b
      })
      var sum = responseTimes.reduce(function (a, b) {
        return a + b
      }, 0)
      stats.avg_response_time_ms = Math.round(sum / responseTimes.length)
      stats.max_response_time_ms = responseTimes[responseTimes.length - 1]
      var p95Index = Math.floor(responseTimes.length * 0.95)
      stats.p95_response_time_ms = responseTimes[p95Index] || stats.max_response_time_ms
    }

    // Group by endpoint
    var byEndpoint: any = {}
    logs.forEach(function (log: any) {
      var path = log.url || "unknown"
      // Simplify path by removing query params and IDs
      path = path.split("?")[0]
      path = path.replace(/\/[a-f0-9]{32}/gi, "/{sys_id}")
      byEndpoint[path] = (byEndpoint[path] || 0) + 1
    })

    // Group by HTTP method
    var byMethod: any = {}
    logs.forEach(function (log: any) {
      var method = log.http_method || "unknown"
      byMethod[method] = (byMethod[method] || 0) + 1
    })

    // Top users
    var byUser: any = {}
    logs.forEach(function (log: any) {
      var userName = log.user || "anonymous"
      byUser[userName] = (byUser[userName] || 0) + 1
    })

    return createSuccessResult({
      logs: logs,
      count: logs.length,
      statistics: stats,
      by_endpoint: byEndpoint,
      by_method: byMethod,
      by_user: byUser,
      filters: {
        status: status,
        url_path: url_path,
        http_method: http_method,
        user: user,
        source_ip: source_ip,
        since: since,
        min_response_time: min_response_time,
      },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function parseRelativeTime(relative: string): string {
  var now = new Date()
  var match = relative.match(/^(\d+)([mhd])$/)

  if (!match) {
    // Assume it's an absolute timestamp
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
