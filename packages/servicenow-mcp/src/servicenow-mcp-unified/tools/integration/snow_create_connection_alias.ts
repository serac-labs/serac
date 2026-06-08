/**
 * snow_create_connection_alias - Create Connection & Credential Aliases
 *
 * Create connection aliases for IntegrationHub and Flow Designer
 * to securely reference external system credentials.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_connection_alias",
  description: "Create connection alias for IntegrationHub/Flow Designer to reference external credentials",
  category: "integration",
  subcategory: "credentials",
  use_cases: ["integration-hub", "flow-designer", "credentials", "connections"],
  complexity: "intermediate",
  frequency: "medium",

  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'Connection alias name (e.g., "Jira Production", "Azure DevOps")',
      },
      connection_type: {
        type: "string",
        enum: ["http", "jdbc", "ldap", "ssh", "custom"],
        description: "Type of connection",
        default: "http",
      },
      configuration_template: {
        type: "string",
        description: "sys_id of the connection configuration template (e.g., for specific Spoke)",
      },
      credential_alias: {
        type: "string",
        description: "sys_id of credential alias to use (if already exists)",
      },
      active: {
        type: "boolean",
        description: "Whether the alias is active",
        default: true,
      },
      http_connection: {
        type: "object",
        description: "HTTP connection details (for http type)",
        properties: {
          base_url: {
            type: "string",
            description: "Base URL of the external system",
          },
          default_headers: {
            type: "object",
            description: "Default headers to send",
          },
          use_mutual_auth: {
            type: "boolean",
            description: "Enable mutual TLS authentication",
          },
          mid_server: {
            type: "string",
            description: "MID Server to use for connection",
          },
        },
      },
      retry_policy: {
        type: "object",
        description: "Retry policy for failed connections",
        properties: {
          max_retries: {
            type: "number",
            description: "Maximum number of retries",
            default: 3,
          },
          retry_interval_seconds: {
            type: "number",
            description: "Seconds between retries",
            default: 5,
          },
        },
      },
    },
    required: ["name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var name = args.name
  var connection_type = args.connection_type || "http"
  var configuration_template = args.configuration_template || ""
  var credential_alias = args.credential_alias || ""
  var active = args.active !== false
  var http_connection = args.http_connection || {}
  var retry_policy = args.retry_policy || {}

  try {
    var client = await getAuthenticatedClient(context)
    var usedBackgroundScript = false

    // Create the connection alias record
    var aliasData: any = {
      name: name,
      type: connection_type,
      active: active,
    }

    if (configuration_template) {
      aliasData.configuration_template = configuration_template
    }

    if (credential_alias) {
      aliasData.credential = credential_alias
    }

    var aliasResponse
    try {
      aliasResponse = await client.post("/api/now/table/sys_alias", aliasData)
    } catch (tableError: any) {
      if (tableError.response?.status === 403) {
        usedBackgroundScript = true
        var script = `
          var gr = new GlideRecord('sys_alias');
          gr.initialize();
          gr.name = ${JSON.stringify(name)};
          gr.type = ${JSON.stringify(connection_type)};
          gr.active = ${active};
          ${configuration_template ? `gr.configuration_template = ${JSON.stringify(configuration_template)};` : ""}
          ${credential_alias ? `gr.credential = ${JSON.stringify(credential_alias)};` : ""}
          var sysId = gr.insert();

          if (sysId) {
            gs.print(JSON.stringify({
              sys_id: sysId,
              name: gr.name.toString(),
              type: gr.type.toString()
            }));
          } else {
            gs.error('Failed to create connection alias');
          }
        `

        var scriptResponse = await client.post("/api/now/table/sys_script_execution", {
          script: script,
          description: "Create connection alias: " + name,
        })

        var output = scriptResponse.data.result?.output || ""
        var match = output.match(/\{[^}]+\}/)
        if (match) {
          aliasResponse = { data: { result: JSON.parse(match[0]) } }
        } else {
          throw new Error("Failed to create connection alias via background script")
        }
      } else {
        throw tableError
      }
    }

    var alias = aliasResponse.data.result

    // If HTTP connection details provided, create HTTP connection record
    var httpConnectionRecord = null
    if (connection_type === "http" && http_connection.base_url) {
      var httpData: any = {
        connection_alias: alias.sys_id,
        connection_url: http_connection.base_url,
        use_mutual_auth: http_connection.use_mutual_auth || false,
      }

      if (http_connection.mid_server) {
        httpData.mid_server = http_connection.mid_server
      }

      try {
        var httpResponse = await client.post("/api/now/table/sys_connection", httpData)
        httpConnectionRecord = httpResponse.data.result
      } catch (httpError: any) {
        if (httpError.response?.status === 403) {
          var httpScript = `
            var gr = new GlideRecord('sys_connection');
            gr.initialize();
            gr.connection_alias = ${JSON.stringify(alias.sys_id)};
            gr.connection_url = ${JSON.stringify(http_connection.base_url)};
            gr.use_mutual_auth = ${http_connection.use_mutual_auth || false};
            ${http_connection.mid_server ? `gr.mid_server = ${JSON.stringify(http_connection.mid_server)};` : ""}
            var sysId = gr.insert();

            if (sysId) {
              gs.print(JSON.stringify({
                sys_id: sysId,
                connection_url: gr.connection_url.toString()
              }));
            }
          `

          var httpScriptResponse = await client.post("/api/now/table/sys_script_execution", {
            script: httpScript,
            description: "Create HTTP connection for alias: " + name,
          })

          var httpOutput = httpScriptResponse.data.result?.output || ""
          var httpMatch = httpOutput.match(/\{[^}]+\}/)
          if (httpMatch) {
            httpConnectionRecord = JSON.parse(httpMatch[0])
          }
        }
      }
    }

    return createSuccessResult({
      created: true,
      method: usedBackgroundScript ? "background_script" : "table_api",
      connection_alias: {
        sys_id: alias.sys_id,
        name: alias.name || name,
        type: connection_type,
        active: active,
      },
      http_connection: httpConnectionRecord
        ? {
            sys_id: httpConnectionRecord.sys_id,
            base_url: http_connection.base_url,
          }
        : null,
      usage_instructions: [
        "Use this alias in Flow Designer actions",
        "Reference in REST steps: alias=" + name,
        "Configure credentials via snow_create_credential_alias if needed",
      ],
    })
  } catch (error: any) {
    if (error.response?.status === 403) {
      return createErrorResult(
        "Permission denied (403): Your ServiceNow user lacks permissions to create connection aliases. " +
          'Required roles: "connection_admin" or "admin". Please contact your ServiceNow administrator.',
      )
    }
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Team"
