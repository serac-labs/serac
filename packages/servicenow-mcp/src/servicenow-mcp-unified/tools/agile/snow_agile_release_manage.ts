/**
 * snow_agile_release_manage - Manage releases and release readiness
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_agile_release_manage",
  description:
    "Manage Agile releases: create/update releases, link sprints and epics, check release readiness with story completion status.",
  category: "standard",
  subcategory: "agile",
  use_cases: ["agile", "release", "planning", "deployment"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "readiness"],
        description: "Action: create/update a release, or check readiness",
      },
      sys_id: {
        type: "string",
        description: "Release sys_id (required for update/readiness)",
      },
      name: {
        type: "string",
        description: "Release name",
      },
      start_date: {
        type: "string",
        description: "Release start date (YYYY-MM-DD)",
      },
      end_date: {
        type: "string",
        description: "Release end date (YYYY-MM-DD)",
      },
      state: {
        type: "string",
        enum: ["Draft", "Planning", "In Progress", "Released", "Cancelled"],
        description: "Release state",
      },
      description: {
        type: "string",
        description: "Release description/notes",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action, sys_id, name, start_date, end_date, state, description } = args
  try {
    const client = await getAuthenticatedClient(context)

    if (action === "readiness") {
      if (!sys_id) return createErrorResult("sys_id is required for readiness check")

      const releaseResp = await client.get("/api/now/table/rm_release/" + sys_id, {
        params: { sysparm_display_value: "true" },
      })
      const release = releaseResp.data.result
      if (!release) return createErrorResult("Release not found: " + sys_id)

      // Get stories linked to this release
      const storiesResp = await client.get("/api/now/table/rm_story", {
        params: {
          sysparm_query: "release=" + sys_id,
          sysparm_fields: "sys_id,short_description,number,story_points,state,sprint,epic,blocked",
          sysparm_display_value: "true",
        },
      })
      const stories = storiesResp.data.result || []

      var totalStories = stories.length
      var completedStories = 0
      var blockedStories = 0
      var totalPoints = 0
      var completedPoints = 0
      var stateBreakdown: Record<string, number> = {}

      for (var i = 0; i < stories.length; i++) {
        var pts = parseInt(stories[i].story_points, 10) || 0
        totalPoints += pts
        var storyState = stories[i].state || "Unknown"

        if (!stateBreakdown[storyState]) stateBreakdown[storyState] = 0
        stateBreakdown[storyState]++

        if (storyState === "Closed Complete") {
          completedStories++
          completedPoints += pts
        }
        if (stories[i].blocked === "true") blockedStories++
      }

      // Get defects linked to release
      const defectsResp = await client.get("/api/now/table/rm_defect", {
        params: {
          sysparm_query: "release=" + sys_id + "^stateNOT IN3,7",
          sysparm_fields: "sys_id,short_description,number,priority,state",
          sysparm_display_value: "true",
        },
      })
      const openDefects = defectsResp.data.result || []

      var readyToRelease = completedStories === totalStories && openDefects.length === 0 && blockedStories === 0

      return createSuccessResult({
        release,
        readiness: {
          ready: readyToRelease,
          completion_percentage: totalStories > 0 ? Math.round((completedStories / totalStories) * 100) : 0,
          total_stories: totalStories,
          completed_stories: completedStories,
          remaining_stories: totalStories - completedStories,
          blocked_stories: blockedStories,
          total_points: totalPoints,
          completed_points: completedPoints,
          open_defects: openDefects.length,
          state_breakdown: stateBreakdown,
        },
        blockers: {
          blocked_stories: stories.filter(function (s: any) {
            return s.blocked === "true"
          }),
          open_defects: openDefects,
        },
      })
    }

    const body: Record<string, any> = {}
    if (name) body.short_description = name
    if (start_date) body.start_date = start_date
    if (end_date) body.end_date = end_date
    if (state) body.state = state
    if (description) body.description = description

    if (action === "create") {
      if (!name) return createErrorResult("name is required for create action")
      const response = await client.post("/api/now/table/rm_release", body)
      return createSuccessResult({ action: "created", release: response.data.result })
    }

    if (action === "update") {
      if (!sys_id) return createErrorResult("sys_id is required for update action")
      const response = await client.patch("/api/now/table/rm_release/" + sys_id, body)
      return createSuccessResult({ action: "updated", release: response.data.result })
    }

    return createErrorResult("Unknown action: " + action)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
