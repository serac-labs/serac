/**
 * snow_diff_objects
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_diff_objects",
  description: "Compare two objects and get differences",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "data-utilities",
  use_cases: ["comparison", "diff", "data-analysis"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      object1: { type: "object", description: "First object" },
      object2: { type: "object", description: "Second object" },
    },
    required: ["object1", "object2"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { object1, object2 } = args
  try {
    const keys1 = Object.keys(object1)
    const keys2 = Object.keys(object2)
    const allKeys = [...new Set([...keys1, ...keys2])]

    const differences: any = {}
    let changeCount = 0

    allKeys.forEach((key) => {
      if (object1[key] !== object2[key]) {
        differences[key] = {
          old: object1[key],
          new: object2[key],
        }
        changeCount++
      }
    })

    return createSuccessResult({
      has_differences: changeCount > 0,
      change_count: changeCount,
      differences,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
