/**
 * snow_create_saved_filter
 *
 * Creates a saved filter (sys_filter) that users can select in ServiceNow list views.
 * Saved filters store encoded queries and can be user-specific or global.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_saved_filter",
  description: "Create a saved filter for any ServiceNow table that appears in the filter dropdown",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "ui",
  use_cases: ["filters", "saved-filters", "list-views", "ui-customization"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'Filter name that appears in the dropdown (e.g., "My Active High Priority Items")',
      },
      table: {
        type: "string",
        description: 'Table name this filter applies to (e.g., "incident", "change_request")',
      },
      filter: {
        type: "string",
        description: 'Encoded query string (e.g., "active=true^priority=1")',
      },
      user: {
        type: "string",
        description: "User sys_id or username - leave empty for global filter visible to all users",
      },
      roles: {
        type: "string",
        description: 'Comma-separated role names required to see this filter (e.g., "itil,admin")',
      },
      order: {
        type: "number",
        description: "Sort order in the filter dropdown (lower numbers appear first)",
        default: 100,
      },
      active: {
        type: "boolean",
        default: true,
        description: "Whether the filter is active and visible",
      },
    },
    required: ["name", "table", "filter"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, table, filter, user, roles, order = 100, active = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    const filterData: any = {
      name,
      table,
      filter,
      order,
      active,
    }

    if (user) {
      filterData.user = user
    }

    if (roles) {
      filterData.roles = roles
    }

    const response = await client.post("/api/now/table/sys_filter", filterData)

    return createSuccessResult({
      created: true,
      saved_filter: response.data.result,
      message: `Saved filter "${name}" created for ${table} table. ${user ? "User-specific filter." : "Global filter visible to all users."}`,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Team"
