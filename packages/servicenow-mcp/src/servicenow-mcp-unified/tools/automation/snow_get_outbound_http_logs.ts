/**
 * snow_get_outbound_http_logs - View outgoing HTTP request logs
 *
 * Retrieve outbound HTTP request logs to monitor and debug
 * REST/SOAP integrations, webhooks, and external API calls.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_outbound_http_logs",
  description: "Retrieve outbound HTTP request logs for monitoring REST/SOAP integrations and external API calls",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "monitoring",
  use_cases: ["integration", "rest", "soap", "monitoring", "debugging", "http"],
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
      endpoint: {
        type: "string",
        description: "Filter by target endpoint URL (partial match)",
      },
      rest_message: {
        type: "string",
        description: "Filter by REST Message name",
      },
      http_method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "all"],
        description: "Filter by HTTP method",
        default: "all",
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
      include_payload: {
        type: "boolean",
        description: "Include request/response body in output (can be large)",
        default: false,
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var status = args.status || "all"
  var endpoint = args.endpoint
  var rest_message = args.rest_message
  var http_method = args.http_method || "all"
  var limit = args.limit || 50
  var since = args.since
  var include_payload = args.include_payload || false

  try {
    var client = await getAuthenticatedClient(context)

    // Build query
    var queryParts: string[] = []

    // Status filter (based on HTTP status code)
    if (status === "success") {
      queryParts.push("http_status>=200^http_status<300")
    } else if (status === "error") {
      queryParts.push("http_status>=400")
    }

    // Endpoint filter
    if (endpoint) {
      queryParts.push("urlLIKE" + endpoint)
    }

    // REST Message filter
    if (rest_message) {
      queryParts.push("rest_message.nameLIKE" + rest_message)
    }

    // HTTP method filter
    if (http_method !== "all") {
      queryParts.push("http_method=" + http_method)
    }

    // Time range filter
    if (since) {
      var sinceTimestamp = parseRelativeTime(since)
      queryParts.push("sys_created_on>" + sinceTimestamp)
    }

    var query = queryParts.join("^")

    // Build fields list
    var fields =
      "sys_id,sys_created_on,url,http_method,http_status,response_time,rest_message,source_table,source_sys_id,error_message"
    if (include_payload) {
      fields += ",request_headers,request_body,response_headers,response_body"
    }

    // Get outbound HTTP logs
    var response = await client.get("/api/now/table/sys_outbound_http_log", {
      params: {
        sysparm_query: query + "^ORDERBYDESCsys_created_on",
        sysparm_limit: limit,
        sysparm_fields: fields,
      },
    })

    var logs = response.data.result.map(function (log: any) {
      var record: any = {
        sys_id: log.sys_id,
        timestamp: log.sys_created_on,
        url: log.url,
        http_method: log.http_method,
        http_status: log.http_status,
        response_time_ms: log.response_time,
        rest_message: log.rest_message,
        source_table: log.source_table,
        source_sys_id: log.source_sys_id,
        error: log.error_message || null,
      }

      if (include_payload) {
        record.request = {
          headers: log.request_headers,
          body: log.request_body,
        }
        record.response = {
          headers: log.response_headers,
          body: log.response_body,
        }
      }

      return record
    })

    // Calculate statistics
    var stats = {
      total: logs.length,
      success: 0,
      client_error: 0,
      server_error: 0,
      avg_response_time_ms: 0,
    }

    var totalResponseTime = 0
    logs.forEach(function (log: any) {
      var statusCode = parseInt(log.http_status) || 0
      if (statusCode >= 200 && statusCode < 300) {
        stats.success++
      } else if (statusCode >= 400 && statusCode < 500) {
        stats.client_error++
      } else if (statusCode >= 500) {
        stats.server_error++
      }
      totalResponseTime += parseInt(log.response_time_ms) || 0
    })

    if (logs.length > 0) {
      stats.avg_response_time_ms = Math.round(totalResponseTime / logs.length)
    }

    // Group by endpoint
    var byEndpoint: any = {}
    logs.forEach(function (log: any) {
      try {
        var url = new URL(log.url)
        var host = url.hostname
        byEndpoint[host] = (byEndpoint[host] || 0) + 1
      } catch (e) {
        byEndpoint["unknown"] = (byEndpoint["unknown"] || 0) + 1
      }
    })

    return createSuccessResult({
      logs: logs,
      count: logs.length,
      statistics: stats,
      by_endpoint: byEndpoint,
      filters: {
        status: status,
        endpoint: endpoint,
        rest_message: rest_message,
        http_method: http_method,
        since: since,
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
