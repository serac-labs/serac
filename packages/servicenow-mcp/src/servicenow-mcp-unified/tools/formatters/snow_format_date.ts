/**
 * snow_format_date
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_format_date",
  description: "Format a date string in one of four shapes: ISO date (YYYY-MM-DD), ISO datetime, ISO time, or human-readable relative (e.g. '5 minutes ago'). Local operation — no ServiceNow call.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "utilities",
  use_cases: ["formatting", "dates", "conversion"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Utility function - formats date locally
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "Date to format" },
      format: { type: "string", enum: ["date", "datetime", "time", "relative"], default: "datetime" },
    },
    required: ["date"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { date, format = "datetime" } = args
  try {
    const dateObj = new Date(date)
    let formatted = ""

    switch (format) {
      case "date":
        formatted = dateObj.toISOString().split("T")[0]
        break
      case "datetime":
        formatted = dateObj.toISOString()
        break
      case "time":
        formatted = dateObj.toISOString().split("T")[1]
        break
      case "relative":
        const now = new Date()
        const diffMs = now.getTime() - dateObj.getTime()
        const diffMins = Math.floor(diffMs / 60000)
        formatted =
          diffMins < 60
            ? `${diffMins} minutes ago`
            : diffMins < 1440
              ? `${Math.floor(diffMins / 60)} hours ago`
              : `${Math.floor(diffMins / 1440)} days ago`
        break
    }

    return createSuccessResult({
      formatted,
      format,
      original: date,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
