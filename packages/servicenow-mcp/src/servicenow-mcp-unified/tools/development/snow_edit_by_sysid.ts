/**
 * snow_edit_by_sysid - Edit artifacts by sys_id
 *
 * Updates specific fields of an artifact using sys_id with validation.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_edit_by_sysid",
  description:
    "Updates specific fields of an artifact using sys_id. Provides direct field-level modifications with validation.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "editing",
  use_cases: ["edit", "update", "direct-modification"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create/update/delete operation
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      sys_id: {
        type: "string",
        description: "System ID of the artifact to edit",
      },
      table: {
        type: "string",
        description: "ServiceNow table name",
      },
      field: {
        type: "string",
        description: "Field name to update (e.g., script, server_script, template)",
      },
      value: {
        type: "string",
        description: "New value for the field",
      },
    },
    required: ["sys_id", "table", "field", "value"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, table, field, value } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Validate artifact exists
    const getResponse = await client.getRecord(table, sys_id)
    if (!getResponse.data?.result) {
      throw new Error(`Artifact with sys_id ${sys_id} not found in table ${table}`)
    }

    const artifact = getResponse.data.result
    const oldValue = artifact[field]

    // Update the field
    const updates: any = {}
    updates[field] = value

    const updateResponse = await client.updateRecord(table, sys_id, updates)

    if (!updateResponse.success) {
      throw new Error("Failed to update artifact")
    }

    return createSuccessResult(
      {
        updated: true,
        sys_id,
        table,
        field,
        name: artifact.name || artifact.title,
        old_value: oldValue ? oldValue.substring(0, 100) + "..." : null,
        new_value: value.substring(0, 100) + "...",
        url: `${context.instanceUrl}/nav_to.do?uri=${table}.do?sys_id=${sys_id}`,
        change_summary: {
          field_updated: field,
          characters_changed: value.length - (oldValue?.length || 0),
        },
      },
      {
        sys_id,
        table,
        field,
      },
    )
  } catch (error: any) {
    // createErrorResult expects SnowFlowError or string, not generic Error
    const errorMessage = error instanceof Error ? error.message : String(error)
    return createErrorResult(errorMessage, {
      sys_id,
      table,
      field,
      errorType: "UNKNOWN_ERROR",
    })
  }
}
