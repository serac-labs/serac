/**
 * snow_agile_epic_manage - Create and manage epics with progress tracking
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_agile_epic_manage",
  description:
    "Manage Agile epics: create/update epics, link stories, view progress breakdown. Works with ServiceNow rm_epic table.",
  category: "standard",
  subcategory: "agile",
  use_cases: ["agile", "scrum", "epic", "planning", "portfolio"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "get_progress"],
        description: "Action to perform",
      },
      sys_id: {
        type: "string",
        description: "Epic sys_id (required for update/get_progress)",
      },
      title: {
        type: "string",
        description: "Epic title / short description",
      },
      description: {
        type: "string",
        description: "Detailed description",
      },
      state: {
        type: "string",
        enum: ["Draft", "Open", "Work In Progress", "Closed Complete", "Closed Incomplete", "Cancelled"],
        description: "Epic state",
      },
      theme: {
        type: "string",
        description: "Theme sys_id or name to link to",
      },
      product: {
        type: "string",
        description: "Product sys_id or name",
      },
      priority: {
        type: "number",
        enum: [1, 2, 3, 4],
        description: "Priority (1=Critical, 2=High, 3=Moderate, 4=Low)",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action, sys_id, title, description, state, theme, product, priority } = args
  try {
    const client = await getAuthenticatedClient(context)

    if (action === "get_progress") {
      if (!sys_id) return createErrorResult("sys_id is required for get_progress")

      const epicResp = await client.get("/api/now/table/rm_epic/" + sys_id, {
        params: { sysparm_display_value: "true" },
      })
      const epic = epicResp.data.result
      if (!epic) return createErrorResult("Epic not found: " + sys_id)

      const storiesResp = await client.get("/api/now/table/rm_story", {
        params: {
          sysparm_query: "epic=" + sys_id,
          sysparm_fields: "sys_id,short_description,number,story_points,state,sprint,assigned_to",
          sysparm_display_value: "true",
        },
      })
      const stories = storiesResp.data.result || []

      var totalPoints = 0
      var completedPoints = 0
      var stateBreakdown: Record<string, { count: number; points: number }> = {}

      for (var i = 0; i < stories.length; i++) {
        var pts = parseInt(stories[i].story_points, 10) || 0
        totalPoints += pts
        var storyState = stories[i].state || "Unknown"
        if (!stateBreakdown[storyState]) stateBreakdown[storyState] = { count: 0, points: 0 }
        stateBreakdown[storyState].count++
        stateBreakdown[storyState].points += pts
        if (storyState === "Closed Complete") completedPoints += pts
      }

      return createSuccessResult({
        epic,
        progress: {
          total_stories: stories.length,
          total_points: totalPoints,
          completed_points: completedPoints,
          remaining_points: totalPoints - completedPoints,
          completion_percentage: totalPoints > 0 ? Math.round((completedPoints / totalPoints) * 100) : 0,
          state_breakdown: stateBreakdown,
        },
        stories,
      })
    }

    const body: Record<string, any> = {}
    if (title) body.short_description = title
    if (description) body.description = description
    if (state) body.state = state
    if (priority) body.priority = priority

    if (theme) {
      const themeLookup = await client.get("/api/now/table/rm_theme", {
        params: { sysparm_query: "name=" + theme + "^ORsys_id=" + theme, sysparm_limit: 1, sysparm_fields: "sys_id" },
      })
      const themes = themeLookup.data.result || []
      if (themes.length > 0) body.theme = themes[0].sys_id
    }

    if (product) {
      body.product = product
    }

    if (action === "create") {
      if (!title) return createErrorResult("title is required for create action")
      const response = await client.post("/api/now/table/rm_epic", body)
      return createSuccessResult({ action: "created", epic: response.data.result })
    }

    if (action === "update") {
      if (!sys_id) return createErrorResult("sys_id is required for update action")
      const response = await client.patch("/api/now/table/rm_epic/" + sys_id, body)
      return createSuccessResult({ action: "updated", epic: response.data.result })
    }

    return createErrorResult("Unknown action: " + action)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
