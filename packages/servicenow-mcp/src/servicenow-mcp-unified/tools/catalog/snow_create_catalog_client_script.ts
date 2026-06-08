/**
 * snow_create_catalog_client_script - Create catalog client script
 *
 * Creates client scripts for catalog items to add custom JavaScript behavior to forms.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_catalog_client_script",
  description: "Creates client scripts for catalog items to add custom JavaScript behavior to forms.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "service-catalog",
  use_cases: ["catalog", "client-scripts", "form-behavior"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      cat_item: { type: "string", description: "Catalog item sys_id" },
      name: { type: "string", description: "Script name" },
      script: { type: "string", description: "JavaScript code" },
      type: { type: "string", description: "Type: onLoad, onChange, onSubmit, onCellEdit" },
      applies_to: { type: "string", description: "Applies to: item, set, variable" },
      variable: { type: "string", description: "Variable name (for onChange)" },
      active: { type: "boolean", description: "Active status", default: true },
    },
    required: ["cat_item", "name", "script", "type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { cat_item, name, script, type, applies_to = "item", variable, active = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    const scriptData: any = {
      cat_item,
      name,
      script,
      type,
      applies_to,
      active,
    }

    if (variable) scriptData.cat_variable = variable

    const response = await client.post("/api/now/table/catalog_script_client", scriptData)

    return createSuccessResult(
      {
        created: true,
        client_script: response.data.result,
        sys_id: response.data.result.sys_id,
      },
      {
        operation: "create_catalog_client_script",
        name,
        type,
      },
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
