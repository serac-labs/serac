/**
 * snow_create_ci - Create Configuration Items
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_ci",
  description: "Create Configuration Item in CMDB",
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "crud",
  use_cases: ["cmdb", "create", "configuration-item"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      ci_class: { type: "string", description: "CI class (cmdb_ci_server, cmdb_ci_app, etc.)" },
      name: { type: "string", description: "CI name" },
      attributes: { type: "object", description: "CI attributes" },
      operational_status: { type: "string", description: "Operational status" },
      asset_tag: { type: "string", description: "Asset tag" },
    },
    required: ["ci_class", "name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { ci_class, name, attributes = {}, operational_status, asset_tag } = args
  try {
    const client = await getAuthenticatedClient(context)
    const ciData: any = { name, ...attributes }
    if (operational_status) ciData.operational_status = operational_status
    if (asset_tag) ciData.asset_tag = asset_tag
    const response = await client.post(`/api/now/table/${ci_class}`, ciData)
    return createSuccessResult({ created: true, ci: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
