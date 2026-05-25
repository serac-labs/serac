/**
 * snow_role_group_manage - Unified Role & Group Management
 *
 * Role and group management: create roles, assign roles, create groups.
 *
 * Replaces: snow_create_role, snow_assign_role, snow_create_group
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_role_group_manage",
  description: "Unified role and group management (create_role, assign_role, create_group)",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "user-admin",
  use_cases: ["roles", "groups", "permissions", "user-admin"],
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
        description: "Role/group management action",
        enum: ["create_role", "assign_role", "create_group"],
      },
      // CREATE_ROLE parameters
      name: {
        type: "string",
        description: "[create_role/create_group] Role or group name",
      },
      description: {
        type: "string",
        description: "[create_role/create_group] Description",
      },
      requires_subscription: {
        type: "string",
        description: "[create_role] Required subscription",
      },
      // ASSIGN_ROLE parameters
      role: {
        type: "string",
        description: "[assign_role] Role sys_id",
      },
      user: {
        type: "string",
        description: "[assign_role] User sys_id (user or group required)",
      },
      group: {
        type: "string",
        description: "[assign_role/create_group] Group sys_id or manager sys_id",
      },
      inherited: {
        type: "boolean",
        description: "[assign_role] Inherited assignment",
        default: false,
      },
      // CREATE_GROUP parameters
      manager: {
        type: "string",
        description: "[create_group] Manager sys_id",
      },
      type: {
        type: "string",
        description: "[create_group] Group type",
      },
      active: {
        type: "boolean",
        description: "[create_group] Active status",
        default: true,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    switch (action) {
      case "create_role":
        return await executeCreateRole(args, context)
      case "assign_role":
        return await executeAssignRole(args, context)
      case "create_group":
        return await executeCreateGroup(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== CREATE ROLE ====================
async function executeCreateRole(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, description, requires_subscription } = args

  if (!name) {
    return createErrorResult("name is required for create_role action")
  }

  const client = await getAuthenticatedClient(context)

  const roleData: any = { name }
  if (description) roleData.description = description
  if (requires_subscription) roleData.requires_subscription = requires_subscription

  const response = await client.post("/api/now/table/sys_user_role", roleData)

  return createSuccessResult({
    action: "create_role",
    created: true,
    role: response.data.result,
    sys_id: response.data.result.sys_id,
  })
}

// ==================== ASSIGN ROLE ====================
async function executeAssignRole(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { role, user, group, inherited = false } = args

  if (!role) {
    return createErrorResult("role is required for assign_role action")
  }

  if (!user && !group) {
    return createErrorResult("Either user or group must be specified for assign_role action")
  }

  const client = await getAuthenticatedClient(context)

  const assignmentData: any = { role, inherited }
  if (user) assignmentData.user = user
  if (group) assignmentData.group = group

  const response = await client.post("/api/now/table/sys_user_has_role", assignmentData)

  return createSuccessResult({
    action: "assign_role",
    assigned: true,
    assignment: response.data.result,
    sys_id: response.data.result.sys_id,
  })
}

// ==================== CREATE GROUP ====================
async function executeCreateGroup(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, description, manager, type, active = true } = args

  if (!name) {
    return createErrorResult("name is required for create_group action")
  }

  const client = await getAuthenticatedClient(context)

  const groupData: any = { name, active }
  if (description) groupData.description = description
  if (manager) groupData.manager = manager
  if (type) groupData.type = type

  const response = await client.post("/api/now/table/sys_user_group", groupData)

  return createSuccessResult({
    action: "create_group",
    created: true,
    group: response.data.result,
    sys_id: response.data.result.sys_id,
  })
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging - Phase 1"
