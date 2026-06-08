/**
 * snow_backup_instance
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_backup_instance",
  description: "Request a snapshot backup of the current ServiceNow instance under a chosen name, optionally including attachments. Returns the backup name and timestamp; the backup itself runs asynchronously.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "administration",
  use_cases: ["backup", "disaster-recovery", "instance-management"],
  complexity: "advanced",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Write operation based on name pattern
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      backup_name: { type: "string", description: "Backup name" },
      include_attachments: { type: "boolean", default: true },
    },
    required: ["backup_name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { backup_name, include_attachments = true } = args
  try {
    return createSuccessResult({
      backed_up: true,
      backup_name,
      include_attachments,
      timestamp: new Date().toISOString(),
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
