/**
 * snow_get_event_correlation - Get event correlation results
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_event_correlation",
  description: "Get event correlation results showing how events are grouped into alerts",
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "event-management",
  use_cases: ["cmdb", "events", "correlation"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      alert_id: { type: "string", description: "Alert sys_id to analyze" },
      time_range: { type: "string", description: 'Time range to check (e.g., "24 hours", "7 days")' },
      include_suppressed: { type: "boolean", description: "Include suppressed events", default: false },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { alert_id, time_range, include_suppressed = false } = args

  try {
    const client = await getAuthenticatedClient(context)

    let result: any = {}

    // If alert_id provided, get specific alert correlation
    if (alert_id) {
      const alertResponse = await client.get(`/api/now/table/em_alert/${alert_id}`)
      const alert = alertResponse.data.result

      if (!alert) {
        return createErrorResult("Alert not found")
      }

      // Get correlated events for this alert
      const eventQuery = `alert=${alert_id}${include_suppressed ? "" : "^suppressed=false"}`
      const eventsResponse = await client.get(`/api/now/table/em_event?sysparm_query=${eventQuery}&sysparm_limit=100`)
      const events = eventsResponse.data.result || []

      result = {
        alert: {
          sys_id: alert.sys_id,
          number: alert.number,
          severity: alert.severity,
          state: alert.state,
          description: alert.description,
        },
        correlated_events: events.length,
        suppressed_events: events.filter((e: any) => e.suppressed === "true").length,
        events: events.map((e: any) => ({
          sys_id: e.sys_id,
          number: e.number,
          type: e.type,
          severity: e.severity,
          node: e.node?.display_value || e.node,
          time_of_event: e.time_of_event,
          suppressed: e.suppressed === "true",
        })),
      }
    } else {
      // Get recent correlation statistics
      let query = "state=Active"
      if (time_range) {
        const hoursMatch = time_range.match(/(\d+)\s*hours?/i)
        const daysMatch = time_range.match(/(\d+)\s*days?/i)

        if (hoursMatch) {
          const hours = parseInt(hoursMatch[1])
          query += `^sys_created_on>javascript:gs.hoursAgo(${hours})`
        } else if (daysMatch) {
          const days = parseInt(daysMatch[1])
          query += `^sys_created_on>javascript:gs.daysAgo(${days})`
        }
      }

      const alertsResponse = await client.get(`/api/now/table/em_alert?sysparm_query=${query}&sysparm_limit=50`)
      const alerts = alertsResponse.data.result || []

      // Get correlation rules applied
      const rulesResponse = await client.get(`/api/now/table/em_alert_rule?sysparm_query=active=true&sysparm_limit=50`)
      const rules = rulesResponse.data.result || []

      result = {
        summary: {
          active_alerts: alerts.length,
          time_range: time_range || "All time",
          correlation_rules_active: rules.length,
        },
        alerts: alerts.map((a: any) => ({
          sys_id: a.sys_id,
          number: a.number,
          severity: a.severity,
          description: a.description,
          event_count: a.event_count || 0,
        })),
        correlation_rules: rules.map((r: any) => ({
          name: r.name,
          condition: r.condition,
          active: r.active === "true",
        })),
      }
    }

    return createSuccessResult(result)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
