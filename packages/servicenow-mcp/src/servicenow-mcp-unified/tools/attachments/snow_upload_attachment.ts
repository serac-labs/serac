/**
 * snow_upload_attachment
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_upload_attachment",
  description: "Attach a base64-encoded file to a specific record (table_name + table_sys_id) with file name and optional MIME type. Returns the new attachment metadata.",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "attachments",
  use_cases: ["attachments", "upload", "file-management"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table_name: { type: "string", description: "Table name" },
      table_sys_id: { type: "string", description: "Record sys_id" },
      file_name: { type: "string", description: "File name" },
      content_type: { type: "string", description: "MIME type" },
      content: { type: "string", description: "Base64 encoded content" },
    },
    required: ["table_name", "table_sys_id", "file_name", "content"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table_name, table_sys_id, file_name, content_type = "application/octet-stream", content } = args
  try {
    const client = await getAuthenticatedClient(context)
    const response = await client.post(
      `/api/now/attachment/file?table_name=${table_name}&table_sys_id=${table_sys_id}&file_name=${file_name}`,
      Buffer.from(content, "base64"),
      {
        headers: {
          "Content-Type": content_type,
        },
      },
    )
    return createSuccessResult({ uploaded: true, attachment: response.data.result })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
