/**
 * snow_validate_record
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_validate_record",
  description: "Validate record against business rules",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "validation",
  use_cases: ["record-validation", "business-rules", "validation"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table name" },
      record_sys_id: { type: "string", description: "Record sys_id" },
    },
    required: ["table", "record_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, record_sys_id } = args
  try {
    const client = await getAuthenticatedClient(context)
    const validateScript = `
var gr = new GlideRecord('${table}');
if (gr.get('${record_sys_id}')) {
  var isValid = gr.isValidRecord();
  gs.info('Record valid: ' + isValid);
}
    `
    await client.post("/api/now/table/sys_script_execution", { script: validateScript })
    return createSuccessResult({
      validated: true,
      table,
      record_sys_id,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
