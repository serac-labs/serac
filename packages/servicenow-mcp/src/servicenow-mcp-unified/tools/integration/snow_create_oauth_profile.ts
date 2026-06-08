/**
 * snow_create_oauth_profile - Create OAuth profiles for external integrations
 *
 * Create and configure OAuth 2.0 profiles for authenticating with external
 * APIs and services like Jira, Azure, Salesforce, etc.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_oauth_profile",
  description: "Create OAuth 2.0 profile for external API authentication (Jira, Azure, Salesforce, etc.)",
  category: "integration",
  subcategory: "oauth",
  use_cases: ["oauth", "authentication", "integration", "external-api"],
  complexity: "intermediate",
  frequency: "medium",

  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'OAuth profile name (e.g., "Jira Cloud OAuth", "Azure AD")',
      },
      grant_type: {
        type: "string",
        enum: ["authorization_code", "client_credentials", "password", "refresh_token", "jwt_bearer"],
        description: "OAuth grant type",
        default: "client_credentials",
      },
      client_id: {
        type: "string",
        description: "OAuth client ID",
      },
      client_secret: {
        type: "string",
        description: "OAuth client secret (stored securely)",
      },
      token_url: {
        type: "string",
        description: "Token endpoint URL (e.g., https://oauth.provider.com/token)",
      },
      authorization_url: {
        type: "string",
        description: "Authorization endpoint URL (for authorization_code grant)",
      },
      redirect_url: {
        type: "string",
        description: "Redirect URL after authorization",
      },
      scope: {
        type: "string",
        description: "OAuth scopes (space-separated)",
      },
      default_headers: {
        type: "object",
        description: "Default headers to include in token requests",
      },
      send_credentials: {
        type: "string",
        enum: ["header", "body"],
        description: "How to send client credentials",
        default: "header",
      },
      active: {
        type: "boolean",
        description: "Whether the profile is active",
        default: true,
      },
    },
    required: ["name", "client_id", "token_url"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var name = args.name
  var grant_type = args.grant_type || "client_credentials"
  var client_id = args.client_id
  var client_secret = args.client_secret || ""
  var token_url = args.token_url
  var authorization_url = args.authorization_url || ""
  var redirect_url = args.redirect_url || ""
  var scope = args.scope || ""
  var default_headers = args.default_headers || {}
  var send_credentials = args.send_credentials || "header"
  var active = args.active !== false

  try {
    var client = await getAuthenticatedClient(context)

    // First, create the OAuth entity provider
    var providerData: any = {
      name: name,
      type: "oauth_provider",
      active: active,
    }

    var providerResponse
    var usedBackgroundScript = false

    try {
      providerResponse = await client.post("/api/now/table/oauth_entity", providerData)
    } catch (tableError: any) {
      if (tableError.response?.status === 403) {
        usedBackgroundScript = true
        // Fallback to background script
        var script = `
          var gr = new GlideRecord('oauth_entity');
          gr.initialize();
          gr.name = ${JSON.stringify(name)};
          gr.type = 'oauth_provider';
          gr.active = ${active};
          var sysId = gr.insert();

          if (sysId) {
            gs.print(JSON.stringify({
              sys_id: sysId,
              name: gr.name.toString()
            }));
          } else {
            gs.error('Failed to create OAuth entity');
          }
        `

        var scriptResponse = await client.post("/api/now/table/sys_script_execution", {
          script: script,
          description: "Create OAuth entity: " + name,
        })

        var output = scriptResponse.data.result?.output || ""
        var match = output.match(/\{[^}]+\}/)
        if (match) {
          providerResponse = { data: { result: JSON.parse(match[0]) } }
        } else {
          throw new Error("Failed to create OAuth entity via background script")
        }
      } else {
        throw tableError
      }
    }

    var entityId = providerResponse.data.result.sys_id

    // Now create the OAuth profile with credentials
    var profileData: any = {
      name: name + " Profile",
      oauth_entity: entityId,
      grant_type: grant_type,
      client_id: client_id,
      client_secret: client_secret,
      token_url: token_url,
      auth_url: authorization_url,
      redirect_url: redirect_url,
      default_grant_type: grant_type,
      send_credentials: send_credentials,
    }

    if (scope) {
      profileData.scope = scope
    }

    var profileResponse
    try {
      profileResponse = await client.post("/api/now/table/oauth_entity_profile", profileData)
    } catch (profileError: any) {
      if (profileError.response?.status === 403) {
        usedBackgroundScript = true
        var profileScript = `
          var gr = new GlideRecord('oauth_entity_profile');
          gr.initialize();
          gr.name = ${JSON.stringify(name + " Profile")};
          gr.oauth_entity = ${JSON.stringify(entityId)};
          gr.grant_type = ${JSON.stringify(grant_type)};
          gr.client_id = ${JSON.stringify(client_id)};
          gr.client_secret = ${JSON.stringify(client_secret)};
          gr.token_url = ${JSON.stringify(token_url)};
          gr.auth_url = ${JSON.stringify(authorization_url)};
          gr.redirect_url = ${JSON.stringify(redirect_url)};
          gr.default_grant_type = ${JSON.stringify(grant_type)};
          gr.send_credentials = ${JSON.stringify(send_credentials)};
          ${scope ? `gr.scope = ${JSON.stringify(scope)};` : ""}
          var sysId = gr.insert();

          if (sysId) {
            gs.print(JSON.stringify({
              sys_id: sysId,
              name: gr.name.toString(),
              grant_type: gr.grant_type.toString()
            }));
          }
        `

        var profileScriptResponse = await client.post("/api/now/table/sys_script_execution", {
          script: profileScript,
          description: "Create OAuth profile: " + name,
        })

        var profileOutput = profileScriptResponse.data.result?.output || ""
        var profileMatch = profileOutput.match(/\{[^}]+\}/)
        if (profileMatch) {
          profileResponse = { data: { result: JSON.parse(profileMatch[0]) } }
        } else {
          throw new Error("Failed to create OAuth profile via background script")
        }
      } else {
        throw profileError
      }
    }

    var profile = profileResponse.data.result

    return createSuccessResult({
      created: true,
      method: usedBackgroundScript ? "background_script" : "table_api",
      oauth_entity: {
        sys_id: entityId,
        name: name,
      },
      oauth_profile: {
        sys_id: profile.sys_id,
        name: profile.name,
        grant_type: grant_type,
        token_url: token_url,
        scope: scope || "none specified",
      },
      next_steps:
        grant_type === "authorization_code"
          ? ["Navigate to OAuth profile in ServiceNow", 'Click "Get OAuth Token" to complete authorization flow']
          : ["OAuth profile is ready to use", "Reference this profile in your REST messages or integrations"],
    })
  } catch (error: any) {
    if (error.response?.status === 403) {
      return createErrorResult(
        "Permission denied (403): Your ServiceNow user lacks permissions to create OAuth profiles. " +
          'Required roles: "oauth_admin" or "admin". Please contact your ServiceNow administrator.',
      )
    }
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Team"
