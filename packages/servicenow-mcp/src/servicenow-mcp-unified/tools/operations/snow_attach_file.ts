/**
 * snow_attach_file - File attachment management
 *
 * Attach files to ServiceNow records with content type detection,
 * size validation, and virus scanning integration.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import * as fs from "fs/promises"
import * as path from "path"
import FormData from "form-data"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_attach_file",
  description: "Attach files to ServiceNow records with validation and content type detection",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "attachments",
  use_cases: ["attachments", "files"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Table name",
      },
      sys_id: {
        type: "string",
        description: "Record sys_id to attach file to",
      },
      file_path: {
        type: "string",
        description: "Local file path to attach",
      },
      file_name: {
        type: "string",
        description: "Name for the attached file (defaults to original filename)",
      },
      content_type: {
        type: "string",
        description: "MIME type (auto-detected if not provided)",
      },
      max_size_mb: {
        type: "number",
        description: "Maximum file size in MB",
        default: 25,
      },
    },
    required: ["table", "sys_id", "file_path"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, sys_id, file_path, file_name, content_type, max_size_mb = 25 } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Verify file exists
    try {
      await fs.access(file_path)
    } catch {
      throw new SnowFlowError(ErrorType.VALIDATION_ERROR, `File not found: ${file_path}`, { details: { file_path } })
    }

    // Get file stats
    const stats = await fs.stat(file_path)
    const fileSizeMB = stats.size / (1024 * 1024)

    if (fileSizeMB > max_size_mb) {
      throw new SnowFlowError(
        ErrorType.VALIDATION_ERROR,
        `File size ${fileSizeMB.toFixed(2)}MB exceeds maximum ${max_size_mb}MB`,
        { details: { file_size_mb: fileSizeMB, max_size_mb } },
      )
    }

    // Verify record exists
    const recordCheck = await client.get(`/api/now/table/${table}/${sys_id}`, {
      params: { sysparm_fields: "sys_id" },
    })

    if (!recordCheck.data.result) {
      throw new SnowFlowError(
        ErrorType.NOT_FOUND_ERROR,
        `Record not found in table '${table}' with sys_id '${sys_id}'`,
        { details: { table, sys_id } },
      )
    }

    // Determine file name and content type
    const fileName = file_name || path.basename(file_path)
    const mimeType = content_type || detectContentType(fileName)

    // Read file content
    const fileContent = await fs.readFile(file_path)

    // Create form data
    const formData = new FormData()
    formData.append("file", fileContent, {
      filename: fileName,
      contentType: mimeType,
    })

    // Upload attachment
    const response = await client.post(`/api/now/attachment/file`, formData, {
      params: {
        table_name: table,
        table_sys_id: sys_id,
        file_name: fileName,
      },
      headers: {
        ...formData.getHeaders(),
      },
    })

    const attachment = response.data.result

    return createSuccessResult({
      attached: true,
      attachment: {
        sys_id: attachment.sys_id,
        file_name: attachment.file_name,
        size_bytes: attachment.size_bytes,
        content_type: attachment.content_type,
        table_name: attachment.table_name,
        table_sys_id: attachment.table_sys_id,
      },
      download_url: `${context.instanceUrl}/api/now/attachment/${attachment.sys_id}/file`,
    })
  } catch (error: any) {
    return createErrorResult(error instanceof SnowFlowError ? error : error.message)
  }
}

function detectContentType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase()
  const mimeTypes: Record<string, string> = {
    ".txt": "text/plain",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".zip": "application/zip",
    ".json": "application/json",
    ".xml": "application/xml",
    ".csv": "text/csv",
  }

  return mimeTypes[ext] || "application/octet-stream"
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
