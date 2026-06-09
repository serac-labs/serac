/**
 * snow_create_uib_page_registry - Configure URL routing
 *
 * Creates page registry entries to configure URL routing and
 * access control for UI Builder pages.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_uib_page_registry",
  description: "Configure URL routing and access control for UI Builder pages",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-builder",
  subcategory: "routing",
  use_cases: ["ui-builder", "routing", "access-control"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      page_id: {
        type: "string",
        description: "Target page sys_id",
      },
      route: {
        type: "string",
        description: 'URL route (e.g., "/my-page")',
      },
      roles: {
        type: "array",
        items: { type: "string" },
        description: "Required roles to access page",
        default: [],
      },
      public: {
        type: "boolean",
        description: "Make page publicly accessible",
        default: false,
      },
      active: {
        type: "boolean",
        description: "Active state",
        default: true,
      },
    },
    required: ["page_id", "route"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { page_id, route, roles = [], public: isPublic = false, active = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    const response = await client.post("/api/now/table/sys_ux_app_route", {
      page: page_id,
      route,
      roles: roles.join(","),
      public: isPublic,
      active,
    })

    return createSuccessResult({
      registry: {
        sys_id: response.data.result.sys_id,
        route,
        page_id,
        url: `${context.instanceUrl}${route}`,
      },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
