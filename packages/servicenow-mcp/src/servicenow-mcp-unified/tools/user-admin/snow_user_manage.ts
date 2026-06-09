/**
 * snow_user_manage - Unified User Management
 *
 * User account management: create new users, deactivate accounts.
 *
 * Replaces: snow_create_user, snow_deactivate_user
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_user_manage",
  description: "Unified user management (create, deactivate)",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "user-admin",
  use_cases: ["users", "user-admin", "accounts"],
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
        description: "User management action",
        enum: ["create", "deactivate"],
      },
      // CREATE parameters
      user_name: {
        type: "string",
        description: "[create] Username",
      },
      first_name: {
        type: "string",
        description: "[create] First name",
      },
      last_name: {
        type: "string",
        description: "[create] Last name",
      },
      email: {
        type: "string",
        description: "[create] Email address",
      },
      department: {
        type: "string",
        description: "[create] Department sys_id",
      },
      manager: {
        type: "string",
        description: "[create] Manager sys_id",
      },
      active: {
        type: "boolean",
        description: "[create] Active status",
        default: true,
      },
      // DEACTIVATE parameters
      user_id: {
        type: "string",
        description: "[deactivate] User sys_id",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    switch (action) {
      case "create":
        return await executeCreate(args, context)
      case "deactivate":
        return await executeDeactivate(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== CREATE ====================
async function executeCreate(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { user_name, first_name, last_name, email, department, manager, active = true } = args

  if (!user_name) return createErrorResult("user_name is required for create action")
  if (!first_name) return createErrorResult("first_name is required for create action")
  if (!last_name) return createErrorResult("last_name is required for create action")
  if (!email) return createErrorResult("email is required for create action")

  const client = await getAuthenticatedClient(context)

  const userData: any = { user_name, first_name, last_name, email, active }
  if (department) userData.department = department
  if (manager) userData.manager = manager

  const response = await client.post("/api/now/table/sys_user", userData)

  return createSuccessResult({
    action: "create",
    created: true,
    user: response.data.result,
    sys_id: response.data.result.sys_id,
  })
}

// ==================== DEACTIVATE ====================
async function executeDeactivate(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { user_id } = args

  if (!user_id) {
    return createErrorResult("user_id is required for deactivate action")
  }

  const client = await getAuthenticatedClient(context)

  const response = await client.patch(`/api/now/table/sys_user/${user_id}`, { active: false })

  return createSuccessResult({
    action: "deactivate",
    deactivated: true,
    user: response.data.result,
    sys_id: user_id,
  })
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging - Phase 1"
