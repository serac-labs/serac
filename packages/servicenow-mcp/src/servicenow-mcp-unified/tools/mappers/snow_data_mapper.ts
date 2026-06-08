/**
 * snow_data_mapper
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_data_mapper",
  description: "Advanced data mapping with transformations",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "data-utilities",
  use_cases: ["data-mapping", "transformation", "integration"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      data: { type: "array", items: { type: "object" }, description: "Source data array" },
      mapping_rules: { type: "object", description: "Mapping rules" },
    },
    required: ["data", "mapping_rules"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { data, mapping_rules } = args
  try {
    const mapped = data.map((item: any) => {
      const result: any = {}
      for (const [targetField, sourceField] of Object.entries(mapping_rules)) {
        result[targetField] = item[sourceField as string]
      }
      return result
    })

    return createSuccessResult({
      mapped,
      record_count: mapped.length,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
