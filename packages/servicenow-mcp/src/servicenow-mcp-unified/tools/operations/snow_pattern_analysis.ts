/**
 * snow_pattern_analysis - Analyze patterns
 *
 * Analyzes patterns across incidents, requests, and problems to identify trends, common issues, and improvement opportunities.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_pattern_analysis",
  description:
    "Analyzes patterns across incidents, requests, and problems to identify trends, common issues, and improvement opportunities",
  // Metadata for tool discovery (not sent to LLM)
  category: "reporting",
  subcategory: "analytics",
  use_cases: ["pattern-analysis", "trends", "data-analysis"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      analysis_type: {
        type: "string",
        description: "Type of pattern analysis",
        enum: ["incident_patterns", "request_trends", "problem_root_causes", "user_behavior"],
      },
      timeframe: {
        type: "string",
        description: "Time period for analysis",
        enum: ["day", "week", "month", "quarter"],
        default: "week",
      },
    },
    required: ["analysis_type"],
  },
}

function getDateFilter(timeframe: string): string {
  const filters: Record<string, string> = {
    day: "ONToday@javascript:gs.daysAgoStart(0)@javascript:gs.daysAgoEnd(0)",
    week: "ONLast 7 days@javascript:gs.daysAgoStart(7)@javascript:gs.daysAgoEnd(0)",
    month: "ONLast 30 days@javascript:gs.daysAgoStart(30)@javascript:gs.daysAgoEnd(0)",
    quarter: "ONLast 90 days@javascript:gs.daysAgoStart(90)@javascript:gs.daysAgoEnd(0)",
  }
  return filters[timeframe] || filters.week
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { analysis_type, timeframe = "week" } = args

  try {
    const client = await getAuthenticatedClient(context)
    const dateFilter = getDateFilter(timeframe)

    let patterns: any = {
      analysis_type,
      timeframe,
      generated_at: new Date().toISOString(),
    }

    switch (analysis_type) {
      case "incident_patterns":
        patterns = { ...patterns, ...(await analyzeIncidentPatterns(client, dateFilter)) }
        break

      case "request_trends":
        patterns = { ...patterns, ...(await analyzeRequestTrends(client, dateFilter)) }
        break

      case "problem_root_causes":
        patterns = { ...patterns, ...(await analyzeProblemRootCauses(client, dateFilter)) }
        break

      case "user_behavior":
        patterns = { ...patterns, ...(await analyzeUserBehavior(client, dateFilter)) }
        break

      default:
        return createErrorResult(`Unknown analysis type: ${analysis_type}`)
    }

    return createSuccessResult({ patterns }, { analysis_type, timeframe })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

async function analyzeIncidentPatterns(client: any, dateFilter: string): Promise<any> {
  const response = await client.get("/api/now/table/incident", {
    params: {
      sysparm_query: `sys_created_on${dateFilter}`,
      sysparm_limit: 1000,
    },
  })

  const incidents = response.data.result || []

  const patterns = {
    by_category: new Map<string, number>(),
    by_priority: new Map<string, number>(),
    by_state: new Map<string, number>(),
    by_hour: new Map<number, number>(),
    common_keywords: new Map<string, number>(),
  }

  incidents.forEach((incident: any) => {
    // Category
    const category = incident.category || "uncategorized"
    patterns.by_category.set(category, (patterns.by_category.get(category) || 0) + 1)

    // Priority
    const priority = incident.priority || "unknown"
    patterns.by_priority.set(priority, (patterns.by_priority.get(priority) || 0) + 1)

    // State
    const state = incident.state || "unknown"
    patterns.by_state.set(state, (patterns.by_state.get(state) || 0) + 1)

    // Time patterns
    if (incident.sys_created_on) {
      const hour = new Date(incident.sys_created_on).getHours()
      patterns.by_hour.set(hour, (patterns.by_hour.get(hour) || 0) + 1)
    }

    // Keywords
    const description = (incident.short_description || "").toLowerCase()
    const keywords = description.split(/\s+/).filter((word: string) => word.length > 3)
    keywords.slice(0, 5).forEach((keyword: string) => {
      patterns.common_keywords.set(keyword, (patterns.common_keywords.get(keyword) || 0) + 1)
    })
  })

  return {
    total_incidents: incidents.length,
    patterns: {
      by_category: Object.fromEntries(patterns.by_category),
      by_priority: Object.fromEntries(patterns.by_priority),
      by_state: Object.fromEntries(patterns.by_state),
      peak_hours: Array.from(patterns.by_hour.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([hour, count]) => ({ hour, count })),
      top_keywords: Array.from(patterns.common_keywords.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([keyword, count]) => ({ keyword, count })),
    },
  }
}

async function analyzeRequestTrends(client: any, dateFilter: string): Promise<any> {
  const response = await client.get("/api/now/table/sc_request", {
    params: {
      sysparm_query: `sys_created_on${dateFilter}`,
      sysparm_limit: 1000,
    },
  })

  const requests = response.data.result || []

  const trends = {
    by_state: new Map<string, number>(),
    by_approval: new Map<string, number>(),
  }

  requests.forEach((request: any) => {
    const state = request.request_state || "unknown"
    trends.by_state.set(state, (trends.by_state.get(state) || 0) + 1)

    const approval = request.approval || "unknown"
    trends.by_approval.set(approval, (trends.by_approval.get(approval) || 0) + 1)
  })

  return {
    total_requests: requests.length,
    trends: {
      by_state: Object.fromEntries(trends.by_state),
      by_approval_status: Object.fromEntries(trends.by_approval),
    },
  }
}

async function analyzeProblemRootCauses(client: any, dateFilter: string): Promise<any> {
  const response = await client.get("/api/now/table/problem", {
    params: {
      sysparm_query: `sys_created_on${dateFilter}`,
      sysparm_limit: 100,
    },
  })

  const problems = response.data.result || []

  const rootCauses = {
    by_category: new Map<string, number>(),
    by_state: new Map<string, number>(),
  }

  problems.forEach((problem: any) => {
    const category = problem.category || "uncategorized"
    rootCauses.by_category.set(category, (rootCauses.by_category.get(category) || 0) + 1)

    const state = problem.state || "unknown"
    rootCauses.by_state.set(state, (rootCauses.by_state.get(state) || 0) + 1)
  })

  return {
    total_problems: problems.length,
    root_causes: {
      by_category: Object.fromEntries(rootCauses.by_category),
      by_state: Object.fromEntries(rootCauses.by_state),
    },
  }
}

async function analyzeUserBehavior(client: any, dateFilter: string): Promise<any> {
  const incidentsResponse = await client.get("/api/now/table/incident", {
    params: {
      sysparm_query: `sys_created_on${dateFilter}`,
      sysparm_limit: 500,
      sysparm_fields: "caller_id",
    },
  })

  const incidents = incidentsResponse.data.result || []
  const userIncidents = new Map<string, number>()

  incidents.forEach((inc: any) => {
    const userId = inc.caller_id?.value || inc.caller_id
    if (userId) {
      userIncidents.set(userId, (userIncidents.get(userId) || 0) + 1)
    }
  })

  return {
    user_activities: {
      total_incidents: incidents.length,
      unique_users: userIncidents.size,
      avg_incidents_per_user:
        userIncidents.size > 0 ? Math.round((incidents.length / userIncidents.size) * 10) / 10 : 0,
    },
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
