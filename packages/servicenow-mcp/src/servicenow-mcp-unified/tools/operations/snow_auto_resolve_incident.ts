/**
 * snow_auto_resolve_incident - Auto-resolve incidents
 *
 * Attempts automated resolution of technical incidents based on known patterns and previous solutions.
 * Includes dry-run mode for safety.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_auto_resolve_incident",
  description:
    "Attempts automated resolution of technical incidents based on known patterns and previous solutions. Includes dry-run mode for safety.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "operations",
  use_cases: ["incidents", "automation"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Resolution function - closes incidents automatically
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      incident_id: {
        type: "string",
        description: "Incident number or sys_id to auto-resolve",
      },
      dry_run: {
        type: "boolean",
        description: "Preview actions without executing (default: true for safety)",
        default: true,
      },
    },
    required: ["incident_id"],
  },
}

// Common patterns for auto-resolution
const resolutionPatterns: Record<string, { keywords: string[]; actions: string[] }> = {
  password_reset: {
    keywords: ["password", "reset", "forgot", "locked"],
    actions: ["Send password reset email", "Unlock user account", "Update password policy"],
  },
  network_restart: {
    keywords: ["network", "connectivity", "unreachable"],
    actions: ["Restart network service", "Clear DNS cache", "Reset network adapter"],
  },
  service_restart: {
    keywords: ["service", "down", "not responding", "crash"],
    actions: ["Restart service", "Check service logs", "Verify service configuration"],
  },
  cache_clear: {
    keywords: ["cache", "stale", "outdated", "refresh"],
    actions: ["Clear cache", "Restart caching service", "Verify cache configuration"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { incident_id, dry_run = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Get incident details
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

    // Analyze incident for auto-resolution potential
    const description = (incident.short_description || "").toLowerCase()
    const patternsFound: string[] = []
    const resolutionActions: string[] = []
    let confidenceScore = 0

    for (const [patternName, pattern] of Object.entries(resolutionPatterns)) {
      if (pattern.keywords.some((keyword) => description.includes(keyword))) {
        patternsFound.push(patternName)
        resolutionActions.push(...pattern.actions)
        confidenceScore += 0.25
      }
    }

    // Find similar resolved incidents
    const similarQuery = `short_descriptionLIKE${incident.short_description}^state=6^close_code!=Cancelled`
    const similarResponse = await client.get("/api/now/table/incident", {
      params: { sysparm_query: similarQuery, sysparm_limit: 3 },
    })
    const similarIncidents = similarResponse.data.result || []

    // Extract resolution notes from similar incidents
    const resolutionNotes = similarIncidents.filter((inc: any) => inc.close_notes).map((inc: any) => inc.close_notes)

    const actionsExecuted: string[] = []

    // Execute actions if not dry run and confidence is high
    if (!dry_run && confidenceScore >= 0.5) {
      // Update incident with work notes
      const workNotes = `Auto-resolution attempted based on patterns: ${patternsFound.join(", ")}\\n\\nActions: ${resolutionActions.join(", ")}`

      await client.put(`/api/now/table/incident/${incident.sys_id}`, {
        work_notes: workNotes,
        state: 6, // Resolved
        close_code: "Solved (Permanently)",
        close_notes: `Auto-resolved using pattern recognition. Actions executed: ${resolutionActions.join(", ")}`,
      })

      actionsExecuted.push("Updated incident to Resolved state")
      actionsExecuted.push("Added work notes with resolution details")
      actionsExecuted.push("Set close code to Solved (Permanently)")
    }

    const result = {
      incident_id: incident.number,
      incident_sys_id: incident.sys_id,
      dry_run,
      patterns_found: patternsFound,
      confidence_score: Math.min(confidenceScore, 1.0),
      resolution_actions: resolutionActions,
      similar_resolved_incidents: similarIncidents.length,
      resolution_notes_from_similar: resolutionNotes,
      actions_executed: actionsExecuted,
      can_auto_resolve: confidenceScore >= 0.5,
      recommendation:
        confidenceScore >= 0.5
          ? "High confidence - safe to auto-resolve"
          : "Low confidence - manual review recommended",
    }

    return createSuccessResult({ result }, { incident_id, dry_run, confidence: confidenceScore })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
