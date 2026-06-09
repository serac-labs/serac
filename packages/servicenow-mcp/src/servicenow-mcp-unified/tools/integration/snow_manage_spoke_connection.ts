/**
 * snow_manage_spoke_connection - Manage spoke connection configurations
 *
 * Configure, test, and manage connection settings for IntegrationHub spokes
 * including connection aliases, credentials, and endpoint configurations.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_manage_spoke_connection",
  description: "Manage IntegrationHub spoke connections: configure, test, and troubleshoot",
  category: "integration",
  subcategory: "integrationhub",
  use_cases: ["spokes", "connections", "integration-hub", "troubleshooting"],
  complexity: "intermediate",
  frequency: "medium",

  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "configure", "test", "status", "update", "troubleshoot"],
        description: "Action to perform",
        default: "list",
      },
      spoke_name: {
        type: "string",
        description: "Name of the spoke to manage connections for",
      },
      connection_alias_id: {
        type: "string",
        description: "sys_id of specific connection alias",
      },
      configuration: {
        type: "object",
        description: "Connection configuration to apply (for configure/update)",
        properties: {
          base_url: { type: "string", description: "Base URL for the external system" },
          credential_alias: { type: "string", description: "Credential alias sys_id" },
          mid_server: { type: "string", description: "MID Server to use" },
          timeout: { type: "number", description: "Connection timeout in seconds" },
          retry_count: { type: "number", description: "Number of retry attempts" },
          custom_headers: { type: "object", description: "Custom headers to include" },
        },
      },
      include_inactive: {
        type: "boolean",
        description: "Include inactive connections",
        default: false,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var action = args.action || "list"
  var spoke_name = args.spoke_name || ""
  var connection_alias_id = args.connection_alias_id || ""
  var configuration = args.configuration || {}
  var include_inactive = args.include_inactive || false

  try {
    var client = await getAuthenticatedClient(context)

    if (action === "list") {
      // List all spoke connections
      var queryParts: string[] = []

      if (!include_inactive) {
        queryParts.push("active=true")
      }

      if (spoke_name) {
        // Find spoke first
        var spokeResponse = await client.get("/api/now/table/sys_hub_spoke", {
          params: {
            sysparm_query: "nameLIKE" + spoke_name,
            sysparm_limit: 1,
            sysparm_fields: "sys_id,name",
          },
        })

        if (spokeResponse.data.result && spokeResponse.data.result.length > 0) {
          queryParts.push("sys_scope=" + spokeResponse.data.result[0].sys_id)
        }
      }

      // Get connection aliases
      var connectionsResponse = await client.get("/api/now/table/sys_alias", {
        params: {
          sysparm_query: queryParts.join("^") + "^type=connection^ORDERBYname",
          sysparm_limit: 100,
          sysparm_fields: "sys_id,name,type,active,credential,sys_scope",
          sysparm_display_value: "all",
        },
      })

      var connections = connectionsResponse.data.result || []

      // Get additional connection details
      var enrichedConnections = []
      for (var i = 0; i < connections.length; i++) {
        var conn = connections[i]

        // Get HTTP connection details if available
        var httpDetailsResponse = await client.get("/api/now/table/sys_connection", {
          params: {
            sysparm_query: "connection_alias=" + conn.sys_id,
            sysparm_limit: 1,
            sysparm_fields: "connection_url,mid_server,use_mutual_auth,timeout",
          },
        })

        var httpDetails = httpDetailsResponse.data.result?.[0] || null

        enrichedConnections.push({
          sys_id: conn.sys_id,
          name: conn.name && conn.name.display_value ? conn.name.display_value : conn.name,
          type: conn.type,
          active: conn.active === "true" || conn.active === true,
          credential:
            conn.credential && conn.credential.display_value ? conn.credential.display_value : conn.credential,
          scope: conn.sys_scope && conn.sys_scope.display_value ? conn.sys_scope.display_value : conn.sys_scope,
          http_connection: httpDetails
            ? {
                base_url: httpDetails.connection_url,
                mid_server: httpDetails.mid_server,
                use_mutual_auth: httpDetails.use_mutual_auth === "true",
                timeout: httpDetails.timeout,
              }
            : null,
        })
      }

      return createSuccessResult({
        action: "list",
        connections: enrichedConnections,
        total: enrichedConnections.length,
        summary: {
          active: enrichedConnections.filter(function (c: any) {
            return c.active
          }).length,
          inactive: enrichedConnections.filter(function (c: any) {
            return !c.active
          }).length,
          with_credentials: enrichedConnections.filter(function (c: any) {
            return c.credential
          }).length,
        },
      })
    } else if (action === "status") {
      if (!connection_alias_id) {
        return createErrorResult("connection_alias_id is required for status action")
      }

      // Get detailed status of a connection
      var aliasResponse = await client.get("/api/now/table/sys_alias/" + connection_alias_id, {
        params: {
          sysparm_display_value: "all",
        },
      })

      if (!aliasResponse.data.result) {
        return createErrorResult("Connection alias not found")
      }

      var alias = aliasResponse.data.result

      // Get HTTP connection
      var httpConnResponse = await client.get("/api/now/table/sys_connection", {
        params: {
          sysparm_query: "connection_alias=" + connection_alias_id,
          sysparm_fields: "sys_id,connection_url,mid_server,use_mutual_auth,timeout,retry_count",
          sysparm_display_value: "all",
        },
      })

      var httpConn = httpConnResponse.data.result?.[0] || null

      // Get credential details
      var credentialInfo = null
      if (alias.credential) {
        var credId = alias.credential.value || alias.credential
        var credResponse = await client.get("/api/now/table/discovery_credentials/" + credId, {
          params: {
            sysparm_fields: "name,type,active",
          },
        })
        if (credResponse.data.result) {
          credentialInfo = {
            name: credResponse.data.result.name,
            type: credResponse.data.result.type,
            active: credResponse.data.result.active === "true",
          }
        }
      }

      // Check recent activity
      var recentLogsResponse = await client.get("/api/now/table/syslog", {
        params: {
          sysparm_query: "messageLIKE" + (alias.name.display_value || alias.name) + "^ORDERBYDESCsys_created_on",
          sysparm_limit: 5,
          sysparm_fields: "sys_created_on,level,message",
        },
      })

      var recentLogs = recentLogsResponse.data.result || []

      return createSuccessResult({
        action: "status",
        connection: {
          sys_id: alias.sys_id,
          name: alias.name && alias.name.display_value ? alias.name.display_value : alias.name,
          type: alias.type,
          active: alias.active === "true" || alias.active === true,
          scope: alias.sys_scope && alias.sys_scope.display_value ? alias.sys_scope.display_value : alias.sys_scope,
        },
        http_settings: httpConn
          ? {
              base_url: httpConn.connection_url,
              mid_server:
                httpConn.mid_server && httpConn.mid_server.display_value
                  ? httpConn.mid_server.display_value
                  : httpConn.mid_server,
              use_mutual_auth: httpConn.use_mutual_auth === "true",
              timeout: httpConn.timeout,
              retry_count: httpConn.retry_count,
            }
          : null,
        credential: credentialInfo,
        recent_activity: recentLogs.map(function (log: any) {
          return {
            timestamp: log.sys_created_on,
            level: log.level,
            message: log.message ? log.message.substring(0, 200) : "",
          }
        }),
        health: alias.active === "true" ? "configured" : "inactive",
      })
    } else if (action === "test") {
      if (!connection_alias_id) {
        return createErrorResult("connection_alias_id is required for test action")
      }

      // Test the connection via background script
      var testScript = `
        var alias = new GlideRecord('sys_alias');
        if (alias.get(${JSON.stringify(connection_alias_id)})) {
          var conn = new GlideRecord('sys_connection');
          conn.addQuery('connection_alias', alias.sys_id);
          conn.query();

          if (conn.next()) {
            var startTime = new Date().getTime();
            try {
              var request = new sn_ws.RESTMessageV2();
              request.setEndpoint(conn.connection_url.toString());
              request.setHttpMethod('GET');
              request.setHttpTimeout(10000);

              // Try to resolve credential
              if (alias.credential) {
                var cred = new GlideRecord('discovery_credentials');
                if (cred.get(alias.credential)) {
                  if (cred.type == 'basic') {
                    request.setBasicAuth(cred.user_name, cred.password.getDecryptedValue());
                  }
                }
              }

              var response = request.execute();
              var endTime = new Date().getTime();

              gs.print(JSON.stringify({
                success: true,
                status_code: response.getStatusCode(),
                response_time_ms: endTime - startTime,
                endpoint: conn.connection_url.toString()
              }));
            } catch (e) {
              var endTime = new Date().getTime();
              gs.print(JSON.stringify({
                success: false,
                error: e.message,
                response_time_ms: endTime - startTime,
                endpoint: conn.connection_url.toString()
              }));
            }
          } else {
            gs.print(JSON.stringify({
              success: false,
              error: 'No HTTP connection found for alias'
            }));
          }
        } else {
          gs.print(JSON.stringify({
            success: false,
            error: 'Connection alias not found'
          }));
        }
      `

      var testResponse = await client.post("/api/now/table/sys_script_execution", {
        script: testScript,
        description: "Test spoke connection: " + connection_alias_id,
      })

      var testOutput = testResponse.data.result?.output || ""
      var testMatch = testOutput.match(/\{[^}]+\}/)
      var testResult = testMatch ? JSON.parse(testMatch[0]) : { success: false, error: "Unknown error" }

      return createSuccessResult({
        action: "test",
        connection_alias_id: connection_alias_id,
        result: testResult,
        recommendation: testResult.success
          ? "Connection is working correctly"
          : "Check endpoint URL, credentials, and network connectivity",
      })
    } else if (action === "configure" || action === "update") {
      if (!connection_alias_id) {
        return createErrorResult("connection_alias_id is required for " + action + " action")
      }

      // Update connection settings
      var updates: any = {}

      if (configuration.credential_alias) {
        updates.credential = configuration.credential_alias
      }

      if (Object.keys(updates).length > 0) {
        await client.patch("/api/now/table/sys_alias/" + connection_alias_id, updates)
      }

      // Update HTTP connection if base_url or other settings provided
      if (configuration.base_url || configuration.mid_server || configuration.timeout) {
        var httpFindResponse = await client.get("/api/now/table/sys_connection", {
          params: {
            sysparm_query: "connection_alias=" + connection_alias_id,
            sysparm_limit: 1,
            sysparm_fields: "sys_id",
          },
        })

        var httpUpdates: any = {}
        if (configuration.base_url) httpUpdates.connection_url = configuration.base_url
        if (configuration.mid_server) httpUpdates.mid_server = configuration.mid_server
        if (configuration.timeout) httpUpdates.timeout = configuration.timeout
        if (configuration.retry_count) httpUpdates.retry_count = configuration.retry_count

        if (httpFindResponse.data.result && httpFindResponse.data.result.length > 0) {
          await client.patch("/api/now/table/sys_connection/" + httpFindResponse.data.result[0].sys_id, httpUpdates)
        } else if (configuration.base_url) {
          // Create HTTP connection if doesn't exist
          httpUpdates.connection_alias = connection_alias_id
          await client.post("/api/now/table/sys_connection", httpUpdates)
        }
      }

      return createSuccessResult({
        action: action,
        connection_alias_id: connection_alias_id,
        updates_applied: configuration,
        message: "Connection configuration updated successfully",
      })
    } else if (action === "troubleshoot") {
      if (!connection_alias_id) {
        return createErrorResult("connection_alias_id is required for troubleshoot action")
      }

      // Gather diagnostic information
      var aliasInfo = await client.get("/api/now/table/sys_alias/" + connection_alias_id, {
        params: { sysparm_display_value: "all" },
      })

      if (!aliasInfo.data.result) {
        return createErrorResult("Connection alias not found")
      }

      var diagnostics: any = {
        alias: {
          name: aliasInfo.data.result.name,
          active: aliasInfo.data.result.active,
          has_credential: !!aliasInfo.data.result.credential,
        },
        issues: [],
        recommendations: [],
      }

      // Check if alias is active
      if (aliasInfo.data.result.active !== "true") {
        diagnostics.issues.push("Connection alias is inactive")
        diagnostics.recommendations.push("Activate the connection alias")
      }

      // Check if credential is set
      if (!aliasInfo.data.result.credential) {
        diagnostics.issues.push("No credential configured")
        diagnostics.recommendations.push("Configure credential using snow_create_credential_alias")
      }

      // Check HTTP connection
      var httpCheck = await client.get("/api/now/table/sys_connection", {
        params: {
          sysparm_query: "connection_alias=" + connection_alias_id,
          sysparm_limit: 1,
          sysparm_fields: "connection_url,mid_server,timeout",
        },
      })

      if (!httpCheck.data.result || httpCheck.data.result.length === 0) {
        diagnostics.issues.push("No HTTP connection configured")
        diagnostics.recommendations.push("Configure HTTP connection with base URL")
      } else {
        var httpConn = httpCheck.data.result[0]
        diagnostics.http_connection = {
          base_url: httpConn.connection_url,
          has_mid_server: !!httpConn.mid_server,
          timeout: httpConn.timeout || "default",
        }

        if (!httpConn.connection_url) {
          diagnostics.issues.push("HTTP connection has no URL configured")
          diagnostics.recommendations.push("Set connection_url in HTTP connection")
        }
      }

      // Check recent errors
      var errorLogs = await client.get("/api/now/table/syslog", {
        params: {
          sysparm_query:
            "level=2^messageLIKE" +
            (aliasInfo.data.result.name.display_value || aliasInfo.data.result.name) +
            "^ORDERBYDESCsys_created_on",
          sysparm_limit: 10,
          sysparm_fields: "sys_created_on,message",
        },
      })

      if (errorLogs.data.result && errorLogs.data.result.length > 0) {
        diagnostics.recent_errors = errorLogs.data.result.map(function (log: any) {
          return {
            timestamp: log.sys_created_on,
            message: log.message ? log.message.substring(0, 200) : "",
          }
        })
        diagnostics.issues.push("Recent errors found in logs")
        diagnostics.recommendations.push("Review error messages for specific issues")
      }

      diagnostics.health = diagnostics.issues.length === 0 ? "healthy" : "issues_detected"

      return createSuccessResult({
        action: "troubleshoot",
        connection_alias_id: connection_alias_id,
        diagnostics: diagnostics,
      })
    }

    return createErrorResult("Unknown action: " + action)
  } catch (error: any) {
    if (error.response?.status === 403) {
      return createErrorResult(
        "Permission denied (403): Your ServiceNow user lacks permissions to manage spoke connections. " +
          'Required roles: "flow_designer" or "admin". Please contact your ServiceNow administrator.',
      )
    }
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Team"
