/**
 * snow_agile_backlog_query - Query the product backlog with filtering and ranking
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_agile_backlog_query",
  description:
    "Query the product backlog: list stories sorted by priority/rank, filter by epic, theme, state, or assignee. Shows unassigned and upcoming work.",
  category: "standard",
  subcategory: "agile",
  use_cases: ["agile", "scrum", "backlog", "planning", "grooming"],
  complexity: "beginner",
  frequency: "high",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      product: {
        type: "string",
        description: "Product name or sys_id to scope the backlog",
      },
      epic: {
        type: "string",
        description: "Filter by epic sys_id or number",
      },
      theme: {
        type: "string",
        description: "Filter by theme sys_id or name",
      },
      state: {
        type: "string",
        enum: ["Draft", "Ready", "Work In Progress", "Testing", "Closed Complete", "Closed Incomplete"],
        description: "Filter by story state",
      },
      unassigned_only: {
        type: "boolean",
        description: "Only show stories not assigned to a sprint",
      },
      assigned_to: {
        type: "string",
        description: "Filter by assignee username or sys_id",
      },
      priority: {
        type: "number",
        enum: [1, 2, 3, 4],
        description: "Filter by priority (1=Critical, 2=High, 3=Moderate, 4=Low)",
      },
      has_points: {
        type: "boolean",
        description: "Filter for stories that have (true) or lack (false) story point estimates",
      },
      limit: {
        type: "number",
        description: "Max results (default 25)",
      },
      offset: {
        type: "number",
        description: "Pagination offset (default 0)",
      },
    },
    required: [],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { product, epic, theme, state, unassigned_only, assigned_to, priority, has_points, limit = 25, offset = 0 } =
    args
  try {
    const client = await getAuthenticatedClient(context)

    const queryParts: string[] = []

    if (product) queryParts.push("product.name=" + product + "^ORproduct=" + product)
    if (epic) queryParts.push("epic.number=" + epic + "^ORepic=" + epic)
    if (theme) queryParts.push("theme.name=" + theme + "^ORtheme=" + theme)
    if (state) queryParts.push("state=" + state)
    if (unassigned_only) queryParts.push("sprintISEMPTY")
    if (assigned_to) queryParts.push("assigned_to.user_name=" + assigned_to + "^ORassigned_to=" + assigned_to)
    if (priority) queryParts.push("priority=" + priority)
    if (has_points === true) queryParts.push("story_pointsISNOTEMPTY^story_points>0")
    if (has_points === false) queryParts.push("story_pointsISEMPTY^ORstory_points=0")

    queryParts.push("ORDERBYpriority^ORDERBYorder")

    const response = await client.get("/api/now/table/rm_story", {
      params: {
        sysparm_query: queryParts.join("^"),
        sysparm_limit: limit,
        sysparm_offset: offset,
        sysparm_display_value: "true",
        sysparm_fields:
          "sys_id,short_description,number,story_points,state,priority,assigned_to,sprint,epic,theme,blocked,order",
      },
    })

    const stories = response.data.result || []

    // Calculate backlog summary
    var totalPoints = 0
    var estimatedCount = 0
    var unestimatedCount = 0
    var blockedCount = 0

    for (var i = 0; i < stories.length; i++) {
      var pts = parseInt(stories[i].story_points, 10) || 0
      if (pts > 0) {
        totalPoints += pts
        estimatedCount++
      } else {
        unestimatedCount++
      }
      if (stories[i].blocked === "true") blockedCount++
    }

    return createSuccessResult({
      stories,
      count: stories.length,
      summary: {
        total_points: totalPoints,
        estimated: estimatedCount,
        unestimated: unestimatedCount,
        blocked: blockedCount,
      },
      pagination: { limit, offset, has_more: stories.length === limit },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
