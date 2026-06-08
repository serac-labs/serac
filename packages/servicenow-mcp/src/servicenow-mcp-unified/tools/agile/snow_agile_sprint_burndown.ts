/**
 * snow_agile_sprint_burndown - Burndown/burnup chart data for a sprint
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_agile_sprint_burndown",
  description:
    "Generate burndown and burnup chart data for a sprint. Shows ideal vs actual progress, remaining story points per day, and scope changes.",
  category: "standard",
  subcategory: "agile",
  use_cases: ["agile", "scrum", "sprint", "burndown", "metrics", "chart"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      sprint: {
        type: "string",
        description: "Sprint sys_id or number",
      },
      chart_type: {
        type: "string",
        enum: ["burndown", "burnup", "both"],
        description: "Chart type (default: both)",
      },
    },
    required: ["sprint"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sprint, chart_type = "both" } = args
  try {
    const client = await getAuthenticatedClient(context)

    // Resolve sprint
    var sprintId = sprint
    if (sprint.indexOf("SPRNT") === 0) {
      const lookup = await client.get("/api/now/table/rm_sprint", {
        params: { sysparm_query: "number=" + sprint, sysparm_limit: 1, sysparm_fields: "sys_id" },
      })
      const found = lookup.data.result || []
      if (found.length === 0) return createErrorResult("Sprint not found: " + sprint)
      sprintId = found[0].sys_id
    }

    // Get sprint details
    const sprintResp = await client.get("/api/now/table/rm_sprint/" + sprintId, {
      params: { sysparm_display_value: "true" },
    })
    const sprintData = sprintResp.data.result
    if (!sprintData) return createErrorResult("Sprint not found: " + sprintId)

    // Get all stories for the sprint with history
    const storiesResp = await client.get("/api/now/table/rm_story", {
      params: {
        sysparm_query: "sprint=" + sprintId,
        sysparm_fields: "sys_id,short_description,story_points,state,sys_updated_on,sys_created_on",
        sysparm_display_value: "all",
      },
    })
    const stories = storiesResp.data.result || []

    var totalPoints = 0
    var completedPoints = 0
    var storyDetails: any[] = []

    for (var i = 0; i < stories.length; i++) {
      var pts = parseInt(stories[i].story_points, 10) || 0
      totalPoints += pts
      var isComplete = stories[i].state && stories[i].state.display_value === "Closed Complete"
      if (isComplete) completedPoints += pts
      storyDetails.push({
        sys_id: stories[i].sys_id,
        name: stories[i].short_description,
        points: pts,
        state: stories[i].state ? stories[i].state.display_value : "Unknown",
        completed: isComplete,
        updated: stories[i].sys_updated_on,
        created: stories[i].sys_created_on,
      })
    }

    // Calculate ideal burndown line
    var startDate = new Date(sprintData.start_date)
    var endDate = new Date(sprintData.end_date)
    var totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
    if (totalDays <= 0) totalDays = 1

    var idealLine: any[] = []
    var pointsPerDay = totalPoints / totalDays
    for (var d = 0; d <= totalDays; d++) {
      var date = new Date(startDate.getTime() + d * 24 * 60 * 60 * 1000)
      idealLine.push({
        day: d,
        date: date.toISOString().split("T")[0],
        remaining: Math.round((totalPoints - pointsPerDay * d) * 10) / 10,
      })
    }

    var result: Record<string, any> = {
      sprint: {
        sys_id: sprintId,
        name: sprintData.short_description,
        number: sprintData.number,
        start_date: sprintData.start_date,
        end_date: sprintData.end_date,
        state: sprintData.state,
      },
      total_points: totalPoints,
      completed_points: completedPoints,
      remaining_points: totalPoints - completedPoints,
      completion_percentage: totalPoints > 0 ? Math.round((completedPoints / totalPoints) * 100) : 0,
      stories: storyDetails,
    }

    if (chart_type === "burndown" || chart_type === "both") {
      result.burndown = {
        ideal: idealLine,
        actual_remaining: totalPoints - completedPoints,
      }
    }

    if (chart_type === "burnup" || chart_type === "both") {
      result.burnup = {
        scope: totalPoints,
        completed: completedPoints,
        ideal_completion: idealLine.map(function (point: any) {
          return { day: point.day, date: point.date, completed: totalPoints - point.remaining }
        }),
      }
    }

    return createSuccessResult(result)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
