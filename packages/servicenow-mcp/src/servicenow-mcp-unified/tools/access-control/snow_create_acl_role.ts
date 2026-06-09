/**
 * snow_create_acl_role
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_acl_role",
  description: "Link a role (sys_user_role) to an existing ACL by creating a sys_security_acl_role record. After linking, anyone holding that role is granted access under the ACL's table/operation/condition.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "access-control",
  use_cases: ["acl", "roles", "security"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      acl: { type: "string", description: "ACL sys_id" },
      role: { type: "string", description: "Role sys_id" },
    },
    required: ["acl", "role"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { acl, role } = args
  try {
    const client = await getAuthenticatedClient(context)
    const aclRoleData = { sys_security_acl: acl, sys_user_role: role }
    const response = await client.post("/api/now/table/sys_security_acl_role", aclRoleData)
    return createSuccessResult({ created: true, acl_role: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
