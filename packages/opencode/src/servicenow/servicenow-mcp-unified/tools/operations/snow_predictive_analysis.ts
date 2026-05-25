/**
 * snow_predictive_analysis - Predictive analysis
 *
 * Provides predictive analysis for incident volumes, system failures, and resource issues based on historical patterns.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_predictive_analysis",
  description:
    "Provides predictive analysis for incident volumes, system failures, and resource issues based on historical patterns",
  // Metadata for tool discovery (not sent to LLM)
  category: "ml-analytics",
  subcategory: "prediction",
  use_cases: ["prediction", "analytics"],
  complexity: "advanced",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      prediction_type: {
        type: "string",
        description: "Type of prediction",
        enum: ["incident_volume", "system_failure", "resource_exhaustion", "user_impact"],
      },
      timeframe: {
        type: "string",
        description: "Prediction timeframe",
        enum: ["day", "week", "month"],
        default: "week",
      },
    },
    required: ["prediction_type"],
  },
}

function getHistoricalDateFilter(timeframe: string): string {
  const filters: Record<string, string> = {
    day: "ONLast 7 days@javascript:gs.daysAgoStart(7)@javascript:gs.daysAgoEnd(0)",
    week: "ONLast 30 days@javascript:gs.daysAgoStart(30)@javascript:gs.daysAgoEnd(0)",
    month: "ONLast 90 days@javascript:gs.daysAgoStart(90)@javascript:gs.daysAgoEnd(0)",
  }
  return filters[timeframe] || filters.week
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { prediction_type, timeframe = "week" } = args

  try {
    const client = await getAuthenticatedClient(context)
    const dateFilter = getHistoricalDateFilter(timeframe)

    let predictions: any = {
      prediction_type,
      timeframe,
      generated_at: new Date().toISOString(),
      analysis_method: "trend_analysis",
    }

    switch (prediction_type) {
      case "incident_volume":
        predictions = { ...predictions, ...(await predictIncidentVolume(client, dateFilter, timeframe)) }
        break

      case "system_failure":
        predictions = { ...predictions, ...(await predictSystemFailure(client, dateFilter, timeframe)) }
        break

      case "resource_exhaustion":
        predictions = { ...predictions, ...(await predictResourceExhaustion(client, dateFilter, timeframe)) }
        break

      case "user_impact":
        predictions = { ...predictions, ...(await predictUserImpact(client, dateFilter, timeframe)) }
        break

      default:
        return createErrorResult(`Unknown prediction type: ${prediction_type}`)
    }

    return createSuccessResult({ predictions }, { prediction_type, timeframe })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

async function predictIncidentVolume(client: any, dateFilter: string, timeframe: string): Promise<any> {
  const response = await client.get("/api/now/table/incident", {
    params: {
      sysparm_query: `sys_created_on${dateFilter}`,
      sysparm_limit: 1000,
      sysparm_fields: "sys_created_on,priority",
    },
  })

  const incidents = response.data.result || []
  const dailyVolumes = new Map<string, number>()

  incidents.forEach((inc: any) => {
    if (inc.sys_created_on) {
      const date = inc.sys_created_on.split(" ")[0]
      dailyVolumes.set(date, (dailyVolumes.get(date) || 0) + 1)
    }
  })

  const volumes = Array.from(dailyVolumes.values())
  const avgVolume = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0

  return {
    historical_data: {
      total_incidents: incidents.length,
      average_daily_volume: Math.round(avgVolume),
      peak_volume: Math.max(...volumes, 0),
      low_volume: Math.min(...volumes, 0),
    },
    prediction: {
      expected_volume: Math.round(avgVolume),
      confidence: volumes.length >= 7 ? "high" : "low",
      interpretation: `Based on ${volumes.length} days of data, expecting approximately ${Math.round(avgVolume)} incidents per ${timeframe}`,
    },
  }
}

async function predictSystemFailure(client: any, dateFilter: string, timeframe: string): Promise<any> {
  const response = await client.get("/api/now/table/incident", {
    params: {
      sysparm_query: `sys_created_on${dateFilter}^priority=1`,
      sysparm_limit: 500,
    },
  })

  const criticalIncidents = response.data.result || []

  return {
    historical_data: {
      critical_incidents: criticalIncidents.length,
    },
    prediction: {
      risk_level: criticalIncidents.length > 10 ? "high" : "low",
      interpretation: `Based on ${criticalIncidents.length} critical incidents, system failure risk is ${criticalIncidents.length > 10 ? "elevated" : "normal"}`,
    },
  }
}

async function predictResourceExhaustion(client: any, dateFilter: string, timeframe: string): Promise<any> {
  const requestsResponse = await client.get("/api/now/table/sc_request", {
    params: {
      sysparm_query: `sys_created_on${dateFilter}`,
      sysparm_limit: 1000,
    },
  })

  const requests = requestsResponse.data.result || []

  return {
    historical_data: {
      total_requests: requests.length,
    },
    prediction: {
      risk_level: requests.length > 500 ? "medium" : "low",
      interpretation: `Based on ${requests.length} service requests, resource demand is ${requests.length > 500 ? "increasing" : "stable"}`,
    },
  }
}

async function predictUserImpact(client: any, dateFilter: string, timeframe: string): Promise<any> {
  const response = await client.get("/api/now/table/incident", {
    params: {
      sysparm_query: `sys_created_on${dateFilter}`,
      sysparm_limit: 1000,
      sysparm_fields: "caller_id,state",
    },
  })

  const incidents = response.data.result || []
  const uniqueUsers = new Set(incidents.map((inc: any) => inc.caller_id?.value || inc.caller_id).filter(Boolean))

  return {
    historical_data: {
      total_incidents: incidents.length,
      affected_users: uniqueUsers.size,
    },
    prediction: {
      impact_level: uniqueUsers.size > 50 ? "high" : "medium",
      interpretation: `${uniqueUsers.size} unique users affected. User impact is ${uniqueUsers.size > 50 ? "widespread" : "localized"}`,
    },
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
