/**
 * snow_agile_sprint_query - Query sprints with filtering and story breakdown
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_agile_sprint_query",
  description:
    "Query sprints with burndown data, filter by team/state/date range. Optionally includes story breakdown per sprint.",
  category: "standard",
  subcategory: "agile",
  use_cases: ["agile", "scrum", "sprint", "query", "planning"],
  complexity: "beginner",
  frequency: "high",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      team: { type: "string", description: "Scrum team name or sys_id" },
      state: {
        type: "string",
        enum: ["planning", "active", "closed"],
        description: "Sprint state filter",
      },
      active_only: { type: "boolean", description: "Only return active sprints" },
      include_stories: { type: "boolean", description: "Include story breakdown per sprint" },
      limit: { type: "number", description: "Max results (default 10)" },
    },
    required: [],
  },
}

const STATE_MAP: Record<string, string> = {
  planning: "1",
  active: "2",
  closed: "3",
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { team, state, active_only, include_stories, limit = 10 } = args
  try {
    const client = await getAuthenticatedClient(context)

    const queryParts: string[] = []
    if (team) queryParts.push("group.name=" + team + "^ORgroup=" + team)
    if (state && STATE_MAP[state]) queryParts.push("state=" + STATE_MAP[state])
    if (active_only) queryParts.push("state=2")
    queryParts.push("ORDERBYDESCstart_date")

    const response = await client.get("/api/now/table/rm_sprint", {
      params: {
        sysparm_query: queryParts.join("^"),
        sysparm_limit: limit,
        sysparm_display_value: "true",
        sysparm_fields: "sys_id,short_description,number,state,start_date,end_date,story_points,goal,group",
      },
    })

    const sprints = response.data.result || []

    if (include_stories && sprints.length > 0) {
      for (const sprint of sprints) {
        const stories = await client.get("/api/now/table/rm_story", {
          params: {
            sysparm_query: "sprint=" + sprint.sys_id,
            sysparm_fields: "sys_id,short_description,number,story_points,state,assigned_to,priority",
            sysparm_display_value: "true",
          },
        })
        sprint.stories = stories.data.result || []
        sprint.story_count = sprint.stories.length
        var completed = 0
        var total = 0
        for (var i = 0; i < sprint.stories.length; i++) {
          var pts = parseInt(sprint.stories[i].story_points, 10) || 0
          total += pts
          if (sprint.stories[i].state === "Closed Complete") completed += pts
        }
        sprint.points_completed = completed
        sprint.points_total = total
      }
    }

    return createSuccessResult({ sprints, count: sprints.length })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
