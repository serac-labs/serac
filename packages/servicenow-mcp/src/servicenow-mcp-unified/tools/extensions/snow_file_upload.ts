/**
 * snow_file_upload
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_file_upload",
  description: "Upload a base64-encoded file as an attachment on a specific record (table + sys_id), with file name and MIME type. Equivalent to snow_upload_attachment — pick whichever fits your naming.",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "attachments",
  use_cases: ["files", "upload", "attachments"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create/update/delete operation
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      file_name: { type: "string", description: "File name" },
      content_type: { type: "string", description: "Content type" },
      file_data: { type: "string", description: "Base64 encoded file data" },
      table: { type: "string", description: "Target table" },
      record_sys_id: { type: "string", description: "Record sys_id" },
    },
    required: ["file_name", "file_data", "table", "record_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { file_name, content_type = "application/octet-stream", file_data, table, record_sys_id } = args
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.post(
      `/api/now/attachment/file?table_name=${table}&table_sys_id=${record_sys_id}&file_name=${file_name}`,
      Buffer.from(file_data, "base64"),
      {
        headers: {
          "Content-Type": content_type,
        },
      },
    )

    return createSuccessResult({
      uploaded: true,
      attachment: response.data.result,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
