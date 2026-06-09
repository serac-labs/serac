/**
 * snow_impact_analysis - Perform impact analysis for Configuration Items
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_impact_analysis",
  description: "Perform impact analysis to identify affected services when a CI changes",
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "impact-analysis",
  use_cases: ["cmdb", "impact", "services"],
  complexity: "advanced",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      ci_id: { type: "string", description: "CI sys_id to analyze" },
      depth: { type: "number", description: "Relationship depth to analyze", default: 3 },
      include_services: { type: "boolean", description: "Include business services", default: true },
    },
    required: ["ci_id"],
  },
}

async function getRelatedCIs(
  client: any,
  ciId: string,
  depth: number,
  visited: Set<string> = new Set(),
): Promise<any[]> {
  if (depth <= 0 || visited.has(ciId)) {
    return []
  }

  visited.add(ciId)
  const related: any[] = []

  try {
    // Get direct relationships
    const relQuery = `parent=${ciId}^ORchild=${ciId}`
    const relResponse = await client.get(`/api/now/table/cmdb_rel_ci?sysparm_query=${relQuery}&sysparm_limit=100`)
    const relationships = relResponse.data.result || []

    for (const rel of relationships) {
      const relatedId = rel.parent === ciId ? rel.child : rel.parent

      if (!visited.has(relatedId.value || relatedId)) {
        const relatedCI = {
          sys_id: relatedId.value || relatedId,
          relationship_type: rel.type?.display_value || rel.type,
          depth: 4 - depth,
        }
        related.push(relatedCI)

        // Recursively get related CIs
        if (depth > 1) {
          const nestedRelated = await getRelatedCIs(client, relatedId.value || relatedId, depth - 1, visited)
          related.push(...nestedRelated)
        }
      }
    }
  } catch (error) {
    console.error("Error getting related CIs:", error)
  }

  return related
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { ci_id, depth = 3, include_services = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Get the CI details
    const ciResponse = await client.get(`/api/now/table/cmdb_ci/${ci_id}`)
    const ci = ciResponse.data.result

    if (!ci) {
      return createErrorResult("CI not found")
    }

    // Perform impact analysis by traversing relationships
    const visited = new Set<string>()
    const relatedCIs = await getRelatedCIs(client, ci_id, depth, visited)

    // Get business services if requested
    let services: any[] = []
    if (include_services) {
      const serviceQuery = `cmdb_ci=${ci_id}`
      const serviceResponse = await client.get(
        `/api/now/table/cmdb_ci_service?sysparm_query=${serviceQuery}&sysparm_limit=50`,
      )
      services = serviceResponse.data.result || []
    }

    // Calculate impact metrics
    const directlyAffected = relatedCIs.filter((r) => r.depth === 1).length
    const indirectlyAffected = relatedCIs.filter((r) => r.depth > 1).length

    const riskLevel = directlyAffected > 10 ? "High" : directlyAffected > 5 ? "Medium" : "Low"

    const result = {
      ci: {
        sys_id: ci.sys_id,
        name: ci.name,
        class: ci.sys_class_name,
      },
      impact: {
        directly_affected: directlyAffected,
        indirectly_affected: indirectlyAffected,
        total_affected: relatedCIs.length,
        risk_level: riskLevel,
        analysis_depth: depth,
      },
      affected_cis: relatedCIs,
      business_services: services,
      recommendations: [
        riskLevel === "High" ? "Schedule maintenance window during off-hours" : "Standard change approval process",
        "Notify affected service owners",
        "Prepare rollback plan",
        "Monitor related CIs after change",
      ],
    }

    return createSuccessResult(result)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
