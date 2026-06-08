/**
 * snow_agile_sprint_board - Sprint board view with stories grouped by state
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_agile_sprint_board",
  description:
    "Get a sprint board view: stories and tasks grouped by state columns (Draft, Ready, Work In Progress, Testing, Closed Complete, Closed Incomplete). Includes task breakdown per story.",
  category: "standard",
  subcategory: "agile",
  use_cases: ["agile", "scrum", "sprint", "board", "kanban"],
  complexity: "beginner",
  frequency: "high",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      sprint: {
        type: "string",
        description: "Sprint sys_id or number",
      },
      team: {
        type: "string",
        description: "Scrum team name or sys_id (uses active sprint if sprint not specified)",
      },
      include_tasks: {
        type: "boolean",
        description: "Include scrum tasks per story (default false)",
      },
    },
    required: [],
  },
}

const BOARD_COLUMNS = ["Draft", "Ready", "Work In Progress", "Testing", "Closed Complete", "Closed Incomplete"]

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sprint, team, include_tasks } = args
  try {
    const client = await getAuthenticatedClient(context)

    var sprintId = sprint
    if (!sprintId && team) {
      const activeSprint = await client.get("/api/now/table/rm_sprint", {
        params: {
          sysparm_query: "state=2^group.name=" + team + "^ORgroup=" + team,
          sysparm_limit: 1,
          sysparm_fields: "sys_id,short_description,number",
        },
      })
      const sprints = activeSprint.data.result || []
      if (sprints.length === 0) return createErrorResult("No active sprint found for team: " + team)
      sprintId = sprints[0].sys_id
    }

    if (!sprintId) return createErrorResult("Either sprint or team parameter is required")

    // Resolve sprint number to sys_id if needed
    if (sprintId.indexOf("SPRNT") === 0) {
      const lookup = await client.get("/api/now/table/rm_sprint", {
        params: { sysparm_query: "number=" + sprintId, sysparm_limit: 1, sysparm_fields: "sys_id" },
      })
      const found = lookup.data.result || []
      if (found.length === 0) return createErrorResult("Sprint not found: " + sprintId)
      sprintId = found[0].sys_id
    }

    const storiesResp = await client.get("/api/now/table/rm_story", {
      params: {
        sysparm_query: "sprint=" + sprintId,
        sysparm_fields:
          "sys_id,short_description,number,story_points,state,assigned_to,priority,blocked,blocked_reason",
        sysparm_display_value: "true",
      },
    })

    const stories = storiesResp.data.result || []

    if (include_tasks) {
      for (const story of stories) {
        const tasksResp = await client.get("/api/now/table/rm_scrum_task", {
          params: {
            sysparm_query: "story=" + story.sys_id,
            sysparm_fields: "sys_id,short_description,state,assigned_to,hours,time_worked",
            sysparm_display_value: "true",
          },
        })
        story.tasks = tasksResp.data.result || []
      }
    }

    const board: Record<string, any[]> = {}
    for (var c = 0; c < BOARD_COLUMNS.length; c++) {
      board[BOARD_COLUMNS[c]] = []
    }
    for (var s = 0; s < stories.length; s++) {
      var col = stories[s].state || "Draft"
      if (!board[col]) board[col] = []
      board[col].push(stories[s])
    }

    var totalPoints = 0
    var completedPoints = 0
    for (var j = 0; j < stories.length; j++) {
      var pts = parseInt(stories[j].story_points, 10) || 0
      totalPoints += pts
      if (stories[j].state === "Closed Complete") completedPoints += pts
    }

    return createSuccessResult({
      sprint_id: sprintId,
      board,
      summary: {
        total_stories: stories.length,
        total_points: totalPoints,
        completed_points: completedPoints,
        columns: Object.keys(board).map(function (col) {
          return { column: col, count: board[col].length }
        }),
      },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
