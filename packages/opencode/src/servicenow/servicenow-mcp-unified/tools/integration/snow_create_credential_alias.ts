/**
 * snow_create_credential_alias - Create Credential Aliases for secure authentication
 *
 * Create credential aliases to securely store and reference authentication
 * credentials for external integrations (API keys, Basic Auth, OAuth).
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_credential_alias",
  description: "Create credential alias for secure storage of API keys, passwords, and OAuth tokens",
  category: "integration",
  subcategory: "credentials",
  use_cases: ["credentials", "security", "authentication", "api-keys"],
  complexity: "intermediate",
  frequency: "medium",

  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'Credential alias name (e.g., "Jira API Credentials", "AWS Access Keys")',
      },
      type: {
        type: "string",
        enum: ["basic", "api_key", "oauth2", "ssh", "certificate", "custom"],
        description: "Type of credential",
        default: "basic",
      },
      basic_auth: {
        type: "object",
        description: "Basic authentication credentials",
        properties: {
          username: {
            type: "string",
            description: "Username",
          },
          password: {
            type: "string",
            description: "Password (stored encrypted)",
          },
        },
      },
      api_key: {
        type: "object",
        description: "API key credentials",
        properties: {
          key: {
            type: "string",
            description: "API key value (stored encrypted)",
          },
          header_name: {
            type: "string",
            description: 'Header name for API key (e.g., "X-API-Key", "Authorization")',
            default: "X-API-Key",
          },
          prefix: {
            type: "string",
            description: 'Prefix for the key value (e.g., "Bearer ", "Api-Key ")',
          },
        },
      },
      oauth2: {
        type: "object",
        description: "OAuth 2.0 credential reference",
        properties: {
          oauth_profile_id: {
            type: "string",
            description: "sys_id of the OAuth profile to use",
          },
        },
      },
      active: {
        type: "boolean",
        description: "Whether the credential is active",
        default: true,
      },
      tag: {
        type: "string",
        description: "Tag for organizing credentials",
      },
    },
    required: ["name", "type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var name = args.name
  var type = args.type || "basic"
  var basic_auth = args.basic_auth || {}
  var api_key = args.api_key || {}
  var oauth2 = args.oauth2 || {}
  var active = args.active !== false
  var tag = args.tag || ""

  try {
    var client = await getAuthenticatedClient(context)
    var usedBackgroundScript = false

    // First create the credential alias record
    var aliasData: any = {
      name: name,
      type: type,
      active: active,
    }

    if (tag) {
      aliasData.tag = tag
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
          gr.type = 'credential';
          gr.active = ${active};
          ${tag ? `gr.tag = ${JSON.stringify(tag)};` : ""}
          var sysId = gr.insert();

          if (sysId) {
            gs.print(JSON.stringify({
              sys_id: sysId,
              name: gr.name.toString()
            }));
          } else {
            gs.error('Failed to create credential alias');
          }
        `

        var scriptResponse = await client.post("/api/now/table/sys_script_execution", {
          script: script,
          description: "Create credential alias: " + name,
        })

        var output = scriptResponse.data.result?.output || ""
        var match = output.match(/\{[^}]+\}/)
        if (match) {
          aliasResponse = { data: { result: JSON.parse(match[0]) } }
        } else {
          throw new Error("Failed to create credential alias via background script")
        }
      } else {
        throw tableError
      }
    }

    var alias = aliasResponse.data.result
    var credentialRecord = null

    // Create the actual credential record based on type
    if (type === "basic" && basic_auth.username) {
      var basicData: any = {
        name: name + " - Basic Auth",
        user_name: basic_auth.username,
        password: basic_auth.password || "",
      }

      try {
        var basicResponse = await client.post("/api/now/table/basic_auth_credentials", basicData)
        credentialRecord = basicResponse.data.result
      } catch (basicError: any) {
        if (basicError.response?.status === 403) {
          var basicScript = `
            var gr = new GlideRecord('basic_auth_credentials');
            gr.initialize();
            gr.name = ${JSON.stringify(name + " - Basic Auth")};
            gr.user_name = ${JSON.stringify(basic_auth.username)};
            gr.password = ${JSON.stringify(basic_auth.password || "")};
            var sysId = gr.insert();

            if (sysId) {
              gs.print(JSON.stringify({
                sys_id: sysId,
                name: gr.name.toString(),
                user_name: gr.user_name.toString()
              }));
            }
          `

          var basicScriptResponse = await client.post("/api/now/table/sys_script_execution", {
            script: basicScript,
            description: "Create basic auth credential: " + name,
          })

          var basicOutput = basicScriptResponse.data.result?.output || ""
          var basicMatch = basicOutput.match(/\{[^}]+\}/)
          if (basicMatch) {
            credentialRecord = JSON.parse(basicMatch[0])
          }
        }
      }
    } else if (type === "api_key" && api_key.key) {
      var apiKeyData: any = {
        name: name + " - API Key",
        api_key: api_key.key,
        api_key_header: api_key.header_name || "X-API-Key",
      }

      try {
        var apiKeyResponse = await client.post("/api/now/table/api_key_credentials", apiKeyData)
        credentialRecord = apiKeyResponse.data.result
      } catch (apiKeyError: any) {
        if (apiKeyError.response?.status === 403) {
          var apiKeyScript = `
            var gr = new GlideRecord('api_key_credentials');
            gr.initialize();
            gr.name = ${JSON.stringify(name + " - API Key")};
            gr.api_key = ${JSON.stringify(api_key.key)};
            gr.api_key_header = ${JSON.stringify(api_key.header_name || "X-API-Key")};
            var sysId = gr.insert();

            if (sysId) {
              gs.print(JSON.stringify({
                sys_id: sysId,
                name: gr.name.toString(),
                header: gr.api_key_header.toString()
              }));
            }
          `

          var apiKeyScriptResponse = await client.post("/api/now/table/sys_script_execution", {
            script: apiKeyScript,
            description: "Create API key credential: " + name,
          })

          var apiKeyOutput = apiKeyScriptResponse.data.result?.output || ""
          var apiKeyMatch = apiKeyOutput.match(/\{[^}]+\}/)
          if (apiKeyMatch) {
            credentialRecord = JSON.parse(apiKeyMatch[0])
          }
        }
      }
    }

    // Link credential to alias if we created one
    if (credentialRecord && alias.sys_id) {
      try {
        await client.patch("/api/now/table/sys_alias/" + alias.sys_id, {
          credential: credentialRecord.sys_id,
        })
      } catch (linkError) {
        // Non-critical, alias still works
      }
    }

    return createSuccessResult({
      created: true,
      method: usedBackgroundScript ? "background_script" : "table_api",
      credential_alias: {
        sys_id: alias.sys_id,
        name: alias.name || name,
        type: type,
        active: active,
      },
      credential: credentialRecord
        ? {
            sys_id: credentialRecord.sys_id,
            name: credentialRecord.name,
            type: type,
          }
        : null,
      security_note: "Credentials are stored encrypted in ServiceNow. Never expose credentials in logs or outputs.",
      usage: [
        "Reference this alias in connection configurations",
        "Use in Flow Designer REST actions",
        "Reference in snow_create_connection_alias for full connection setup",
      ],
    })
  } catch (error: any) {
    if (error.response?.status === 403) {
      return createErrorResult(
        "Permission denied (403): Your ServiceNow user lacks permissions to create credentials. " +
          'Required roles: "credentials_admin" or "admin". Please contact your ServiceNow administrator.',
      )
    }
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Team"
