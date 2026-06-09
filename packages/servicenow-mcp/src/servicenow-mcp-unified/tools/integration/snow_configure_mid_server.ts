/**
 * snow_configure_mid_server - Configure MID Server settings
 *
 * View, configure, and manage MID Server instances for secure
 * on-premise integrations and Discovery operations.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_configure_mid_server",
  description: "Configure MID Server settings for on-premise integrations and Discovery",
  category: "integration",
  subcategory: "mid-server",
  use_cases: ["mid-server", "on-premise", "discovery", "integration"],
  complexity: "advanced",
  frequency: "low",

  permission: "admin",
  allowedRoles: ["admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "status", "configure", "validate", "restart", "assign_application"],
        description: "Action to perform",
        default: "list",
      },
      mid_server_name: {
        type: "string",
        description: "Name of the MID Server",
      },
      mid_server_id: {
        type: "string",
        description: "sys_id of the MID Server",
      },
      configuration: {
        type: "object",
        description: "Configuration settings to apply",
        properties: {
          ip_address: { type: "string", description: "IP address restriction" },
          max_threads: { type: "number", description: "Maximum concurrent threads" },
          max_memory: { type: "string", description: 'Maximum memory allocation (e.g., "2048m")' },
          network_range: { type: "string", description: "Network range for Discovery" },
          validated: { type: "boolean", description: "Validation status" },
        },
      },
      application_id: {
        type: "string",
        description: "Application sys_id for assign_application action",
      },
      include_inactive: {
        type: "boolean",
        description: "Include inactive MID Servers",
        default: false,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var action = args.action || "list"
  var mid_server_name = args.mid_server_name || ""
  var mid_server_id = args.mid_server_id || ""
  var configuration = args.configuration || {}
  var application_id = args.application_id || ""
  var include_inactive = args.include_inactive || false

  try {
    var client = await getAuthenticatedClient(context)

    if (action === "list") {
      // List all MID Servers
      var queryParts: string[] = []

      if (!include_inactive) {
        queryParts.push("status=Up")
      }

      if (mid_server_name) {
        queryParts.push("nameLIKE" + mid_server_name)
      }

      var midServersResponse = await client.get("/api/now/table/ecc_agent", {
        params: {
          sysparm_query: queryParts.join("^") + "^ORDERBYname",
          sysparm_limit: 100,
          sysparm_fields:
            "sys_id,name,status,ip_address,host_name,version,validated,last_refreshed,router,sys_created_on",
          sysparm_display_value: "all",
        },
      })

      var midServers = midServersResponse.data.result || []

      // Get additional stats for each MID Server
      var enrichedServers = []
      for (var i = 0; i < midServers.length; i++) {
        var mid = midServers[i]

        // Get capability count
        var capsResponse = await client.get("/api/now/table/ecc_agent_capability_m2m", {
          params: {
            sysparm_query: "agent=" + mid.sys_id,
            sysparm_fields: "sys_id",
            sysparm_limit: 100,
          },
        })

        // Get application count
        var appsResponse = await client.get("/api/now/table/ecc_agent_application_m2m", {
          params: {
            sysparm_query: "agent=" + mid.sys_id,
            sysparm_fields: "sys_id",
            sysparm_limit: 100,
          },
        })

        enrichedServers.push({
          sys_id: mid.sys_id,
          name: mid.name,
          status: mid.status && mid.status.display_value ? mid.status.display_value : mid.status,
          ip_address: mid.ip_address,
          host_name: mid.host_name,
          version: mid.version,
          validated: mid.validated === "true" || mid.validated === true,
          last_refreshed: mid.last_refreshed,
          router: mid.router && mid.router.display_value ? mid.router.display_value : mid.router,
          capability_count: capsResponse.data.result?.length || 0,
          application_count: appsResponse.data.result?.length || 0,
          created_on: mid.sys_created_on,
        })
      }

      // Calculate summary
      var summary = {
        total: enrichedServers.length,
        up: enrichedServers.filter(function (m: any) {
          return m.status === "Up"
        }).length,
        down: enrichedServers.filter(function (m: any) {
          return m.status === "Down"
        }).length,
        validated: enrichedServers.filter(function (m: any) {
          return m.validated
        }).length,
        not_validated: enrichedServers.filter(function (m: any) {
          return !m.validated
        }).length,
      }

      return createSuccessResult({
        action: "list",
        mid_servers: enrichedServers,
        summary: summary,
      })
    } else if (action === "status") {
      // Get detailed status of a specific MID Server
      var midId = mid_server_id
      if (!midId && mid_server_name) {
        var lookupResponse = await client.get("/api/now/table/ecc_agent", {
          params: {
            sysparm_query: "name=" + mid_server_name,
            sysparm_limit: 1,
            sysparm_fields: "sys_id",
          },
        })
        if (lookupResponse.data.result && lookupResponse.data.result.length > 0) {
          midId = lookupResponse.data.result[0].sys_id
        }
      }

      if (!midId) {
        return createErrorResult("MID Server not found. Provide mid_server_id or mid_server_name.")
      }

      // Get MID Server details
      var midResponse = await client.get("/api/now/table/ecc_agent/" + midId, {
        params: {
          sysparm_display_value: "all",
        },
      })

      if (!midResponse.data.result) {
        return createErrorResult("MID Server not found")
      }

      var midServer = midResponse.data.result

      // Get capabilities
      var capabilitiesResponse = await client.get("/api/now/table/ecc_agent_capability_m2m", {
        params: {
          sysparm_query: "agent=" + midId,
          sysparm_fields: "capability",
          sysparm_display_value: "all",
          sysparm_limit: 100,
        },
      })

      var capabilities = (capabilitiesResponse.data.result || []).map(function (c: any) {
        return c.capability && c.capability.display_value ? c.capability.display_value : c.capability
      })

      // Get assigned applications
      var applicationsResponse = await client.get("/api/now/table/ecc_agent_application_m2m", {
        params: {
          sysparm_query: "agent=" + midId,
          sysparm_fields: "application",
          sysparm_display_value: "all",
          sysparm_limit: 100,
        },
      })

      var applications = (applicationsResponse.data.result || []).map(function (a: any) {
        return a.application && a.application.display_value ? a.application.display_value : a.application
      })

      // Get recent issues from ECC queue
      var eccIssuesResponse = await client.get("/api/now/table/ecc_queue", {
        params: {
          sysparm_query: "agent=" + midId + "^state=error^ORDERBYDESCsys_created_on",
          sysparm_limit: 10,
          sysparm_fields: "sys_created_on,topic,name,error_string",
        },
      })

      var recentIssues = eccIssuesResponse.data.result || []

      // Calculate health score
      var healthScore = 100
      if (midServer.status !== "Up" && midServer.status?.display_value !== "Up") healthScore -= 50
      if (!midServer.validated && midServer.validated !== "true") healthScore -= 20
      if (recentIssues.length > 0) healthScore -= Math.min(30, recentIssues.length * 5)

      return createSuccessResult({
        action: "status",
        mid_server: {
          sys_id: midServer.sys_id,
          name: midServer.name,
          status:
            midServer.status && midServer.status.display_value ? midServer.status.display_value : midServer.status,
          ip_address: midServer.ip_address,
          host_name: midServer.host_name,
          version: midServer.version,
          validated: midServer.validated === "true" || midServer.validated === true,
          last_refreshed: midServer.last_refreshed,
          router:
            midServer.router && midServer.router.display_value ? midServer.router.display_value : midServer.router,
          network: midServer.network,
          home_dir: midServer.home_dir,
        },
        capabilities: capabilities,
        capability_count: capabilities.length,
        applications: applications,
        application_count: applications.length,
        recent_issues: recentIssues.map(function (issue: any) {
          return {
            timestamp: issue.sys_created_on,
            topic: issue.topic,
            name: issue.name,
            error: issue.error_string,
          }
        }),
        health: {
          score: healthScore,
          status: healthScore >= 80 ? "healthy" : healthScore >= 50 ? "degraded" : "unhealthy",
        },
      })
    } else if (action === "configure") {
      var configMidId = mid_server_id
      if (!configMidId && mid_server_name) {
        var configLookup = await client.get("/api/now/table/ecc_agent", {
          params: {
            sysparm_query: "name=" + mid_server_name,
            sysparm_limit: 1,
            sysparm_fields: "sys_id",
          },
        })
        if (configLookup.data.result && configLookup.data.result.length > 0) {
          configMidId = configLookup.data.result[0].sys_id
        }
      }

      if (!configMidId) {
        return createErrorResult("MID Server not found")
      }

      // Build update object
      var updates: any = {}
      if (configuration.ip_address !== undefined) updates.ip_address = configuration.ip_address
      if (configuration.validated !== undefined) updates.validated = configuration.validated
      if (configuration.network_range !== undefined) updates.network = configuration.network_range

      if (Object.keys(updates).length > 0) {
        await client.patch("/api/now/table/ecc_agent/" + configMidId, updates)
      }

      return createSuccessResult({
        action: "configure",
        mid_server_id: configMidId,
        updates_applied: updates,
        message: "MID Server configuration updated",
        note: "Some settings require MID Server restart to take effect",
      })
    } else if (action === "validate") {
      var validateMidId = mid_server_id
      if (!validateMidId && mid_server_name) {
        var validateLookup = await client.get("/api/now/table/ecc_agent", {
          params: {
            sysparm_query: "name=" + mid_server_name,
            sysparm_limit: 1,
            sysparm_fields: "sys_id,name,validated",
          },
        })
        if (validateLookup.data.result && validateLookup.data.result.length > 0) {
          validateMidId = validateLookup.data.result[0].sys_id
        }
      }

      if (!validateMidId) {
        return createErrorResult("MID Server not found")
      }

      // Set validated to true
      await client.patch("/api/now/table/ecc_agent/" + validateMidId, {
        validated: true,
      })

      return createSuccessResult({
        action: "validate",
        mid_server_id: validateMidId,
        validated: true,
        message: "MID Server has been validated and is ready for use",
      })
    } else if (action === "restart") {
      var restartMidId = mid_server_id
      if (!restartMidId && mid_server_name) {
        var restartLookup = await client.get("/api/now/table/ecc_agent", {
          params: {
            sysparm_query: "name=" + mid_server_name,
            sysparm_limit: 1,
            sysparm_fields: "sys_id,name",
          },
        })
        if (restartLookup.data.result && restartLookup.data.result.length > 0) {
          restartMidId = restartLookup.data.result[0].sys_id
        }
      }

      if (!restartMidId) {
        return createErrorResult("MID Server not found")
      }

      // Queue a restart command via ECC queue
      var restartScript = `
        var ecc = new GlideRecord('ecc_queue');
        ecc.initialize();
        ecc.agent = ${JSON.stringify(restartMidId)};
        ecc.topic = 'Command';
        ecc.name = 'restartMid';
        ecc.source = 'snow-flow';
        ecc.queue = 'output';
        var sysId = ecc.insert();
        gs.print(JSON.stringify({
          success: sysId ? true : false,
          ecc_queue_id: sysId,
          message: sysId ? 'Restart command queued' : 'Failed to queue restart'
        }));
      `

      var restartResponse = await client.post("/api/now/table/sys_script_execution", {
        script: restartScript,
        description: "Restart MID Server: " + restartMidId,
      })

      var restartOutput = restartResponse.data.result?.output || ""
      var restartMatch = restartOutput.match(/\{[^}]+\}/)
      var restartResult = restartMatch ? JSON.parse(restartMatch[0]) : { success: false, message: "Unknown error" }

      return createSuccessResult({
        action: "restart",
        mid_server_id: restartMidId,
        result: restartResult,
      })
    } else if (action === "assign_application") {
      if (!application_id) {
        return createErrorResult("application_id is required for assign_application action")
      }

      var assignMidId = mid_server_id
      if (!assignMidId && mid_server_name) {
        var assignLookup = await client.get("/api/now/table/ecc_agent", {
          params: {
            sysparm_query: "name=" + mid_server_name,
            sysparm_limit: 1,
            sysparm_fields: "sys_id",
          },
        })
        if (assignLookup.data.result && assignLookup.data.result.length > 0) {
          assignMidId = assignLookup.data.result[0].sys_id
        }
      }

      if (!assignMidId) {
        return createErrorResult("MID Server not found")
      }

      // Create application assignment
      var assignResponse = await client.post("/api/now/table/ecc_agent_application_m2m", {
        agent: assignMidId,
        application: application_id,
      })

      return createSuccessResult({
        action: "assign_application",
        mid_server_id: assignMidId,
        application_id: application_id,
        assignment_id: assignResponse.data.result?.sys_id,
        message: "Application assigned to MID Server successfully",
      })
    }

    return createErrorResult("Unknown action: " + action)
  } catch (error: any) {
    if (error.response?.status === 403) {
      return createErrorResult(
        "Permission denied (403): Your ServiceNow user lacks permissions to manage MID Servers. " +
          'Required roles: "mid_server" or "admin". Please contact your ServiceNow administrator.',
      )
    }
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Team"
