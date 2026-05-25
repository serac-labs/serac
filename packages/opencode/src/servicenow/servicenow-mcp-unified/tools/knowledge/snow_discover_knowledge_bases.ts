/**
 * snow_discover_knowledge_bases - Discover knowledge bases
 *
 * Discovers available knowledge bases and their categories in the ServiceNow instance.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_discover_knowledge_bases",
  description: "Discovers available knowledge bases and their categories in the ServiceNow instance.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "knowledge",
  use_cases: ["knowledge", "discovery", "query"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Discovery operation - reads metadata
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      active_only: { type: "boolean", description: "Show only active knowledge bases", default: true },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { active_only = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Build query
    const query = active_only ? "active=true" : ""

    // Get knowledge bases
    const response = await client.get("/api/now/table/kb_knowledge_base", {
      params: {
        sysparm_query: query,
        sysparm_limit: 50,
      },
    })

    const knowledgeBases = response.data.result

    // Get categories for each knowledge base
    const kbWithCategories = await Promise.all(
      knowledgeBases.map(async (kb: any) => {
        const catResponse = await client.get("/api/now/table/kb_category", {
          params: {
            sysparm_query: `kb_knowledge_base=${kb.sys_id}`,
            sysparm_limit: 20,
          },
        })
        return {
          ...kb,
          categories: catResponse.data.result,
        }
      }),
    )

    return createSuccessResult(
      {
        knowledge_bases: kbWithCategories,
        count: kbWithCategories.length,
      },
      {
        operation: "discover_knowledge_bases",
        active_only,
      },
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
