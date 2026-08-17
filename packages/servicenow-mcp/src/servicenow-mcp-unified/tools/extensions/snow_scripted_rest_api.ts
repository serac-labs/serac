/**
 * snow_scripted_rest_api
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_scripted_rest_api",
  description: "Invoke an EXISTING Scripted REST API resource at /api/<namespace>/<path> with chosen method (GET/POST/PUT/PATCH/DELETE) and optional JSON body. This is a client: it calls endpoints, it does not create them — to author a Scripted REST API (sys_ws_definition + sys_ws_operation) use snow_scripted_rest_api_manage. For the stock table API use snow_custom_api.",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "rest-api",
  use_cases: ["rest", "api", "integration"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      api_namespace: { type: "string", description: "API namespace" },
      api_path: { type: "string", description: "API path" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET" },
      body: { type: "object", description: "Request body" },
    },
    required: ["api_namespace", "api_path"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { api_namespace, api_path, method = "GET", body } = args
  try {
    const client = await getAuthenticatedClient(context)
    const fullPath = `/api/${api_namespace}/${api_path}`

    let response
    if (method === "GET") {
      response = await client.get(fullPath)
    } else if (method === "POST") {
      response = await client.post(fullPath, body)
    } else if (method === "PUT") {
      response = await client.put(fullPath, body)
    } else if (method === "PATCH") {
      response = await client.patch(fullPath, body)
    } else if (method === "DELETE") {
      response = await client.delete(fullPath)
    }

    return createSuccessResult({
      success: true,
      api_namespace,
      api_path,
      data: response?.data,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
