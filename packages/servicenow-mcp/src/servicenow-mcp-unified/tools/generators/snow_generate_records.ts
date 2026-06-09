/**
 * snow_generate_records
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_generate_records",
  description: "Generate multiple test records",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "testing",
  use_cases: ["test-data", "data-generation", "testing"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table name" },
      count: { type: "number", description: "Number of records to generate", default: 10 },
      template: { type: "object", description: "Template for generated records" },
    },
    required: ["table", "template"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, count = 10, template } = args
  try {
    const client = await getAuthenticatedClient(context)
    const createPromises = []

    for (let i = 0; i < count; i++) {
      const recordData = { ...template }
      createPromises.push(client.post(`/api/now/table/${table}`, recordData))
    }

    const results = await Promise.all(createPromises)
    return createSuccessResult({
      generated: true,
      count: results.length,
      records: results.map((r) => r.data.result),
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
