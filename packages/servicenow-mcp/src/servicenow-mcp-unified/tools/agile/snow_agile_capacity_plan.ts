/**
 * snow_agile_capacity_plan - Team capacity planning for sprints
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_agile_capacity_plan",
  description:
    "Capacity planning: compare team availability against sprint commitment. Shows member allocation, average velocity, and recommended story point capacity.",
  category: "standard",
  subcategory: "agile",
  use_cases: ["agile", "scrum", "capacity", "planning", "sprint planning"],
  complexity: "intermediate",
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
      sprint: {
        type: "string",
        description: "Target sprint sys_id or number (defaults to active sprint)",
      },
      velocity_sprints: {
        type: "number",
        description: "Number of past sprints to calculate average velocity (default 3)",
      },
    },
    required: ["team"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const PLUGIN_HINT =
    "The rm_team table does not exist. Activate the 'Agile Development 2.0 - Team component' plugin (com.snc.sdlc.agile.2.0.team) to enable team management."

  try {
    const client = await getAuthenticatedClient(context)

    // Verify rm_team table exists
    try {
      await client.get("/api/now/table/rm_team", { params: { sysparm_limit: 0 } })
    } catch (e: any) {
      const msg = (e.message || "") + (e.response?.data?.error?.message || "")
      if (msg.indexOf("Invalid table") !== -1 || msg.indexOf("ACL") !== -1) {
        return createErrorResult(PLUGIN_HINT)
      }
      throw e
    }

    // Resolve team
    const teamResp = await client.get("/api/now/table/rm_team", {
      params: {
        sysparm_query: "name=" + args.team + "^ORsys_id=" + args.team,
        sysparm_limit: 1,
        sysparm_display_value: "true",
      },
    })
    const teams = teamResp.data.result || []
    if (teams.length === 0) return createErrorResult("Team not found: " + args.team)
    const teamRecord = teams[0]

    // Get team members
    const membersResp = await client.get("/api/now/table/rm_team_member", {
      params: {
        sysparm_query: "team=" + teamRecord.sys_id,
        sysparm_fields: "sys_id,user,role,allocation",
        sysparm_display_value: "true",
      },
    })
    const members = membersResp.data.result || []

    // Resolve target sprint
    var targetSprint: any = null
    if (args.sprint) {
      var sprintQuery = "sys_id=" + args.sprint
      if (args.sprint.indexOf("SPRNT") === 0) sprintQuery = "number=" + args.sprint
      const sprintResp = await client.get("/api/now/table/rm_sprint", {
        params: { sysparm_query: sprintQuery, sysparm_limit: 1, sysparm_display_value: "true" },
      })
      const sprints = sprintResp.data.result || []
      if (sprints.length > 0) targetSprint = sprints[0]
    } else {
      // Get active sprint for team
      const activeResp = await client.get("/api/now/table/rm_sprint", {
        params: {
          sysparm_query: "group=" + teamRecord.sys_id + "^state=2",
          sysparm_limit: 1,
          sysparm_display_value: "true",
        },
      })
      const actives = activeResp.data.result || []
      if (actives.length > 0) targetSprint = actives[0]
    }

    // Calculate historical velocity
    const closedSprintsResp = await client.get("/api/now/table/rm_sprint", {
      params: {
        sysparm_query: "group=" + teamRecord.sys_id + "^state=3^ORDERBYDESCend_date",
        sysparm_limit: args.velocity_sprints || 3,
        sysparm_fields: "sys_id,number,story_points",
      },
    })
    const closedSprints = closedSprintsResp.data.result || []

    var velocityHistory: number[] = []
    for (var i = 0; i < closedSprints.length; i++) {
      var sprintSysId = closedSprints[i].sys_id
      const storiesResp = await client.get("/api/now/table/rm_story", {
        params: {
          sysparm_query: "sprint=" + sprintSysId + "^state=Closed Complete",
          sysparm_fields: "story_points",
        },
      })
      var completed = 0
      var storyResults = storiesResp.data.result || []
      for (var j = 0; j < storyResults.length; j++) {
        completed += parseInt(storyResults[j].story_points, 10) || 0
      }
      velocityHistory.push(completed)
    }

    var avgVelocity = 0
    if (velocityHistory.length > 0) {
      var sum = 0
      for (var k = 0; k < velocityHistory.length; k++) sum += velocityHistory[k]
      avgVelocity = Math.round(sum / velocityHistory.length)
    }

    // Current sprint commitment if we have a target sprint
    var currentCommitment = 0
    if (targetSprint) {
      const committedResp = await client.get("/api/now/table/rm_story", {
        params: {
          sysparm_query: "sprint=" + targetSprint.sys_id,
          sysparm_fields: "story_points",
        },
      })
      var committedStories = committedResp.data.result || []
      for (var m = 0; m < committedStories.length; m++) {
        currentCommitment += parseInt(committedStories[m].story_points, 10) || 0
      }
    }

    var totalAllocation = 0
    for (var n = 0; n < members.length; n++) {
      totalAllocation += parseInt(members[n].allocation, 10) || 100
    }
    var effectiveMembers = totalAllocation / 100

    return createSuccessResult({
      team: { name: teamRecord.name, sys_id: teamRecord.sys_id },
      sprint: targetSprint
        ? {
            name: targetSprint.short_description,
            number: targetSprint.number,
            state: targetSprint.state,
            start_date: targetSprint.start_date,
            end_date: targetSprint.end_date,
          }
        : null,
      capacity: {
        team_size: members.length,
        effective_members: effectiveMembers,
        average_velocity: avgVelocity,
        recommended_commitment: avgVelocity,
        current_commitment: currentCommitment,
        remaining_capacity: avgVelocity - currentCommitment,
        overcommitted: currentCommitment > avgVelocity,
      },
      members: members.map(function (m: any) {
        return {
          name: m.user,
          role: m.role,
          allocation: (parseInt(m.allocation, 10) || 100) + "%",
        }
      }),
      velocity_history: velocityHistory,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
