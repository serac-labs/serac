/**
 * snow_create_acl
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_acl",
  description: "Create Access Control List rule",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "access-control",
  use_cases: ["acl", "security", "permissions"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "ACL name" },
      operation: { type: "string", enum: ["read", "write", "create", "delete"], description: "Operation type" },
      type: { type: "string", description: "ACL type (record/field)" },
      admin_overrides: { type: "boolean", default: true },
      active: { type: "boolean", default: true },
    },
    required: ["name", "operation"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, operation, type, admin_overrides = true, active = true } = args
  try {
    const client = await getAuthenticatedClient(context)
    const aclData: any = { name, operation, admin_overrides, active }
    if (type) aclData.type = type
    const response = await client.post("/api/now/table/sys_security_acl", aclData)
    return createSuccessResult({ created: true, acl: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
