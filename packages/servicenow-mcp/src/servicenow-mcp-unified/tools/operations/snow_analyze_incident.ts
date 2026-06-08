/**
 * snow_analyze_incident - Analyze specific incidents
 *
 * Analyzes incidents with pattern recognition, similar incident matching, and automated resolution suggestions.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_analyze_incident",
  description:
    "Analyzes specific incidents with pattern recognition, similar incident matching, and automated resolution suggestions",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "operations",
  use_cases: ["incidents", "analysis"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Analysis operation - reads data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      incident_id: {
        type: "string",
        description: "Incident number or sys_id to analyze",
      },
      include_similar: {
        type: "boolean",
        description: "Include similar incidents in analysis",
        default: true,
      },
      suggest_resolution: {
        type: "boolean",
        description: "Generate automated resolution suggestions",
        default: true,
      },
    },
    required: ["incident_id"],
  },
}

// Common patterns for incident analysis
const commonPatterns: Record<string, { keywords: string[]; solutions: string[] }> = {
  network_issues: {
    keywords: ["network", "connectivity", "ping", "dns", "timeout", "unreachable"],
    solutions: ["Check network connectivity", "Verify DNS resolution", "Test ping to server", "Review firewall rules"],
  },
  database_issues: {
    keywords: ["database", "connection", "sql", "timeout", "deadlock", "performance"],
    solutions: [
      "Check database connection",
      "Review connection pool settings",
      "Analyze query performance",
      "Check for blocking processes",
    ],
  },
  application_errors: {
    keywords: ["application", "error", "exception", "crash", "memory", "cpu"],
    solutions: [
      "Check application logs",
      "Review memory usage",
      "Analyze CPU utilization",
      "Restart application service",
    ],
  },
  auth_issues: {
    keywords: ["authentication", "login", "password", "ldap", "sso", "unauthorized"],
    solutions: [
      "Reset user password",
      "Check LDAP connectivity",
      "Verify SSO configuration",
      "Review user permissions",
    ],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { incident_id, include_similar = true, suggest_resolution = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Get incident details - try by number first, then sys_id
    let query = `number=${incident_id}`
    let response = await client.get("/api/now/table/incident", {
      params: { sysparm_query: query, sysparm_limit: 1 },
    })

    if (!response.data.result || response.data.result.length === 0) {
      query = `sys_id=${incident_id}`
      response = await client.get("/api/now/table/incident", {
        params: { sysparm_query: query, sysparm_limit: 1 },
      })
    }

    if (!response.data.result || response.data.result.length === 0) {
      return createErrorResult(`Incident ${incident_id} not found`)
    }

    const incident = response.data.result[0]

    // Perform pattern analysis
    const patternsFound: string[] = []
    const suggestedResolution: string[] = []
    let confidenceScore = 0

    const description = (incident.short_description || "").toLowerCase()
    for (const [patternName, pattern] of Object.entries(commonPatterns)) {
      if (pattern.keywords.some((keyword) => description.includes(keyword))) {
        patternsFound.push(patternName)
        suggestedResolution.push(...pattern.solutions)
        confidenceScore += 0.2
      }
    }

    // Root cause analysis
    const rootCauseAnalysis = generateRootCauseAnalysis(patternsFound)

    // Automated actions
    const automatedActions = generateAutomatedActions(patternsFound)

    // Find similar incidents if requested
    let similarIncidents: any[] = []
    if (include_similar && patternsFound.length > 0) {
      const similarQuery = `short_descriptionLIKE${incident.short_description}^sys_id!=${incident.sys_id}^state=6`
      const similarResponse = await client.get("/api/now/table/incident", {
        params: { sysparm_query: similarQuery, sysparm_limit: 5 },
      })
      similarIncidents = similarResponse.data.result || []
    }

    // Search knowledge base
    let knowledgeArticles: any[] = []
    if (suggest_resolution) {
      const kbQuery = `textLIKE${incident.short_description}^workflow_state=published`
      const kbResponse = await client.get("/api/now/table/kb_knowledge", {
        params: { sysparm_query: kbQuery, sysparm_limit: 3 },
      })
      knowledgeArticles = kbResponse.data.result || []
    }

    const analysis = {
      incident_id: incident.number,
      incident_sys_id: incident.sys_id,
      patterns_found: patternsFound,
      root_cause_analysis: rootCauseAnalysis,
      suggested_resolution: suggestedResolution,
      confidence_score: Math.min(confidenceScore, 1.0),
      similar_incidents: similarIncidents.map((inc) => ({
        number: inc.number,
        short_description: inc.short_description,
        state: inc.state,
      })),
      knowledge_articles: knowledgeArticles.map((kb) => ({
        number: kb.number,
        short_description: kb.short_description,
        text: kb.text ? kb.text.substring(0, 200) + "..." : "",
      })),
      automated_actions: automatedActions,
    }

    return createSuccessResult({ analysis }, { incident_id, patterns_found: patternsFound.length })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function generateRootCauseAnalysis(patterns: string[]): string {
  if (patterns.length === 0) {
    return "No specific patterns detected. Manual investigation required."
  }

  const analysis: string[] = []

  if (patterns.includes("network_issues")) {
    analysis.push("Network connectivity issue detected. Check network infrastructure, DNS, and firewall rules.")
  }

  if (patterns.includes("database_issues")) {
    analysis.push(
      "Database connectivity or performance issue detected. Check database server, connection pools, and query performance.",
    )
  }

  if (patterns.includes("application_errors")) {
    analysis.push("Application error detected. Check application logs, resource utilization, and service status.")
  }

  if (patterns.includes("auth_issues")) {
    analysis.push("Authentication issue detected. Check user credentials, LDAP/SSO configuration, and permissions.")
  }

  return analysis.join(" ")
}

function generateAutomatedActions(patterns: string[]): string[] {
  const actions: string[] = []

  if (patterns.includes("network_issues")) {
    actions.push("Execute network connectivity test", "Check DNS resolution", "Verify firewall rules")
  }

  if (patterns.includes("database_issues")) {
    actions.push("Test database connectivity", "Check database performance metrics", "Review connection pool status")
  }

  if (patterns.includes("application_errors")) {
    actions.push("Restart application service", "Check application logs", "Monitor resource utilization")
  }

  if (patterns.includes("auth_issues")) {
    actions.push("Reset user session", "Verify user permissions", "Check authentication service status")
  }

  return actions
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
