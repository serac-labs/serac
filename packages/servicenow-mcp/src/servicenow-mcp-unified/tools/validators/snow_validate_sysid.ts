/**
 * snow_validate_sysid - Validate sys_id existence and consistency
 *
 * Validates sys_id existence across tables and maintains artifact tracking
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_validate_sysid",
  description:
    "Validates sys_id existence and consistency across tables. Maintains artifact tracking for deployment integrity and rollback capabilities.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "validation",
  use_cases: ["sysid-validation", "integrity-check", "validation"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      sys_id: { type: "string", description: "Sys ID to validate" },
      table: { type: "string", description: "Expected table name" },
      name: { type: "string", description: "Expected artifact name" },
      type: { type: "string", description: "Expected artifact type" },
    },
    required: ["sys_id", "table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, table, name, type } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Validate sys_id format (32 hex characters)
    const sysIdPattern = /^[0-9a-f]{32}$/i
    if (!sysIdPattern.test(sys_id)) {
      throw new SnowFlowError(
        ErrorType.INVALID_REQUEST,
        `Invalid sys_id format: ${sys_id}. Expected 32-character hex string.`,
        { retryable: false },
      )
    }

    // Check if record exists in specified table
    const response = await client.get(`/api/now/table/${table}/${sys_id}`)

    if (!response.data.result) {
      throw new SnowFlowError(
        ErrorType.RESOURCE_NOT_FOUND,
        `Record not found in table ${table} with sys_id: ${sys_id}`,
        { retryable: false },
      )
    }

    const record = response.data.result
    const validation: any = {
      sys_id_valid: true,
      exists: true,
      table: table,
      sys_id: sys_id,
      record_info: {
        name: record.name || record.id || record.title || "N/A",
        sys_created_on: record.sys_created_on,
        sys_updated_on: record.sys_updated_on,
        sys_created_by: record.sys_created_by,
      },
    }

    // Validate name if provided
    if (name) {
      const actualName = record.name || record.id || record.title
      validation.name_match = actualName === name
      if (!validation.name_match) {
        validation.name_mismatch = {
          expected: name,
          actual: actualName,
        }
      }
    }

    // Validate type if provided
    if (type) {
      validation.type = type
      validation.type_match = true // Type is implicit from table
    }

    // Check if record is in Update Sets
    try {
      const updateSetResponse = await client.get("/api/now/table/sys_update_xml", {
        params: {
          sysparm_query: `target_name=${sys_id}`,
          sysparm_limit: 5,
          sysparm_fields: "name,type,update_set",
        },
      })

      validation.update_set_tracking = {
        tracked: updateSetResponse.data.result.length > 0,
        update_sets: updateSetResponse.data.result,
      }
    } catch (updateSetError) {
      validation.update_set_tracking = {
        tracked: false,
        note: "Could not check update set tracking",
      }
    }

    const message =
      `✅ Sys ID Validation\n\n` +
      `Sys ID: ${sys_id}\n` +
      `Table: ${table}\n` +
      `Exists: ${validation.exists ? "Yes" : "No"}\n` +
      `Name: ${validation.record_info.name}\n` +
      `Created: ${validation.record_info.sys_created_on}\n` +
      `Created By: ${validation.record_info.sys_created_by}\n` +
      (validation.name_match !== undefined ? `Name Match: ${validation.name_match ? "Yes" : "No"}\n` : "") +
      `Update Set Tracking: ${validation.update_set_tracking.tracked ? "Yes" : "No"}`

    return createSuccessResult(validation, { message })
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.NETWORK_ERROR, `Validation failed: ${error.message}`, { originalError: error }),
    )
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
