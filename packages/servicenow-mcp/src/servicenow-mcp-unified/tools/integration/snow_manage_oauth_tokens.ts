/**
 * snow_manage_oauth_tokens - Manage OAuth tokens for integrations
 *
 * View, refresh, and manage OAuth tokens for external integrations.
 * Check token status, force refresh, and troubleshoot authentication issues.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_manage_oauth_tokens",
  description: "Manage OAuth tokens: view status, refresh tokens, troubleshoot authentication issues",
  category: "integration",
  subcategory: "oauth",
  use_cases: ["oauth", "tokens", "authentication", "troubleshooting"],
  complexity: "intermediate",
  frequency: "medium",

  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "status", "refresh", "revoke", "test"],
        description: "Action to perform",
        default: "list",
      },
      oauth_profile_id: {
        type: "string",
        description: "sys_id of the OAuth profile (required for status/refresh/revoke/test)",
      },
      oauth_profile_name: {
        type: "string",
        description: "Name of the OAuth profile (alternative to sys_id)",
      },
      include_expired: {
        type: "boolean",
        description: "Include expired tokens in list",
        default: false,
      },
      limit: {
        type: "number",
        description: "Maximum number of tokens to return",
        default: 50,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var action = args.action || "list"
  var oauth_profile_id = args.oauth_profile_id || ""
  var oauth_profile_name = args.oauth_profile_name || ""
  var include_expired = args.include_expired || false
  var limit = args.limit || 50

  try {
    var client = await getAuthenticatedClient(context)

    // If name provided but not ID, look up the profile
    if (!oauth_profile_id && oauth_profile_name) {
      var profileLookup = await client.get("/api/now/table/oauth_entity_profile", {
        params: {
          sysparm_query: "nameLIKE" + oauth_profile_name,
          sysparm_limit: 1,
          sysparm_fields: "sys_id,name",
        },
      })

      if (profileLookup.data.result && profileLookup.data.result.length > 0) {
        oauth_profile_id = profileLookup.data.result[0].sys_id
      }
    }

    if (action === "list") {
      // List all OAuth profiles and their token status
      var profilesResponse = await client.get("/api/now/table/oauth_entity_profile", {
        params: {
          sysparm_limit: limit,
          sysparm_fields: "sys_id,name,grant_type,oauth_entity,client_id,token_url,active",
          sysparm_display_value: "all",
        },
      })

      var profiles = profilesResponse.data.result || []

      // Get token information for each profile
      var profilesWithTokens = []
      for (var i = 0; i < profiles.length; i++) {
        var profile = profiles[i]

        // Query for tokens associated with this profile
        var tokenQuery = "oauth_entity_profile=" + profile.sys_id
        if (!include_expired) {
          tokenQuery += "^expires>javascript:gs.now()"
        }

        var tokensResponse = await client.get("/api/now/table/oauth_credential", {
          params: {
            sysparm_query: tokenQuery,
            sysparm_limit: 5,
            sysparm_fields: "sys_id,expires,token_type,scope,sys_created_on",
          },
        })

        var tokens = tokensResponse.data.result || []

        profilesWithTokens.push({
          sys_id: profile.sys_id,
          name: profile.name && profile.name.display_value ? profile.name.display_value : profile.name,
          grant_type: profile.grant_type,
          client_id: profile.client_id,
          active: profile.active === "true" || profile.active === true,
          token_count: tokens.length,
          tokens: tokens.map(function (t: any) {
            return {
              sys_id: t.sys_id,
              expires: t.expires,
              token_type: t.token_type,
              scope: t.scope,
              created: t.sys_created_on,
              is_expired: new Date(t.expires) < new Date(),
            }
          }),
        })
      }

      return createSuccessResult({
        action: "list",
        profiles: profilesWithTokens,
        total_profiles: profilesWithTokens.length,
        summary: {
          with_active_tokens: profilesWithTokens.filter(function (p: any) {
            return p.tokens.some(function (t: any) {
              return !t.is_expired
            })
          }).length,
          without_tokens: profilesWithTokens.filter(function (p: any) {
            return p.token_count === 0
          }).length,
        },
      })
    } else if (action === "status") {
      if (!oauth_profile_id) {
        return createErrorResult("oauth_profile_id or oauth_profile_name is required for status action")
      }

      // Get detailed status of a specific OAuth profile
      var profileResponse = await client.get("/api/now/table/oauth_entity_profile/" + oauth_profile_id, {
        params: {
          sysparm_display_value: "all",
        },
      })

      var profileData = profileResponse.data.result

      // Get all tokens for this profile
      var allTokensResponse = await client.get("/api/now/table/oauth_credential", {
        params: {
          sysparm_query: "oauth_entity_profile=" + oauth_profile_id,
          sysparm_fields: "sys_id,expires,token_type,scope,sys_created_on,sys_updated_on",
          sysparm_limit: 20,
        },
      })

      var allTokens = allTokensResponse.data.result || []
      var now = new Date()

      var tokenStats = {
        total: allTokens.length,
        active: 0,
        expired: 0,
        expiring_soon: 0,
      }

      allTokens.forEach(function (token: any) {
        var expiryDate = new Date(token.expires)
        if (expiryDate < now) {
          tokenStats.expired++
        } else {
          tokenStats.active++
          // Check if expiring within 1 hour
          var oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000)
          if (expiryDate < oneHourFromNow) {
            tokenStats.expiring_soon++
          }
        }
      })

      return createSuccessResult({
        action: "status",
        profile: {
          sys_id: profileData.sys_id,
          name: profileData.name && profileData.name.display_value ? profileData.name.display_value : profileData.name,
          grant_type: profileData.grant_type,
          client_id: profileData.client_id,
          token_url: profileData.token_url,
          active: profileData.active === "true" || profileData.active === true,
        },
        token_statistics: tokenStats,
        tokens: allTokens.map(function (t: any) {
          var expiry = new Date(t.expires)
          return {
            sys_id: t.sys_id,
            expires: t.expires,
            expires_in_minutes: Math.round((expiry.getTime() - now.getTime()) / 60000),
            token_type: t.token_type,
            scope: t.scope,
            is_expired: expiry < now,
            is_expiring_soon: expiry < new Date(now.getTime() + 60 * 60 * 1000),
          }
        }),
        health: tokenStats.active > 0 ? "healthy" : tokenStats.expired > 0 ? "needs_refresh" : "no_tokens",
      })
    } else if (action === "refresh") {
      if (!oauth_profile_id) {
        return createErrorResult("oauth_profile_id or oauth_profile_name is required for refresh action")
      }

      // Trigger token refresh via background script
      var refreshScript = `
        var oauth = new sn_auth.GlideOAuthClient();
        var profile = new GlideRecord('oauth_entity_profile');
        if (profile.get(${JSON.stringify(oauth_profile_id)})) {
          var tokenResponse = oauth.getToken(profile.sys_id.toString(), '');
          if (tokenResponse) {
            var token = tokenResponse.getToken();
            if (token) {
              gs.print(JSON.stringify({
                success: true,
                message: 'Token refreshed successfully',
                expires_in: tokenResponse.getExpiresIn()
              }));
            } else {
              gs.print(JSON.stringify({
                success: false,
                message: 'Failed to get token: ' + tokenResponse.getErrorMessage()
              }));
            }
          } else {
            gs.print(JSON.stringify({
              success: false,
              message: 'Token response is null'
            }));
          }
        } else {
          gs.print(JSON.stringify({
            success: false,
            message: 'OAuth profile not found'
          }));
        }
      `

      var refreshResponse = await client.post("/api/now/table/sys_script_execution", {
        script: refreshScript,
        description: "Refresh OAuth token for profile: " + oauth_profile_id,
      })

      var refreshOutput = refreshResponse.data.result?.output || ""
      var refreshMatch = refreshOutput.match(/\{[^}]+\}/)
      var refreshResult = refreshMatch ? JSON.parse(refreshMatch[0]) : { success: false, message: "Unknown error" }

      return createSuccessResult({
        action: "refresh",
        profile_id: oauth_profile_id,
        result: refreshResult,
      })
    } else if (action === "revoke") {
      if (!oauth_profile_id) {
        return createErrorResult("oauth_profile_id or oauth_profile_name is required for revoke action")
      }

      // Revoke/delete tokens for a profile
      var revokeScript = `
        var gr = new GlideRecord('oauth_credential');
        gr.addQuery('oauth_entity_profile', ${JSON.stringify(oauth_profile_id)});
        gr.query();
        var count = 0;
        while (gr.next()) {
          gr.deleteRecord();
          count++;
        }
        gs.print(JSON.stringify({
          success: true,
          tokens_revoked: count
        }));
      `

      var revokeResponse = await client.post("/api/now/table/sys_script_execution", {
        script: revokeScript,
        description: "Revoke OAuth tokens for profile: " + oauth_profile_id,
      })

      var revokeOutput = revokeResponse.data.result?.output || ""
      var revokeMatch = revokeOutput.match(/\{[^}]+\}/)
      var revokeResult = revokeMatch ? JSON.parse(revokeMatch[0]) : { success: false, tokens_revoked: 0 }

      return createSuccessResult({
        action: "revoke",
        profile_id: oauth_profile_id,
        result: revokeResult,
      })
    } else if (action === "test") {
      if (!oauth_profile_id) {
        return createErrorResult("oauth_profile_id or oauth_profile_name is required for test action")
      }

      // Test OAuth connectivity
      var testScript = `
        var oauth = new sn_auth.GlideOAuthClient();
        var profile = new GlideRecord('oauth_entity_profile');
        if (profile.get(${JSON.stringify(oauth_profile_id)})) {
          var startTime = new Date().getTime();
          var tokenResponse = oauth.getToken(profile.sys_id.toString(), '');
          var endTime = new Date().getTime();

          if (tokenResponse) {
            var token = tokenResponse.getToken();
            gs.print(JSON.stringify({
              success: token ? true : false,
              response_time_ms: endTime - startTime,
              has_token: token ? true : false,
              expires_in: tokenResponse.getExpiresIn(),
              error: tokenResponse.getErrorMessage() || null
            }));
          } else {
            gs.print(JSON.stringify({
              success: false,
              response_time_ms: endTime - startTime,
              error: 'No response from OAuth server'
            }));
          }
        } else {
          gs.print(JSON.stringify({
            success: false,
            error: 'OAuth profile not found'
          }));
        }
      `

      var testResponse = await client.post("/api/now/table/sys_script_execution", {
        script: testScript,
        description: "Test OAuth profile: " + oauth_profile_id,
      })

      var testOutput = testResponse.data.result?.output || ""
      var testMatch = testOutput.match(/\{[^}]+\}/)
      var testResult = testMatch ? JSON.parse(testMatch[0]) : { success: false, error: "Unknown error" }

      return createSuccessResult({
        action: "test",
        profile_id: oauth_profile_id,
        result: testResult,
        recommendation: testResult.success
          ? "OAuth profile is working correctly"
          : "Check OAuth profile configuration and credentials",
      })
    }

    return createErrorResult("Unknown action: " + action)
  } catch (error: any) {
    if (error.response?.status === 403) {
      return createErrorResult(
        "Permission denied (403): Your ServiceNow user lacks permissions to manage OAuth tokens. " +
          'Required roles: "oauth_admin" or "admin". Please contact your ServiceNow administrator.',
      )
    }
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Team"
