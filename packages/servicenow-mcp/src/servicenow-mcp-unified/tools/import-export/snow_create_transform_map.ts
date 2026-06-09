/**
 * snow_create_transform_map
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_transform_map",
  description: "Create transform map for import sets",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "import-export",
  use_cases: ["transform-maps", "data-transformation", "import"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Transform map name" },
      source_table: { type: "string", description: "Source import table (u_import_table)" },
      target_table: { type: "string", description: "Target table (incident, task, etc.)" },
      run_business_rules: { type: "boolean", default: true },
      description: { type: "string", description: "Transform map description" },
    },
    required: ["name", "source_table", "target_table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, source_table, target_table, run_business_rules = true, description } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Verify source table exists (import tables usually start with u_ or start with import_)
    try {
      const sourceCheck = await client.get(`/api/now/table/sys_db_object`, {
        params: {
          sysparm_query: `name=${source_table}`,
          sysparm_fields: "name,label",
          sysparm_limit: 1,
        },
      })

      if (!sourceCheck.data.result || sourceCheck.data.result.length === 0) {
        throw new SnowFlowError(
          ErrorType.VALIDATION_ERROR,
          `Source table '${source_table}' does not exist. Import tables typically start with 'u_' or 'import_'.`,
          { details: { source_table, suggestion: "Create the import table first or verify the table name" } },
        )
      }
    } catch (error: any) {
      if (error instanceof SnowFlowError) throw error
      // If table check fails, continue anyway (might be permission issue on sys_db_object)
    }

    // Verify target table exists
    try {
      const targetCheck = await client.get(`/api/now/table/sys_db_object`, {
        params: {
          sysparm_query: `name=${target_table}`,
          sysparm_fields: "name,label",
          sysparm_limit: 1,
        },
      })

      if (!targetCheck.data.result || targetCheck.data.result.length === 0) {
        throw new SnowFlowError(ErrorType.VALIDATION_ERROR, `Target table '${target_table}' does not exist`, {
          details: { target_table },
        })
      }
    } catch (error: any) {
      if (error instanceof SnowFlowError) throw error
      // If table check fails, continue anyway
    }

    const transformData: any = {
      name,
      source: source_table,
      target: target_table,
      run_business_rules: run_business_rules ? "true" : "false",
      active: "true",
    }

    if (description) {
      transformData.description = description
    }

    const response = await client.post("/api/now/table/sys_transform_map", transformData)

    return createSuccessResult({
      created: true,
      sys_id: response.data.result.sys_id,
      name: response.data.result.name,
      source_table: response.data.result.source,
      target_table: response.data.result.target,
      transform_map: response.data.result,
    })
  } catch (error: any) {
    // Extract ServiceNow error details
    const snowError = error.response?.data?.error || {}
    const errorMessage = snowError.message || error.message
    const errorDetail = snowError.detail || ""

    if (error.response?.status === 403) {
      throw new SnowFlowError(
        ErrorType.FORBIDDEN,
        `Permission denied: User does not have access to create transform maps. Required role: import_admin or admin.`,
        {
          details: {
            status_code: 403,
            snow_error: snowError,
            error_detail: errorDetail,
            required_roles: ["import_admin", "admin"],
            suggestion: "Request import_admin role or have an admin create the transform map",
          },
        },
      )
    }

    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.VALIDATION_ERROR, `Failed to create transform map: ${errorMessage}`, {
            details: {
              snow_error: snowError,
              error_detail: errorDetail,
              status_code: error.response?.status,
            },
          }),
    )
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
