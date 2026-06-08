/**
 * snow_discover_va_topics - Discover Virtual Agent topics
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_discover_va_topics",
  description: "Discovers available Virtual Agent topics and their configurations.",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-frameworks",
  subcategory: "virtual-agent",
  use_cases: ["virtual-agent", "topic-discovery", "conversational-ai"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Discovery operation - reads metadata
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description: "Filter by category",
      },
      active_only: {
        type: "boolean",
        description: "Show only active topics",
        default: true,
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { category, active_only = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    let query = ""
    if (category) {
      query = `category=${category}`
    }
    if (active_only) {
      query += query ? "^" : ""
      query += "active=true"
    }

    const url = query
      ? `/api/now/table/sys_cs_topic?sysparm_query=${query}&sysparm_limit=50`
      : "/api/now/table/sys_cs_topic?sysparm_limit=50"

    const response = await client.get(url)
    const topics = response.data.result

    if (!topics || topics.length === 0) {
      return createSuccessResult({
        topics: [],
        count: 0,
        message: "❌ No Virtual Agent topics found",
      })
    }

    const topicList = topics.map((topic: any) => ({
      sys_id: topic.sys_id,
      name: topic.name,
      description: topic.description || "No description",
      category: topic.category || "General",
      active: topic.active === "true" || topic.active === true,
      live_agent_enabled: topic.live_agent_enabled === "true" || topic.live_agent_enabled === true,
    }))

    return createSuccessResult({
      topics: topicList,
      count: topicList.length,
      message: `🔍 Found ${topicList.length} Virtual Agent topic(s)`,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
