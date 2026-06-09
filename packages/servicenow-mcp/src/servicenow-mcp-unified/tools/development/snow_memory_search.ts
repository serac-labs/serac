/**
 * snow_memory_search - Search development memory
 *
 * Searches cached ServiceNow artifacts in local memory for instant results without API calls.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import { promises as fs } from "fs"
import { join } from "path"
import { seracMemoryPath } from "../../shared/serac-home.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_memory_search",
  // Stdio-only: reads `process.cwd()/.serac/memory` which is a
  // server-wide path in HTTP context and would expose one tenant's cache
  // to others.
  transports: ["stdio"],
  description: "Searches cached ServiceNow artifacts in local memory for instant results without API calls.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "search",
  use_cases: ["search", "cache", "offline"],
  complexity: "beginner",
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
        description: "Search query",
      },
      type: {
        type: "string",
        enum: ["widget", "flow", "script", "application"],
        description: "Artifact type",
      },
    },
    required: ["query"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { query, type } = args

  try {
    // Memory path (configurable)
    const memoryPath = seracMemoryPath()

    // Try to read memory cache
    let memoryData: any[] = []
    try {
      const memoryFile = join(memoryPath, "artifact-cache.json")
      const content = await fs.readFile(memoryFile, "utf-8")
      memoryData = JSON.parse(content)
    } catch (error) {
      // No cache available - return empty results
      return createSuccessResult(
        {
          found: false,
          count: 0,
          results: [],
          source: "memory",
          note: "No cached artifacts found. Memory cache may not be initialized.",
        },
        {
          query,
          type,
        },
      )
    }

    // Filter by type if specified
    if (type) {
      memoryData = memoryData.filter((item) => item.type === type)
    }

    // Search in memory
    const lowerQuery = query.toLowerCase()
    const results = memoryData.filter((item) => {
      const name = (item.name || "").toLowerCase()
      const description = (item.description || "").toLowerCase()
      return name.includes(lowerQuery) || description.includes(lowerQuery)
    })

    return createSuccessResult(
      {
        found: results.length > 0,
        count: results.length,
        results: results.slice(0, 20), // Limit to 20 results
        source: "memory",
        total_cached: memoryData.length,
      },
      {
        query,
        type,
      },
    )
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return createErrorResult(errorMessage, { query, type })
  }
}
