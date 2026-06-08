/**
 * snow_fuzzy_search
 *
 * Perform intelligent fuzzy search across ServiceNow tables using
 * multiple matching strategies: LIKE queries, CONTAINS, and
 * Levenshtein-based relevance scoring.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_fuzzy_search",
  description:
    "Perform fuzzy search across tables with relevance scoring. Returns sys_id + name + relevance_score for each match. Uses LIKE/CONTAINS queries and ranks by similarity.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "search",
  use_cases: ["fuzzy-search", "text-search", "search", "find-similar"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Search operation - reads data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query - will match against name, label, and description fields",
      },
      tables: {
        type: "array",
        items: { type: "string" },
        description: 'Tables to search (e.g., ["sys_db_object", "sys_script_include"])',
      },
      search_fields: {
        type: "array",
        items: { type: "string" },
        description: "Fields to search within each table (default: name, label, description)",
        default: ["name", "label", "description"],
      },
      threshold: {
        type: "number",
        default: 0.3,
        description: "Minimum similarity score (0-1) to include in results. Lower = more results.",
      },
      limit: {
        type: "number",
        default: 20,
        description: "Maximum results per table",
      },
    },
    required: ["query", "tables"],
  },
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const s1 = str1.toLowerCase()
  const s2 = str2.toLowerCase()

  if (s1.length === 0) return s2.length
  if (s2.length === 0) return s1.length

  const matrix: number[][] = []

  for (let i = 0; i <= s1.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= s2.length; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost, // substitution
      )
    }
  }

  return matrix[s1.length][s2.length]
}

/**
 * Calculate similarity score (0-1) between query and a field value
 */
function calculateSimilarity(query: string, value: string): number {
  if (!value) return 0

  const q = query.toLowerCase()
  const v = value.toLowerCase()

  // Exact match
  if (v === q) return 1.0

  // Contains exact query
  if (v.includes(q)) return 0.9

  // Query contains the value (partial match)
  if (q.includes(v)) return 0.7

  // Word-level matching
  const queryWords = q.split(/[\s_\-\.]+/)
  const valueWords = v.split(/[\s_\-\.]+/)
  let matchedWords = 0

  for (const qWord of queryWords) {
    for (const vWord of valueWords) {
      if (vWord.includes(qWord) || qWord.includes(vWord)) {
        matchedWords++
        break
      }
    }
  }

  const wordScore = queryWords.length > 0 ? matchedWords / queryWords.length : 0
  if (wordScore > 0.5) return 0.5 + wordScore * 0.3

  // Levenshtein-based similarity for close matches
  const distance = levenshteinDistance(q, v)
  const maxLen = Math.max(q.length, v.length)
  const levenshteinScore = maxLen > 0 ? 1 - distance / maxLen : 0

  return levenshteinScore
}

/**
 * Calculate overall relevance score for a record
 */
function calculateRelevanceScore(
  query: string,
  record: any,
  searchFields: string[],
): { score: number; matchedField: string } {
  let maxScore = 0
  let matchedField = ""

  for (const field of searchFields) {
    const value = record[field]
    if (value) {
      const score = calculateSimilarity(query, String(value))
      if (score > maxScore) {
        maxScore = score
        matchedField = field
      }
    }
  }

  return { score: maxScore, matchedField }
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { query, tables, search_fields = ["name", "label", "description"], threshold = 0.3, limit = 20 } = args

  if (!query || query.trim().length === 0) {
    return createErrorResult("Search query cannot be empty")
  }

  if (!tables || tables.length === 0) {
    return createErrorResult("At least one table must be specified")
  }

  try {
    const client = await getAuthenticatedClient(context)
    const allResults: any[] = []
    const tableResults: any[] = []

    // Build LIKE query for each search field
    // This gets candidates from ServiceNow, then we score them locally
    const buildSearchQuery = (fields: string[], searchTerm: string): string => {
      const conditions = fields.map((field) => `${field}LIKE${searchTerm}`)
      return conditions.join("^NQ") // NQ = OR in ServiceNow
    }

    // Search each table in parallel for better performance
    const searchPromises = tables.map(async (table: string) => {
      try {
        // First, check what fields exist on this table
        const searchQuery = buildSearchQuery(search_fields, query)

        const response = await client.get(`/api/now/table/${table}`, {
          params: {
            sysparm_query: searchQuery,
            sysparm_limit: limit * 2, // Get more candidates for scoring
            sysparm_fields: `sys_id,${search_fields.join(",")},sys_created_on,sys_updated_on`,
          },
          timeout: 15000, // 15 second timeout per table
        })

        if (!response.data.result || response.data.result.length === 0) {
          return { table, results: [], count: 0 }
        }

        // Score and filter results
        const scoredResults = response.data.result
          .map((record: any) => {
            const { score, matchedField } = calculateRelevanceScore(query, record, search_fields)
            return {
              ...record,
              _relevance_score: score,
              _matched_field: matchedField,
              _table: table,
            }
          })
          .filter((r: any) => r._relevance_score >= threshold)
          .sort((a: any, b: any) => b._relevance_score - a._relevance_score)
          .slice(0, limit)

        return {
          table,
          results: scoredResults,
          count: scoredResults.length,
        }
      } catch (tableError: any) {
        // Return empty results for tables that error (might not exist or no access)
        return {
          table,
          results: [],
          count: 0,
          error: tableError.message,
        }
      }
    })

    const searchResults = await Promise.all(searchPromises)

    // Aggregate results
    for (const result of searchResults) {
      if (result.count > 0) {
        tableResults.push({
          table: result.table,
          count: result.count,
          matches: result.results.map((r: any) => ({
            sys_id: r.sys_id,
            name: r.name || r.label || r.sys_id,
            label: r.label,
            description: r.description,
            relevance_score: Math.round(r._relevance_score * 100) / 100,
            matched_field: r._matched_field,
            created: r.sys_created_on,
            updated: r.sys_updated_on,
          })),
        })
        allResults.push(...result.results)
      } else if (result.error) {
        tableResults.push({
          table: result.table,
          count: 0,
          error: result.error,
        })
      }
    }

    // Sort all results by relevance score
    allResults.sort((a, b) => b._relevance_score - a._relevance_score)

    const totalMatches = allResults.length
    const tablesSearched = tables.length
    const tablesWithResults = tableResults.filter((t) => t.count > 0).length

    return createSuccessResult({
      query,
      threshold,
      summary: {
        total_matches: totalMatches,
        tables_searched: tablesSearched,
        tables_with_results: tablesWithResults,
      },
      results_by_table: tableResults,
      top_matches: allResults.slice(0, 10).map((r: any) => ({
        table: r._table,
        sys_id: r.sys_id,
        name: r.name || r.label || r.sys_id,
        relevance_score: Math.round(r._relevance_score * 100) / 100,
        matched_field: r._matched_field,
      })),
      message:
        totalMatches > 0
          ? `Found ${totalMatches} matches for "${query}" across ${tablesWithResults} table(s)`
          : `No matches found for "${query}" above threshold ${threshold}`,
    })
  } catch (error: any) {
    return createErrorResult(`Fuzzy search failed: ${error.message}`)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
