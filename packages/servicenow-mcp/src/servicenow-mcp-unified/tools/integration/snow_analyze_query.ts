/**
 * snow_analyze_query - Query optimization and analysis
 *
 * Analyze ServiceNow queries for performance bottlenecks, suggest
 * optimizations, and provide index recommendations.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_analyze_query",
  description: "Analyze and optimize ServiceNow queries for performance",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "optimization",
  use_cases: ["integration", "performance", "optimization"],
  complexity: "advanced",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Query operation - only reads data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Table name to query",
      },
      query: {
        type: "string",
        description: "Encoded query string to analyze",
      },
      analyze_indexes: {
        type: "boolean",
        description: "Check for index usage and recommendations",
        default: true,
      },
      suggest_optimizations: {
        type: "boolean",
        description: "Provide query optimization suggestions",
        default: true,
      },
    },
    required: ["table", "query"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, query, analyze_indexes = true, suggest_optimizations = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    const analysis: any = {
      query,
      table,
      issues: [],
      suggestions: [],
      index_analysis: null,
      estimated_performance: "unknown",
    }

    // Parse query conditions
    const conditions = query.split("^").filter((c: string) => c.length > 0)
    analysis.condition_count = conditions.length

    // Check for common anti-patterns
    const antiPatterns = []

    // 1. Check for LIKE queries (slow)
    if (query.includes("LIKE")) {
      antiPatterns.push({
        type: "LIKE_QUERY",
        severity: "medium",
        description: "LIKE queries can be slow on large tables",
        suggestion: "Consider using indexed text search or exact matches where possible",
      })
    }

    // 2. Check for OR conditions (can prevent index usage)
    const orCount = (query.match(/\^OR/g) || []).length
    if (orCount > 2) {
      antiPatterns.push({
        type: "EXCESSIVE_OR",
        severity: "high",
        description: `Query contains ${orCount} OR conditions, which may prevent index usage`,
        suggestion: "Consider breaking into multiple queries or restructuring conditions",
      })
    }

    // 3. Check for inequality conditions on multiple fields
    const inequalities = conditions.filter((c: string) => c.includes("!=") || c.includes(">") || c.includes("<"))
    if (inequalities.length > 3) {
      antiPatterns.push({
        type: "MULTIPLE_INEQUALITIES",
        severity: "medium",
        description: "Multiple inequality conditions can be inefficient",
        suggestion: "Consider using equality conditions or range queries where possible",
      })
    }

    // 4. Check for query on reference fields without joins
    const refFields = conditions.filter((c: string) => c.includes("."))
    if (refFields.length > 0) {
      analysis.uses_dot_walking = true
      antiPatterns.push({
        type: "DOT_WALKING",
        severity: "high",
        description: "Query uses dot-walking which requires table joins",
        suggestion: "Minimize dot-walking or ensure reference fields are indexed",
        affected_conditions: refFields,
      })
    }

    analysis.anti_patterns = antiPatterns

    // Get table record count for performance estimation
    // Use standard table API with count instead of stats API (more compatible)
    var totalRecords = 0
    try {
      const countResponse = await client.get(`/api/now/table/${table}`, {
        params: {
          sysparm_query: query,
          sysparm_limit: 1,
          sysparm_fields: "sys_id",
        },
        headers: {
          "X-Total-Count": "true",
        },
      })
      totalRecords = parseInt(countResponse.headers["x-total-count"] || "0")
    } catch (countError: any) {
      // If count fails, continue without it
      console.warn("Could not get record count:", countError.message)
    }
    analysis.matching_records = totalRecords

    // Analyze indexes if requested
    if (analyze_indexes) {
      try {
        const indexResponse = await client.get("/api/now/table/sys_db_index", {
          params: {
            sysparm_query: `table=${table}^active=true`,
            sysparm_fields: "name,indexed_column,unique",
            sysparm_limit: 100,
          },
        })

        const indexes = indexResponse.data.result || []
        const indexedFields = indexes.map((idx: any) => idx.indexed_column?.value || idx.indexed_column)

        // Check which query fields are indexed
        const queryFields = conditions.map((c: string) => c.split(/[!=<>]/)[0])
        const indexedQueryFields = queryFields.filter((f: string) => indexedFields.includes(f))
        const unindexedQueryFields = queryFields.filter((f: string) => !indexedFields.includes(f))

        analysis.index_analysis = {
          total_indexes: indexes.length,
          indexed_query_fields: indexedQueryFields,
          unindexed_query_fields: unindexedQueryFields,
          index_coverage: queryFields.length > 0 ? indexedQueryFields.length / queryFields.length : 0,
        }

        if (unindexedQueryFields.length > 0) {
          analysis.suggestions.push({
            type: "INDEX_RECOMMENDATION",
            priority: "high",
            description: `Consider adding indexes for: ${unindexedQueryFields.join(", ")}`,
            estimated_improvement: totalRecords > 10000 ? "significant" : "moderate",
          })
        }
      } catch (indexError: any) {
        // Index analysis not available - continue without it
        analysis.index_analysis = {
          error: "Index analysis not available",
          reason: indexError.message,
        }
      }
    }

    // Estimate performance
    if (totalRecords < 1000 && antiPatterns.length === 0) {
      analysis.estimated_performance = "excellent"
    } else if (totalRecords < 10000 && antiPatterns.length <= 1) {
      analysis.estimated_performance = "good"
    } else if (totalRecords < 100000 && antiPatterns.length <= 2) {
      analysis.estimated_performance = "moderate"
    } else {
      analysis.estimated_performance = "poor"
    }

    // Optimization suggestions
    if (suggest_optimizations) {
      if (analysis.estimated_performance === "poor") {
        analysis.suggestions.push({
          type: "QUERY_RESTRUCTURE",
          priority: "critical",
          description: "Query may perform poorly on large datasets",
          actions: [
            "Add appropriate indexes",
            "Reduce number of OR conditions",
            "Minimize dot-walking",
            "Consider query caching",
          ],
        })
      }

      if (conditions.length > 10) {
        analysis.suggestions.push({
          type: "COMPLEXITY_REDUCTION",
          priority: "medium",
          description: "Query has many conditions which may be simplified",
          suggestion: "Review if all conditions are necessary",
        })
      }
    }

    return createSuccessResult({
      analysis,
      performance_rating: analysis.estimated_performance,
      issues_found: antiPatterns.length + (analysis.index_analysis?.unindexed_query_fields?.length || 0),
      optimization_potential: analysis.suggestions.length > 0,
      recommendations: analysis.suggestions,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
