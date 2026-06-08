/**
 * snow_agile_velocity_report - Velocity chart data: story points per sprint per team
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_agile_velocity_report",
  description:
    "Generate velocity report: story points committed vs completed per sprint for a team. Shows trends across multiple sprints for capacity planning.",
  category: "standard",
  subcategory: "agile",
  use_cases: ["agile", "scrum", "velocity", "metrics", "reporting"],
  complexity: "beginner",
  frequency: "medium",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      team: {
        type: "string",
        description: "Scrum team name or sys_id",
      },
      sprint_count: {
        type: "number",
        description: "Number of past sprints to include (default 6)",
      },
      include_current: {
        type: "boolean",
        description: "Include the currently active sprint (default true)",
      },
    },
    required: ["team"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { team, sprint_count = 6, include_current = true } = args
  try {
    const client = await getAuthenticatedClient(context)

    // Get closed sprints for the team, ordered by end date
    var stateQuery = "state=3" // closed
    if (include_current) stateQuery = "state=2^ORstate=3" // active or closed

    const sprintsResp = await client.get("/api/now/table/rm_sprint", {
      params: {
        sysparm_query: "group.name=" + team + "^ORgroup=" + team + "^" + stateQuery + "^ORDERBYDESCend_date",
        sysparm_limit: sprint_count,
        sysparm_display_value: "true",
        sysparm_fields: "sys_id,short_description,number,state,start_date,end_date,story_points",
      },
    })

    const sprints = sprintsResp.data.result || []
    if (sprints.length === 0)
      return createSuccessResult({
        message:
          "No sprints found for team: " +
          args.team +
          ". If using Agile 2.0 teams, ensure the 'Agile Development 2.0 - Team component' plugin (com.snc.sdlc.agile.2.0.team) is activated and sprints are linked to the team's group.",
        velocity: [],
      })

    var velocityData: any[] = []
    var totalCompleted = 0

    for (var i = 0; i < sprints.length; i++) {
      var sprintSysId = sprints[i].sys_id
      var committed = parseInt(sprints[i].story_points, 10) || 0

      // Get completed story points
      const storiesResp = await client.get("/api/now/table/rm_story", {
        params: {
          sysparm_query: "sprint=" + sprintSysId,
          sysparm_fields: "story_points,state",
          sysparm_display_value: "true",
        },
      })
      const stories = storiesResp.data.result || []

      var completed = 0
      var totalInSprint = 0
      var storyCount = stories.length
      var completedCount = 0

      for (var j = 0; j < stories.length; j++) {
        var pts = parseInt(stories[j].story_points, 10) || 0
        totalInSprint += pts
        if (stories[j].state === "Closed Complete") {
          completed += pts
          completedCount++
        }
      }

      // Use actual total from stories if sprint-level capacity isn't set
      if (committed === 0) committed = totalInSprint

      totalCompleted += completed

      velocityData.push({
        sprint: sprints[i].number,
        name: sprints[i].short_description,
        state: sprints[i].state,
        start_date: sprints[i].start_date,
        end_date: sprints[i].end_date,
        committed: committed,
        completed: completed,
        carry_over: committed - completed,
        completion_rate: committed > 0 ? Math.round((completed / committed) * 100) : 0,
        story_count: storyCount,
        stories_completed: completedCount,
      })
    }

    // Reverse to chronological order
    velocityData.reverse()

    var avgVelocity = sprints.length > 0 ? Math.round(totalCompleted / sprints.length) : 0

    return createSuccessResult({
      team,
      velocity: velocityData,
      summary: {
        sprints_analyzed: sprints.length,
        average_velocity: avgVelocity,
        total_completed: totalCompleted,
        trend:
          velocityData.length >= 2
            ? velocityData[velocityData.length - 1].completed > velocityData[velocityData.length - 2].completed
              ? "improving"
              : velocityData[velocityData.length - 1].completed < velocityData[velocityData.length - 2].completed
                ? "declining"
                : "stable"
            : "insufficient_data",
      },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
