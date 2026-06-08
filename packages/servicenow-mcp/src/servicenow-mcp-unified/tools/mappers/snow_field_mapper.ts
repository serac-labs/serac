/**
 * snow_field_mapper
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_field_mapper",
  description: "Project a source object into a new shape using a target-field → source-field mapping. Useful for shaping data between systems (e.g. inbound integration payload → ServiceNow record fields).",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "data-utilities",
  use_cases: ["field-mapping", "schema-transformation", "integration"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      source_data: { type: "object", description: "Source data" },
      field_mapping: { type: "object", description: "Field mapping rules" },
    },
    required: ["source_data", "field_mapping"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { source_data, field_mapping } = args
  try {
    const mapped: any = {}

    for (const [targetField, sourceField] of Object.entries(field_mapping)) {
      mapped[targetField] = source_data[sourceField as string]
    }

    return createSuccessResult({
      mapped,
      field_count: Object.keys(mapped).length,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
