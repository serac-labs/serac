/**
 * snow_manage_group_membership - Unified group membership management
 *
 * Manage user group memberships: add users to groups, remove users from groups,
 * and list group members. Handles user/group resolution (sys_id, username, email, group name).
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_manage_group_membership",
  description: "Manage group memberships: add/remove users, list members",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "user-management",
  use_cases: ["user-management", "access-control", "group-administration"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Management operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Operation: add, remove, or list",
        enum: ["add", "remove", "list"],
      },
      user_identifier: {
        type: "string",
        description: "User sys_id, username, or email",
      },
      group_identifier: {
        type: "string",
        description: "Group sys_id or name",
      },
      include_details: {
        type: "boolean",
        description: "Include user details (list only)",
        default: true,
      },
    },
    required: ["action", "group_identifier"],
  },
}

async function resolveUser(client: any, user_identifier: string): Promise<any> {
  const userQuery = user_identifier.includes("@")
    ? `email=${user_identifier}`
    : user_identifier.length === 32
      ? `sys_id=${user_identifier}`
      : `user_name=${user_identifier}`

  const userResponse = await client.get("/api/now/table/sys_user", {
    params: { sysparm_query: userQuery, sysparm_limit: 1 },
  })

  if (!userResponse.data.result || userResponse.data.result.length === 0) {
    throw new Error(`User "${user_identifier}" not found`)
  }

  return userResponse.data.result[0]
}

async function resolveGroup(client: any, group_identifier: string): Promise<any> {
  const groupQuery = group_identifier.length === 32 ? `sys_id=${group_identifier}` : `name=${group_identifier}`

  const groupResponse = await client.get("/api/now/table/sys_user_group", {
    params: { sysparm_query: groupQuery, sysparm_limit: 1 },
  })

  if (!groupResponse.data.result || groupResponse.data.result.length === 0) {
    throw new Error(`Group "${group_identifier}" not found`)
  }

  return groupResponse.data.result[0]
}

async function addUserToGroup(client: any, user: any, group: any): Promise<any> {
  // Check if membership already exists
  var existingMembership = await client.get("/api/now/table/sys_user_grmember", {
    params: {
      sysparm_query: `user=${user.sys_id}^group=${group.sys_id}`,
      sysparm_limit: 1,
    },
  })

  if (existingMembership.data.result && existingMembership.data.result.length > 0) {
    return {
      message: `User "${user.user_name}" is already a member of group "${group.name}"`,
      membership_sys_id: existingMembership.data.result[0].sys_id,
      already_exists: true,
    }
  }

  // Create membership
  var membershipData = {
    user: user.sys_id,
    group: group.sys_id,
  }

  var response = await client.post("/api/now/table/sys_user_grmember", membershipData)
  var membership = response.data.result

  return {
    message: `User "${user.user_name}" assigned to group "${group.name}" successfully`,
    membership: {
      sys_id: membership.sys_id,
      user: {
        sys_id: user.sys_id,
        user_name: user.user_name,
        name: user.name,
      },
      group: {
        sys_id: group.sys_id,
        name: group.name,
      },
    },
    already_exists: false,
  }
}

async function removeUserFromGroup(client: any, user: any, group: any): Promise<any> {
  // Find membership
  var membershipResponse = await client.get("/api/now/table/sys_user_grmember", {
    params: {
      sysparm_query: `user=${user.sys_id}^group=${group.sys_id}`,
      sysparm_limit: 1,
    },
  })

  if (!membershipResponse.data.result || membershipResponse.data.result.length === 0) {
    throw new Error(`User "${user.user_name}" is not a member of group "${group.name}"`)
  }

  var membership = membershipResponse.data.result[0]

  // Delete membership
  await client.delete(`/api/now/table/sys_user_grmember/${membership.sys_id}`)

  return {
    message: `User "${user.user_name}" removed from group "${group.name}" successfully`,
    removed_membership: {
      sys_id: membership.sys_id,
      user: {
        sys_id: user.sys_id,
        user_name: user.user_name,
        name: user.name,
      },
      group: {
        sys_id: group.sys_id,
        name: group.name,
      },
    },
  }
}

async function listGroupMembers(client: any, group: any, include_details: boolean): Promise<any> {
  // Get group memberships
  var membershipsResponse = await client.get("/api/now/table/sys_user_grmember", {
    params: {
      sysparm_query: `group=${group.sys_id}`,
      sysparm_limit: 500,
    },
  })

  var memberships = membershipsResponse.data.result || []
  var members = []

  if (include_details && memberships.length > 0) {
    // Get detailed user information for each member
    var userSysIds = memberships.map(function (m: any) {
      return m.user.value || m.user
    })
    var userQuery = `sys_idIN${userSysIds.join(",")}`

    var usersResponse = await client.get("/api/now/table/sys_user", {
      params: {
        sysparm_query: userQuery,
        sysparm_limit: 500,
      },
    })

    var users = usersResponse.data.result || []

    // Create a map of user details
    var userMap: Record<string, any> = {}
    for (var i = 0; i < users.length; i++) {
      userMap[users[i].sys_id] = users[i]
    }

    // Combine membership with user details
    for (var j = 0; j < memberships.length; j++) {
      var membership = memberships[j]
      var userId = membership.user.value || membership.user
      var user = userMap[userId]

      members.push({
        membership_sys_id: membership.sys_id,
        user_sys_id: userId,
        user_name: user ? user.user_name : "Unknown",
        name: user ? user.name : "Unknown",
        email: user ? user.email : undefined,
        title: user ? user.title : undefined,
        department: user ? user.department : undefined,
        active: user ? user.active : undefined,
      })
    }
  } else {
    // Just return basic membership info
    for (var k = 0; k < memberships.length; k++) {
      members.push({
        membership_sys_id: memberships[k].sys_id,
        user_sys_id: memberships[k].user.value || memberships[k].user,
      })
    }
  }

  return {
    group: {
      sys_id: group.sys_id,
      name: group.name,
      description: group.description,
      type: group.type,
    },
    member_count: members.length,
    members: members,
  }
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var action = args.action
  var user_identifier = args.user_identifier
  var group_identifier = args.group_identifier
  var include_details = args.include_details !== undefined ? args.include_details : true

  try {
    var client = await getAuthenticatedClient(context)

    // Resolve group (required for all actions)
    var group = await resolveGroup(client, group_identifier)

    // Handle actions
    if (action === "add") {
      if (!user_identifier) {
        return createErrorResult("user_identifier is required for add action")
      }
      var user = await resolveUser(client, user_identifier)
      var addResult = await addUserToGroup(client, user, group)
      return createSuccessResult(addResult, { user_name: user.user_name, group_name: group.name })
    }

    if (action === "remove") {
      if (!user_identifier) {
        return createErrorResult("user_identifier is required for remove action")
      }
      var user2 = await resolveUser(client, user_identifier)
      var removeResult = await removeUserFromGroup(client, user2, group)
      return createSuccessResult(removeResult, { user_name: user2.user_name, group_name: group.name })
    }

    if (action === "list") {
      var listResult = await listGroupMembers(client, group, include_details)
      return createSuccessResult(listResult, { group_name: group.name, member_count: listResult.member_count })
    }

    return createErrorResult(`Invalid action: ${action}. Must be add, remove, or list`)
  } catch (error) {
    return createErrorResult(error instanceof Error ? error.message : String(error))
  }
}

export var version = "1.0.0"
export var author = "Serac SDK Migration - TIER 3 Merge"
