/**
 * snow_create_web_service - SOAP Web Service integration
 *
 * Create SOAP web service integrations from WSDL definitions.
 * Configures authentication and namespace settings.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_web_service",
  description: "Create SOAP web service integration from WSDL definition",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "soap",
  use_cases: ["integration", "soap", "web-service"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Web Service name",
      },
      wsdlUrl: {
        type: "string",
        description: "WSDL URL or location",
      },
      description: {
        type: "string",
        description: "Web Service description",
      },
      authType: {
        type: "string",
        enum: ["none", "basic", "wsse", "oauth2"],
        description: "Authentication type",
        default: "none",
      },
      namespace: {
        type: "string",
        description: "Service namespace",
      },
      username: {
        type: "string",
        description: "Username for basic/WSSE authentication",
      },
      password: {
        type: "string",
        description: "Password for basic/WSSE authentication",
      },
      active: {
        type: "boolean",
        description: "Active flag",
        default: true,
      },
    },
    required: ["name", "wsdlUrl"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    wsdlUrl,
    description = "",
    authType = "none",
    namespace = "",
    username = "",
    password = "",
    active = true,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    const webServiceData: any = {
      name,
      wsdl_url: wsdlUrl,
      description,
      authentication_type: authType,
      namespace,
      active,
    }

    if (authType === "basic" || authType === "wsse") {
      webServiceData.user_name = username
      webServiceData.password = password
    }

    const response = await client.post("/api/now/table/sys_web_service", webServiceData)
    const webService = response.data.result

    return createSuccessResult({
      created: true,
      web_service: {
        sys_id: webService.sys_id,
        name: webService.name,
        wsdl_url: wsdlUrl,
        authentication_type: authType,
        namespace,
        active,
      },
      message: `SOAP Web Service '${name}' created successfully`,
      next_steps: [
        "Import operations from WSDL",
        "Configure authentication credentials",
        "Test web service operations",
        "Create service consumers",
      ],
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
