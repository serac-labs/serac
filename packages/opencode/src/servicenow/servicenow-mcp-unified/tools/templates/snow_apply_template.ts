/**
 * snow_apply_template
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_apply_template",
  description: "Apply template to create record",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "crud",
  use_cases: ["templates", "record-creation", "automation"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      template_sys_id: { type: "string", description: "Template sys_id" },
      additional_values: { type: "object", description: "Additional field values" },
    },
    required: ["template_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { template_sys_id, additional_values = {} } = args
  try {
    const client = await getAuthenticatedClient(context)
    const templateRecord = await client.get(`/api/now/table/sys_template/${template_sys_id}`)
    const table = templateRecord.data.result.table
    const templateData = JSON.parse(templateRecord.data.result.template)
    const recordData = { ...templateData, ...additional_values }
    const response = await client.post(`/api/now/table/${table}`, recordData)
    return createSuccessResult({ created: true, record: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
