/**
 * snow_create_field_map - Field mapping for transform maps
 *
 * Create field mappings within transform maps. Supports data transformation,
 * coalescing, and default values.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_field_map",
  description: "Create field mapping within transform map for data transformation",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "data-transformation",
  use_cases: ["integration", "transformation", "mapping"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      transformMapName: {
        type: "string",
        description: "Parent Transform Map name or sys_id",
      },
      sourceField: {
        type: "string",
        description: "Source field name",
      },
      targetField: {
        type: "string",
        description: "Target field name",
      },
      transform: {
        type: "string",
        description: "Transform script (JavaScript to transform value)",
      },
      coalesce: {
        type: "boolean",
        description: "Use as coalesce field for matching records",
        default: false,
      },
      defaultValue: {
        type: "string",
        description: "Default value if source is empty",
      },
      choice: {
        type: "boolean",
        description: "Use choice list for mapping",
        default: false,
      },
    },
    required: ["transformMapName", "sourceField", "targetField"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    transformMapName,
    sourceField,
    targetField,
    transform = "",
    coalesce = false,
    defaultValue = "",
    choice = false,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Find transform map
    let transformMapId = transformMapName
    if (!transformMapName.match(/^[a-f0-9]{32}$/)) {
      const mapQuery = await client.get("/api/now/table/sys_transform_map", {
        params: {
          sysparm_query: `name=${transformMapName}`,
          sysparm_limit: 1,
        },
      })

      if (!mapQuery.data.result || mapQuery.data.result.length === 0) {
        throw new Error(`Transform Map '${transformMapName}' not found`)
      }
      transformMapId = mapQuery.data.result[0].sys_id
    }

    const fieldMapData = {
      map: transformMapId,
      source_field: sourceField,
      target_field: targetField,
      transform,
      coalesce,
      default_value: defaultValue,
      choice,
    }

    const response = await client.post("/api/now/table/sys_transform_entry", fieldMapData)
    const fieldMap = response.data.result

    return createSuccessResult({
      created: true,
      field_map: {
        sys_id: fieldMap.sys_id,
        transform_map: transformMapId,
        source_field: sourceField,
        target_field: targetField,
        has_transform: !!transform,
        coalesce,
        has_default: !!defaultValue,
        choice,
      },
      message: `Field mapping '${sourceField}' → '${targetField}' created successfully`,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
