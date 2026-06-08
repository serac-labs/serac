/**
 * snow_agile_sprint_manage - Create, start, and close sprints
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_agile_sprint_manage",
  description:
    "Manage Agile sprints: create new sprints, start/close sprints, update sprint details. Works with ServiceNow Agile 2.0 (rm_sprint table).",
  category: "standard",
  subcategory: "agile",
  use_cases: ["agile", "scrum", "sprint", "planning"],
  complexity: "intermediate",
  frequency: "high",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "start", "close", "update"],
        description: "Action to perform on the sprint",
      },
      sys_id: {
        type: "string",
        description: "Sprint sys_id (required for start/close/update)",
      },
      name: {
        type: "string",
        description: "Sprint name (for create)",
      },
      start_date: {
        type: "string",
        description: "Sprint start date (YYYY-MM-DD)",
      },
      end_date: {
        type: "string",
        description: "Sprint end date (YYYY-MM-DD)",
      },
      team: {
        type: "string",
        description: "Scrum team name or sys_id",
      },
      story_points: {
        type: "number",
        description: "Sprint story point capacity",
      },
      goal: {
        type: "string",
        description: "Sprint goal description",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const client = await getAuthenticatedClient(context)

    if (args.action === "create") {
      if (!args.name) return createErrorResult("name is required for create action")
      const body: Record<string, any> = { short_description: args.name }
      if (args.start_date) body.start_date = args.start_date
      if (args.end_date) body.end_date = args.end_date
      if (args.story_points) body.story_points = args.story_points
      if (args.goal) body.goal = args.goal

      if (args.team) {
        try {
          const teamResp = await client.get("/api/now/table/rm_team", {
            params: {
              sysparm_query: "name=" + args.team + "^ORsys_id=" + args.team,
              sysparm_limit: 1,
              sysparm_fields: "sys_id",
            },
          })
          const teams = teamResp.data.result || []
          if (teams.length > 0) body.assignment_group = teams[0].sys_id
        } catch (_e: any) {
          const msg = _e.message || ""
          if (msg.indexOf("Invalid table") !== -1) {
            return createErrorResult(
              "The rm_team table is not available. Activate the Agile Development 2.0 plugin (com.snc.sdlc.agile.2.0) to enable team management. You can still create sprints without a team by omitting the 'team' parameter.",
            )
          }
        }
      }

      const response = await client.post("/api/now/table/rm_sprint", body)
      return createSuccessResult({
        action: "created",
        sprint: response.data.result,
      })
    }

    if (!args.sys_id) return createErrorResult("sys_id is required for " + args.action + " action")

    if (args.action === "start") {
      const response = await client.patch("/api/now/table/rm_sprint/" + args.sys_id, { state: "2" })
      return createSuccessResult({ action: "started", sprint: response.data.result })
    }

    if (args.action === "close") {
      const response = await client.patch("/api/now/table/rm_sprint/" + args.sys_id, { state: "3" })
      return createSuccessResult({ action: "closed", sprint: response.data.result })
    }

    if (args.action === "update") {
      const updates: Record<string, any> = {}
      if (args.name) updates.short_description = args.name
      if (args.start_date) updates.start_date = args.start_date
      if (args.end_date) updates.end_date = args.end_date
      if (args.story_points) updates.story_points = args.story_points
      if (args.goal) updates.goal = args.goal
      const response = await client.patch("/api/now/table/rm_sprint/" + args.sys_id, updates)
      return createSuccessResult({ action: "updated", sprint: response.data.result })
    }

    return createErrorResult("Unknown action: " + args.action)
  } catch (error: any) {
    const msg = error.message || "Operation failed"
    if (msg.indexOf("Invalid table") !== -1) {
      return createErrorResult(
        "The rm_sprint table is not available. Activate the Agile Development 2.0 plugin (com.snc.sdlc.agile.2.0) on your instance.",
      )
    }
    return createErrorResult("Sprint " + args.action + " failed: " + msg)
  }
}

export const version = "1.0.0"
