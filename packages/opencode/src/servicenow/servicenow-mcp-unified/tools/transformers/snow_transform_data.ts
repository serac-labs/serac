/**
 * snow_transform_data
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_transform_data",
  description: "Transform data using field mappings",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "data-utilities",
  use_cases: ["data-transformation", "field-mapping", "integration"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Transformation function - transforms data locally without ServiceNow modification
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      source_data: { type: "object", description: "Source data" },
      field_mappings: { type: "object", description: "Field mapping rules" },
    },
    required: ["source_data", "field_mappings"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { source_data, field_mappings } = args
  try {
    const transformed: any = {}

    for (const [targetField, sourceField] of Object.entries(field_mappings)) {
      transformed[targetField] = source_data[sourceField as string]
    }

    return createSuccessResult({
      transformed: true,
      data: transformed,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
