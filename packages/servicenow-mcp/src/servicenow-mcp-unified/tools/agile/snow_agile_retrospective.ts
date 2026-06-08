/**
 * snow_agile_retrospective - Sprint retrospective data and analysis
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_agile_retrospective",
  description:
    "Generate sprint retrospective data: planned vs completed story points, defect rate, velocity trend, carry-over stories, and team performance metrics across sprints.",
  category: "standard",
  subcategory: "agile",
  use_cases: ["agile", "scrum", "retrospective", "retro", "metrics", "improvement"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      sprint: {
        type: "string",
        description: "Sprint sys_id or number to retrospect",
      },
      team: {
        type: "string",
        description: "Team name or sys_id (uses last closed sprint if sprint not specified)",
      },
      compare_sprints: {
        type: "number",
        description: "Number of previous sprints to compare against (default 3)",
      },
    },
    required: [],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sprint, team, compare_sprints = 3 } = args
  try {
    const client = await getAuthenticatedClient(context)

    // Resolve the target sprint
    var sprintId = sprint
    if (!sprintId && team) {
      // Get last closed sprint for team
      const closedResp = await client.get("/api/now/table/rm_sprint", {
        params: {
          sysparm_query: "group.name=" + team + "^ORgroup=" + team + "^state=3^ORDERBYDESCend_date",
          sysparm_limit: 1,
          sysparm_fields: "sys_id",
        },
      })
      const closed = closedResp.data.result || []
      if (closed.length === 0) return createErrorResult("No closed sprints found for team: " + team)
      sprintId = closed[0].sys_id
    }

    if (!sprintId) return createErrorResult("Either sprint or team parameter is required")

    if (sprintId.indexOf("SPRNT") === 0) {
      const lookup = await client.get("/api/now/table/rm_sprint", {
        params: { sysparm_query: "number=" + sprintId, sysparm_limit: 1, sysparm_fields: "sys_id" },
      })
      const found = lookup.data.result || []
      if (found.length === 0) return createErrorResult("Sprint not found: " + sprintId)
      sprintId = found[0].sys_id
    }

    // Get sprint details
    const sprintResp = await client.get("/api/now/table/rm_sprint/" + sprintId, {
      params: { sysparm_display_value: "true" },
    })
    const sprintData = sprintResp.data.result
    if (!sprintData) return createErrorResult("Sprint not found: " + sprintId)

    // Get all stories
    const storiesResp = await client.get("/api/now/table/rm_story", {
      params: {
        sysparm_query: "sprint=" + sprintId,
        sysparm_fields: "sys_id,short_description,number,story_points,state,assigned_to,blocked,sys_created_on",
        sysparm_display_value: "true",
      },
    })
    const stories = storiesResp.data.result || []

    var planned = 0
    var completed = 0
    var incomplete = 0
    var stateBreakdown: Record<string, { count: number; points: number }> = {}
    var carryOver: any[] = []

    for (var i = 0; i < stories.length; i++) {
      var pts = parseInt(stories[i].story_points, 10) || 0
      planned += pts
      var storyState = stories[i].state || "Unknown"

      if (!stateBreakdown[storyState]) stateBreakdown[storyState] = { count: 0, points: 0 }
      stateBreakdown[storyState].count++
      stateBreakdown[storyState].points += pts

      if (storyState === "Closed Complete") {
        completed += pts
      } else if (storyState !== "Closed Incomplete" && storyState !== "Cancelled") {
        incomplete += pts
        carryOver.push({
          number: stories[i].number,
          title: stories[i].short_description,
          points: pts,
          state: storyState,
          assigned_to: stories[i].assigned_to,
        })
      }
    }

    // Get defects for this sprint
    const defectsResp = await client.get("/api/now/table/rm_defect", {
      params: {
        sysparm_query: "sprint=" + sprintId,
        sysparm_fields: "sys_id,short_description,number,priority,state",
        sysparm_display_value: "true",
      },
    })
    const defects = defectsResp.data.result || []

    // Get comparison data from previous sprints
    var teamId = sprintData.group ? sprintData.group.value || sprintData.group : null
    var comparison: any[] = []

    if (teamId) {
      const prevSprintsResp = await client.get("/api/now/table/rm_sprint", {
        params: {
          sysparm_query: "group=" + teamId + "^state=3^sys_id!=" + sprintId + "^ORDERBYDESCend_date",
          sysparm_limit: compare_sprints,
          sysparm_fields: "sys_id,short_description,number,story_points,start_date,end_date",
          sysparm_display_value: "true",
        },
      })
      const prevSprints = prevSprintsResp.data.result || []

      for (var j = 0; j < prevSprints.length; j++) {
        const prevStoriesResp = await client.get("/api/now/table/rm_story", {
          params: {
            sysparm_query: "sprint=" + prevSprints[j].sys_id,
            sysparm_fields: "story_points,state",
            sysparm_display_value: "true",
          },
        })
        const prevStories = prevStoriesResp.data.result || []

        var prevPlanned = 0
        var prevCompleted = 0
        for (var k = 0; k < prevStories.length; k++) {
          var prevPts = parseInt(prevStories[k].story_points, 10) || 0
          prevPlanned += prevPts
          if (prevStories[k].state === "Closed Complete") prevCompleted += prevPts
        }

        comparison.push({
          sprint: prevSprints[j].number,
          name: prevSprints[j].short_description,
          planned: prevPlanned,
          completed: prevCompleted,
          completion_rate: prevPlanned > 0 ? Math.round((prevCompleted / prevPlanned) * 100) : 0,
        })
      }
    }

    return createSuccessResult({
      sprint: {
        sys_id: sprintId,
        name: sprintData.short_description,
        number: sprintData.number,
        start_date: sprintData.start_date,
        end_date: sprintData.end_date,
        state: sprintData.state,
      },
      metrics: {
        planned_points: planned,
        completed_points: completed,
        incomplete_points: incomplete,
        completion_rate: planned > 0 ? Math.round((completed / planned) * 100) : 0,
        total_stories: stories.length,
        defects_found: defects.length,
        defect_rate: stories.length > 0 ? Math.round((defects.length / stories.length) * 100) : 0,
        carry_over_count: carryOver.length,
        carry_over_points: incomplete,
      },
      state_breakdown: stateBreakdown,
      carry_over: carryOver,
      defects,
      comparison,
      insights: generateInsights(planned, completed, defects.length, stories.length, comparison),
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function generateInsights(
  planned: number,
  completed: number,
  defectCount: number,
  storyCount: number,
  comparison: any[],
): string[] {
  var insights: string[] = []
  var rate = planned > 0 ? Math.round((completed / planned) * 100) : 0

  if (rate >= 90) insights.push("Excellent sprint completion rate (" + rate + "%). Team delivered on commitment.")
  else if (rate >= 70)
    insights.push("Good completion rate (" + rate + "%). Minor adjustments to planning may help close the gap.")
  else if (rate >= 50)
    insights.push(
      "Below target completion rate (" + rate + "%). Consider reducing sprint commitment or breaking stories smaller.",
    )
  else
    insights.push(
      "Low completion rate (" +
        rate +
        "%). Significant overcommitment detected. Review estimation practices and external blockers.",
    )

  if (defectCount > 0) {
    var defectRate = storyCount > 0 ? Math.round((defectCount / storyCount) * 100) : 0
    if (defectRate > 30) insights.push("High defect rate (" + defectRate + "%). Consider adding more testing focus.")
    else insights.push(defectCount + " defect(s) found during sprint.")
  }

  if (comparison.length >= 2) {
    var recent = comparison[0]
    var previous = comparison[1]
    if (rate > recent.completion_rate)
      insights.push(
        "Velocity improving compared to previous sprint (" + recent.completion_rate + "% -> " + rate + "%).",
      )
    else if (rate < recent.completion_rate)
      insights.push(
        "Velocity declining compared to previous sprint (" + recent.completion_rate + "% -> " + rate + "%).",
      )
  }

  return insights
}

export const version = "1.0.0"
