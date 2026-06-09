/**
 * snow_create_template
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_template",
  description: "Save a record template (sys_template) — a named, reusable set of pre-filled field values for a given table that users can apply with one click when creating new records.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "templates",
  use_cases: ["template-creation", "record-templates", "automation"],
  complexity: "beginner",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Template name" },
      table: { type: "string", description: "Table name" },
      template: { type: "object", description: "Template field values" },
      active: { type: "boolean", default: true },
    },
    required: ["name", "table", "template"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, table, template, active = true } = args
  try {
    const client = await getAuthenticatedClient(context)
    const templateData: any = {
      name,
      table,
      template: JSON.stringify(template),
      active,
    }
    const response = await client.post("/api/now/table/sys_template", templateData)
    return createSuccessResult({ created: true, template: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
