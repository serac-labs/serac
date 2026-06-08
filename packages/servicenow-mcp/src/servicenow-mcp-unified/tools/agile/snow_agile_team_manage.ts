/**
 * snow_agile_team_manage - Manage scrum teams and members
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_agile_team_manage",
  description:
    "Manage Scrum teams: create teams, add/remove members with roles (Scrum Master, Product Owner, Developer), list team composition.",
  category: "standard",
  subcategory: "agile",
  use_cases: ["agile", "scrum", "team", "management"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "list_members", "add_member", "remove_member"],
        description: "Action to perform",
      },
      sys_id: {
        type: "string",
        description: "Team sys_id (required for update/list_members/add_member/remove_member)",
      },
      name: {
        type: "string",
        description: "Team name (for create/update)",
      },
      description: {
        type: "string",
        description: "Team description",
      },
      velocity: {
        type: "number",
        description: "Default velocity (story points per sprint)",
      },
      member: {
        type: "string",
        description: "User sys_id or username (for add_member/remove_member)",
      },
      role: {
        type: "string",
        enum: ["scrum_master", "product_owner", "developer"],
        description: "Member role (for add_member)",
      },
    },
    required: ["action"],
  },
}

async function resolveUser(client: any, username: string): Promise<string | null> {
  const resp = await client.get("/api/now/table/sys_user", {
    params: {
      sysparm_query: "user_name=" + username + "^ORsys_id=" + username,
      sysparm_limit: 1,
      sysparm_fields: "sys_id",
    },
  })
  const users = resp.data.result || []
  return users.length > 0 ? users[0].sys_id : null
}

const PLUGIN_HINT =
  "The rm_team table is not available. Activate the Agile Development 2.0 plugin (com.snc.sdlc.agile.2.0) to enable team management."

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const client = await getAuthenticatedClient(context)

    try {
      await client.get("/api/now/table/rm_team", { params: { sysparm_limit: 1, sysparm_fields: "sys_id" } })
    } catch (_e: any) {
      const msg = _e.message || ""
      if (msg.indexOf("Invalid table") !== -1 || (_e.response && _e.response.status === 404)) {
        return createErrorResult(PLUGIN_HINT)
      }
      throw _e
    }

    if (args.action === "create") {
      if (!args.name) return createErrorResult("name is required for create action")
      const body: Record<string, any> = { name: args.name }
      if (args.description) body.description = args.description
      if (args.velocity) body.velocity = args.velocity
      const response = await client.post("/api/now/table/rm_team", body)
      return createSuccessResult({ action: "created", team: response.data.result })
    }

    if (!args.sys_id) return createErrorResult("sys_id is required for " + args.action + " action")

    if (args.action === "update") {
      const body: Record<string, any> = {}
      if (args.name) body.name = args.name
      if (args.description) body.description = args.description
      if (args.velocity) body.velocity = args.velocity
      const response = await client.patch("/api/now/table/rm_team/" + args.sys_id, body)
      return createSuccessResult({ action: "updated", team: response.data.result })
    }

    if (args.action === "list_members") {
      const membersResp = await client.get("/api/now/table/rm_team_member", {
        params: {
          sysparm_query: "team=" + args.sys_id,
          sysparm_fields: "sys_id,user,role,allocation",
          sysparm_display_value: "true",
        },
      })
      const members = membersResp.data.result || []

      const teamResp = await client.get("/api/now/table/rm_team/" + args.sys_id, {
        params: { sysparm_display_value: "true" },
      })

      return createSuccessResult({
        team: teamResp.data.result,
        members,
        member_count: members.length,
      })
    }

    if (args.action === "add_member") {
      if (!args.member) return createErrorResult("member is required for add_member action")

      const userId = args.member.length === 32 ? args.member : await resolveUser(client, args.member)
      if (!userId) return createErrorResult("User not found: " + args.member)

      const body: Record<string, any> = { team: args.sys_id, user: userId }
      if (args.role) body.role = args.role
      const response = await client.post("/api/now/table/rm_team_member", body)
      return createSuccessResult({ action: "member_added", member: response.data.result })
    }

    if (args.action === "remove_member") {
      if (!args.member) return createErrorResult("member is required for remove_member action")

      const memberLookup = await client.get("/api/now/table/rm_team_member", {
        params: {
          sysparm_query: "team=" + args.sys_id + "^user=" + args.member + "^ORuser.user_name=" + args.member,
          sysparm_limit: 1,
          sysparm_fields: "sys_id",
        },
      })
      const found = memberLookup.data.result || []
      if (found.length === 0) return createErrorResult("Team member not found")

      await client.delete("/api/now/table/rm_team_member/" + found[0].sys_id)
      return createSuccessResult({ action: "member_removed", member_sys_id: found[0].sys_id })
    }

    return createErrorResult("Unknown action: " + args.action)
  } catch (error: any) {
    const msg = error.message || "Operation failed"
    if (msg.indexOf("Invalid table") !== -1) return createErrorResult(PLUGIN_HINT)
    return createErrorResult("Team " + args.action + " failed: " + msg)
  }
}

export const version = "1.0.0"
