/**
 * snow_agile_standup_report - Daily standup summary for a team
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_agile_standup_report",
  description:
    "Generate a daily standup report: what each team member worked on recently, what they are working on now, and any blockers. Based on story/task state changes.",
  category: "standard",
  subcategory: "agile",
  use_cases: ["agile", "scrum", "standup", "daily", "status"],
  complexity: "beginner",
  frequency: "high",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      team: {
        type: "string",
        description: "Scrum team name or sys_id",
      },
      sprint: {
        type: "string",
        description: "Sprint sys_id or number (defaults to active sprint)",
      },
      days_back: {
        type: "number",
        description: "Number of days to look back for 'done' items (default 1)",
      },
    },
    required: ["team"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { team, sprint, days_back = 1 } = args
  try {
    const client = await getAuthenticatedClient(context)

    // Resolve sprint (active sprint for team if not specified)
    var sprintId = sprint
    if (!sprintId) {
      const activeResp = await client.get("/api/now/table/rm_sprint", {
        params: {
          sysparm_query: "group.name=" + team + "^ORgroup=" + team + "^state=2",
          sysparm_limit: 1,
          sysparm_fields: "sys_id,short_description,number",
        },
      })
      const actives = activeResp.data.result || []
      if (actives.length === 0) return createErrorResult("No active sprint found for team: " + team)
      sprintId = actives[0].sys_id
    } else if (sprintId.indexOf("SPRNT") === 0) {
      const lookup = await client.get("/api/now/table/rm_sprint", {
        params: { sysparm_query: "number=" + sprintId, sysparm_limit: 1, sysparm_fields: "sys_id" },
      })
      const found = lookup.data.result || []
      if (found.length === 0) return createErrorResult("Sprint not found: " + sprintId)
      sprintId = found[0].sys_id
    }

    // Get all stories in the sprint
    const storiesResp = await client.get("/api/now/table/rm_story", {
      params: {
        sysparm_query: "sprint=" + sprintId,
        sysparm_fields:
          "sys_id,short_description,number,story_points,state,assigned_to,blocked,blocked_reason,sys_updated_on",
        sysparm_display_value: "true",
      },
    })
    const stories = storiesResp.data.result || []

    // Calculate cutoff date for "recently done"
    var cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days_back)
    var cutoffStr = cutoff.toISOString().split("T")[0]

    // Group by assignee
    var memberMap: Record<string, { done: any[]; in_progress: any[]; blocked: any[] }> = {}

    for (var i = 0; i < stories.length; i++) {
      var story = stories[i]
      var assignee = story.assigned_to || "Unassigned"

      if (!memberMap[assignee]) memberMap[assignee] = { done: [], in_progress: [], blocked: [] }

      var storyInfo = {
        number: story.number,
        title: story.short_description,
        points: story.story_points,
        state: story.state,
        updated: story.sys_updated_on,
      }

      if (story.blocked === "true") {
        memberMap[assignee].blocked.push({
          number: story.number,
          title: story.short_description,
          reason: story.blocked_reason || "No reason specified",
        })
      }

      if (story.state === "Closed Complete" && story.sys_updated_on >= cutoffStr) {
        memberMap[assignee].done.push(storyInfo)
      } else if (story.state === "Work In Progress" || story.state === "Testing") {
        memberMap[assignee].in_progress.push(storyInfo)
      }
    }

    // Build standup report
    var standupEntries: any[] = []
    var allBlockers: any[] = []

    var assignees = Object.keys(memberMap)
    for (var j = 0; j < assignees.length; j++) {
      var member = assignees[j]
      var data = memberMap[member]
      standupEntries.push({
        member,
        done: data.done,
        working_on: data.in_progress,
        blocked: data.blocked,
      })
      for (var k = 0; k < data.blocked.length; k++) {
        allBlockers.push({ member, story: data.blocked[k].number, reason: data.blocked[k].reason })
      }
    }

    // Sprint progress summary
    var totalPoints = 0
    var completedPoints = 0
    for (var s = 0; s < stories.length; s++) {
      var pts = parseInt(stories[s].story_points, 10) || 0
      totalPoints += pts
      if (stories[s].state === "Closed Complete") completedPoints += pts
    }

    return createSuccessResult({
      sprint_id: sprintId,
      date: new Date().toISOString().split("T")[0],
      standup: standupEntries,
      blockers: allBlockers,
      sprint_progress: {
        total_stories: stories.length,
        total_points: totalPoints,
        completed_points: completedPoints,
        completion_percentage: totalPoints > 0 ? Math.round((completedPoints / totalPoints) * 100) : 0,
      },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
