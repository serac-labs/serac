/**
 * snow_create_knowledge_base - Create knowledge base
 *
 * Creates a new knowledge base for organizing articles by topic, department, or audience.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_knowledge_base",
  description: "Creates a new knowledge base for organizing articles by topic, department, or audience.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "knowledge",
  use_cases: ["knowledge", "create", "knowledge-base"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Knowledge base title" },
      description: { type: "string", description: "Knowledge base description" },
      owner: { type: "string", description: "Owner user or group" },
      managers: { type: "array", items: { type: "string" }, description: "Manager users or groups" },
      kb_version: { type: "string", description: "Version number" },
      active: { type: "boolean", description: "Active status", default: true },
    },
    required: ["title"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { title, description, owner, managers, kb_version = "1.0", active = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    const kbData: any = {
      title,
      kb_version,
      active,
    }

    if (description) kbData.description = description
    if (owner) kbData.owner = owner
    if (managers) kbData.managers = managers.join(",")

    const response = await client.post("/api/now/table/kb_knowledge_base", kbData)

    return createSuccessResult(
      {
        created: true,
        knowledge_base: response.data.result,
        sys_id: response.data.result.sys_id,
      },
      {
        operation: "create_knowledge_base",
        title,
        version: kb_version,
      },
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
