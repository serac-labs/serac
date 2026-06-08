/**
 * snow_format_number
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_format_number",
  description: "Format a number as a decimal, currency (with code prefix), or percent, with a configurable decimal precision (default 2). Local operation — no ServiceNow call.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "utilities",
  use_cases: ["formatting", "numbers", "conversion"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "Number to format" },
      type: { type: "string", enum: ["decimal", "currency", "percent"], default: "decimal" },
      decimals: { type: "number", default: 2 },
      currency: { type: "string", default: "USD" },
    },
    required: ["number"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { number, type = "decimal", decimals = 2, currency = "USD" } = args
  try {
    let formatted = ""

    switch (type) {
      case "decimal":
        formatted = number.toFixed(decimals)
        break
      case "currency":
        formatted = `${currency} ${number.toFixed(decimals)}`
        break
      case "percent":
        formatted = `${(number * 100).toFixed(decimals)}%`
        break
    }

    return createSuccessResult({
      formatted,
      type,
      original: number,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
