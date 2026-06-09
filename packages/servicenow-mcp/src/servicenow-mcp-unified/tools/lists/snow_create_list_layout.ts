/**
 * snow_create_list_layout
 *
 * Creates a complete list layout (sys_ui_list) with multiple columns for any ServiceNow table.
 * This defines which fields appear in list views and their order/width.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_list_layout",
  description: "Create a complete list layout with multiple columns for any ServiceNow table",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "ui",
  use_cases: ["lists", "list-layouts", "views", "ui-customization", "columns"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: 'Table name this layout applies to (e.g., "incident", "change_request")',
      },
      view: {
        type: "string",
        description:
          'View name - use "" (empty string) for default view, "mobile" for mobile view, or custom view name',
        default: "",
      },
      columns: {
        type: "array",
        description: "Array of column definitions with field names, positions, and optional widths",
        items: {
          type: "object",
          properties: {
            field: {
              type: "string",
              description: 'Field name to display (e.g., "number", "short_description", "priority")',
            },
            position: {
              type: "number",
              description: "Column position (0 = first column, 1 = second, etc.)",
            },
            width: {
              type: "number",
              description: "Column width in pixels (optional, defaults to auto)",
            },
          },
          required: ["field", "position"],
        },
      },
      relationship: {
        type: "string",
        description: 'For related lists, specify the relationship field (e.g., "parent" for child records)',
      },
      parent: {
        type: "string",
        description: "For related lists, specify the parent table name",
      },
    },
    required: ["table", "columns"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, view = "", columns, relationship, parent } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Validate columns array
    if (!Array.isArray(columns) || columns.length === 0) {
      return createErrorResult("columns must be a non-empty array")
    }

    // Sort columns by position to ensure correct order
    const sortedColumns = [...columns].sort((a, b) => a.position - b.position)

    const createdColumns: any[] = []
    const errors: string[] = []

    // Create each column in sys_ui_list
    for (const column of sortedColumns) {
      try {
        const columnData: any = {
          name: table,
          element: column.field,
          position: column.position,
        }

        // Add optional fields
        if (view !== undefined) columnData.view = view
        if (column.width) columnData.width = column.width
        if (relationship) columnData.relationship = relationship
        if (parent) columnData.parent = parent

        const response = await client.post("/api/now/table/sys_ui_list", columnData)
        createdColumns.push({
          field: column.field,
          position: column.position,
          sys_id: response.data.result.sys_id,
        })
      } catch (error: any) {
        errors.push(`Failed to create column ${column.field}: ${error.message}`)
      }
    }

    // Build response
    const isRelatedList = !!relationship && !!parent
    const viewDescription = view ? `view "${view}"` : "default view"
    const layoutType = isRelatedList ? `related list (${parent}.${relationship})` : "main list"

    if (errors.length > 0) {
      return createSuccessResult({
        created: true,
        partial_success: true,
        table,
        view,
        layout_type: layoutType,
        columns_created: createdColumns.length,
        columns_failed: errors.length,
        created_columns: createdColumns,
        errors,
        message: `List layout partially created for ${table} ${layoutType}, ${viewDescription}. ${createdColumns.length}/${columns.length} columns created successfully.`,
      })
    }

    return createSuccessResult({
      created: true,
      table,
      view,
      layout_type: layoutType,
      columns_count: createdColumns.length,
      columns: createdColumns,
      message: `List layout created for ${table} ${layoutType}, ${viewDescription} with ${createdColumns.length} columns.`,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Team"
