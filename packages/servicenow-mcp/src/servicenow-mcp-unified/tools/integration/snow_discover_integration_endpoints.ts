/**
 * snow_discover_integration_endpoints - Integration endpoint discovery
 *
 * Discover existing integration endpoints in the instance.
 * Filters by type: REST, SOAP, LDAP, or EMAIL.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_discover_integration_endpoints",
  description: "Discover existing integration endpoints (REST, SOAP, LDAP, EMAIL)",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "discovery",
  use_cases: ["integration", "discovery", "endpoints"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Discovery operation - reads metadata
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["all", "REST", "SOAP", "LDAP", "EMAIL"],
        description: "Filter by endpoint type",
        default: "all",
      },
      limit: {
        type: "number",
        description: "Maximum results per type",
        default: 50,
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { type = "all", limit = 50 } = args

  try {
    const client = await getAuthenticatedClient(context)
    const endpoints: any[] = []

    // Discover REST Messages
    if (type === "all" || type === "REST") {
      const restResponse = await client.get("/api/now/table/sys_rest_message", {
        params: { sysparm_limit: limit },
      })

      if (restResponse.data.result) {
        endpoints.push({
          type: "REST Messages",
          count: restResponse.data.result.length,
          endpoints: restResponse.data.result.map((msg: any) => ({
            name: msg.name,
            endpoint: msg.endpoint,
            auth_type: msg.authentication_type,
            use_mid_server: msg.use_mid_server,
            sys_id: msg.sys_id,
          })),
        })
      }
    }

    // Discover Web Services (SOAP)
    if (type === "all" || type === "SOAP") {
      const soapResponse = await client.get("/api/now/table/sys_web_service", {
        params: { sysparm_limit: limit },
      })

      if (soapResponse.data.result) {
        endpoints.push({
          type: "Web Services (SOAP)",
          count: soapResponse.data.result.length,
          endpoints: soapResponse.data.result.map((ws: any) => ({
            name: ws.name,
            wsdl_url: ws.wsdl_url,
            namespace: ws.namespace,
            auth_type: ws.authentication_type,
            sys_id: ws.sys_id,
          })),
        })
      }
    }

    // Discover LDAP Servers
    if (type === "all" || type === "LDAP") {
      const ldapResponse = await client.get("/api/now/table/ldap_server_config", {
        params: { sysparm_limit: limit },
      })

      if (ldapResponse.data.result) {
        endpoints.push({
          type: "LDAP Servers",
          count: ldapResponse.data.result.length,
          endpoints: ldapResponse.data.result.map((ldap: any) => ({
            name: ldap.name,
            server: ldap.server,
            port: ldap.port,
            ssl_enabled: ldap.use_ssl,
            sys_id: ldap.sys_id,
          })),
        })
      }
    }

    // Discover Email Accounts
    if (type === "all" || type === "EMAIL") {
      const emailResponse = await client.get("/api/now/table/sys_email_account", {
        params: { sysparm_limit: limit },
      })

      if (emailResponse.data.result) {
        endpoints.push({
          type: "Email Accounts",
          count: emailResponse.data.result.length,
          endpoints: emailResponse.data.result.map((email: any) => ({
            name: email.name,
            server: email.server,
            port: email.port,
            type: email.type,
            encryption: email.encryption,
            sys_id: email.sys_id,
          })),
        })
      }
    }

    const totalEndpoints = endpoints.reduce((sum, ep) => sum + ep.count, 0)

    return createSuccessResult({
      discovered: true,
      integration_endpoints: endpoints,
      summary: {
        total_endpoints: totalEndpoints,
        types_found: endpoints.length,
        filter_applied: type,
      },
      message: `Discovered ${totalEndpoints} integration endpoints across ${endpoints.length} categories`,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
