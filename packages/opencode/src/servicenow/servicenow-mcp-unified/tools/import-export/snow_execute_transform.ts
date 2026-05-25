/**
 * snow_execute_transform
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_execute_transform",
  description: "Execute transform map on import set",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "import-export",
  use_cases: ["data-transformation", "import", "processing"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Execution operation - can have side effects
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      import_set_sys_id: { type: "string", description: "Import set sys_id" },
      transform_map_sys_id: { type: "string", description: "Transform map sys_id" },
    },
    required: ["import_set_sys_id", "transform_map_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { import_set_sys_id, transform_map_sys_id } = args
  try {
    const client = await getAuthenticatedClient(context)
    const transformScript = `
var transformer = new GlideTransformMap();
transformer.setTransformMap('${transform_map_sys_id}');
transformer.transformImportSet('${import_set_sys_id}');
    `
    const response = await client.post("/api/now/table/sys_script_execution", {
      script: transformScript,
    })
    return createSuccessResult({
      executed: true,
      import_set: import_set_sys_id,
      transform_map: transform_map_sys_id,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
