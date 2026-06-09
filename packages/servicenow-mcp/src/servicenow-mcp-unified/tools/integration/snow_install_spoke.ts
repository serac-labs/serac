/**
 * snow_install_spoke - Install and manage IntegrationHub Spokes
 *
 * Install, activate, and configure IntegrationHub Spokes from the
 * ServiceNow Store or custom repositories (Jira, Slack, Azure, etc.).
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_install_spoke",
  description: "Install and manage IntegrationHub Spokes (Jira, Slack, Azure DevOps, etc.)",
  category: "integration",
  subcategory: "integrationhub",
  use_cases: ["spokes", "integration-hub", "marketplace", "external-systems"],
  complexity: "advanced",
  frequency: "low",

  permission: "admin",
  allowedRoles: ["admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "list_available", "install", "activate", "deactivate", "status", "search"],
        description: "Action to perform",
        default: "list",
      },
      spoke_name: {
        type: "string",
        description: 'Name of the spoke (e.g., "Jira", "Slack", "Microsoft Teams")',
      },
      spoke_id: {
        type: "string",
        description: "sys_id of the spoke (for activate/deactivate/status)",
      },
      search_query: {
        type: "string",
        description: "Search query for finding spokes (for search action)",
      },
      include_inactive: {
        type: "boolean",
        description: "Include inactive spokes in list",
        default: false,
      },
      limit: {
        type: "number",
        description: "Maximum number of results",
        default: 50,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var action = args.action || "list"
  var spoke_name = args.spoke_name || ""
  var spoke_id = args.spoke_id || ""
  var search_query = args.search_query || ""
  var include_inactive = args.include_inactive || false
  var limit = args.limit || 50

  try {
    var client = await getAuthenticatedClient(context)

    if (action === "list") {
      // List installed spokes
      var queryParts: string[] = []
      if (!include_inactive) {
        queryParts.push("active=true")
      }
      if (spoke_name) {
        queryParts.push("nameLIKE" + spoke_name)
      }

      var spokesResponse = await client.get("/api/now/table/sys_hub_spoke", {
        params: {
          sysparm_query: queryParts.join("^") + "^ORDERBYname",
          sysparm_limit: limit,
          sysparm_fields: "sys_id,name,version,active,description,vendor,sys_created_on,sys_updated_on",
          sysparm_display_value: "all",
        },
      })

      var spokes = spokesResponse.data.result || []

      // Get action counts for each spoke
      var spokesWithStats = []
      for (var i = 0; i < spokes.length; i++) {
        var spoke = spokes[i]

        // Count actions in this spoke
        var actionsResponse = await client.get("/api/now/table/sys_hub_action_type_definition", {
          params: {
            sysparm_query: "sys_scope=" + spoke.sys_id,
            sysparm_fields: "sys_id",
            sysparm_limit: 1000,
          },
        })

        spokesWithStats.push({
          sys_id: spoke.sys_id,
          name: spoke.name && spoke.name.display_value ? spoke.name.display_value : spoke.name,
          version: spoke.version,
          active: spoke.active === "true" || spoke.active === true,
          description: spoke.description,
          vendor: spoke.vendor && spoke.vendor.display_value ? spoke.vendor.display_value : spoke.vendor,
          action_count: actionsResponse.data.result?.length || 0,
          installed_on: spoke.sys_created_on,
          updated_on: spoke.sys_updated_on,
        })
      }

      return createSuccessResult({
        action: "list",
        spokes: spokesWithStats,
        total: spokesWithStats.length,
        summary: {
          active: spokesWithStats.filter(function (s: any) {
            return s.active
          }).length,
          inactive: spokesWithStats.filter(function (s: any) {
            return !s.active
          }).length,
          total_actions: spokesWithStats.reduce(function (sum: number, s: any) {
            return sum + s.action_count
          }, 0),
        },
      })
    } else if (action === "list_available") {
      // List available spokes from plugin registry
      var availableResponse = await client.get("/api/now/table/v_plugin", {
        params: {
          sysparm_query: "nameLIKESpoke^ORnameLIKEIntegration^ORDERBYname",
          sysparm_limit: limit,
          sysparm_fields: "sys_id,name,version,active,description,vendor",
        },
      })

      var available = availableResponse.data.result || []

      return createSuccessResult({
        action: "list_available",
        available_spokes: available.map(function (p: any) {
          return {
            sys_id: p.sys_id,
            name: p.name,
            version: p.version,
            active: p.active === "true",
            description: p.description,
            vendor: p.vendor,
          }
        }),
        total: available.length,
        note: "Use snow_activate_plugin to activate available spokes",
      })
    } else if (action === "search") {
      if (!search_query) {
        return createErrorResult("search_query is required for search action")
      }

      // Search for spokes by name or description
      var searchResponse = await client.get("/api/now/table/sys_hub_spoke", {
        params: {
          sysparm_query: "nameLIKE" + search_query + "^ORdescriptionLIKE" + search_query,
          sysparm_limit: limit,
          sysparm_fields: "sys_id,name,version,active,description,vendor",
        },
      })

      var searchResults = searchResponse.data.result || []

      // Also search in plugins
      var pluginSearchResponse = await client.get("/api/now/table/v_plugin", {
        params: {
          sysparm_query: "nameLIKE" + search_query + "^nameLIKESpoke",
          sysparm_limit: limit,
          sysparm_fields: "sys_id,name,version,active,description",
        },
      })

      var pluginResults = pluginSearchResponse.data.result || []

      return createSuccessResult({
        action: "search",
        query: search_query,
        installed_spokes: searchResults.map(function (s: any) {
          return {
            sys_id: s.sys_id,
            name: s.name,
            version: s.version,
            active: s.active === "true",
            description: s.description,
          }
        }),
        available_plugins: pluginResults.map(function (p: any) {
          return {
            sys_id: p.sys_id,
            name: p.name,
            version: p.version,
            active: p.active === "true",
            description: p.description,
          }
        }),
        total_found: searchResults.length + pluginResults.length,
      })
    } else if (action === "status") {
      if (!spoke_id && !spoke_name) {
        return createErrorResult("spoke_id or spoke_name is required for status action")
      }

      // Get spoke status
      var statusQuery = spoke_id ? "sys_id=" + spoke_id : "nameLIKE" + spoke_name
      var statusResponse = await client.get("/api/now/table/sys_hub_spoke", {
        params: {
          sysparm_query: statusQuery,
          sysparm_limit: 1,
          sysparm_fields: "sys_id,name,version,active,description,vendor,sys_scope",
          sysparm_display_value: "all",
        },
      })

      if (!statusResponse.data.result || statusResponse.data.result.length === 0) {
        return createErrorResult("Spoke not found: " + (spoke_name || spoke_id))
      }

      var spokeData = statusResponse.data.result[0]

      // Get actions for this spoke
      var spokeActionsResponse = await client.get("/api/now/table/sys_hub_action_type_definition", {
        params: {
          sysparm_query: "sys_scope=" + spokeData.sys_id + "^ORDERBYname",
          sysparm_fields: "sys_id,name,description,active,category",
          sysparm_limit: 100,
        },
      })

      var spokeActions = spokeActionsResponse.data.result || []

      // Get connection aliases used by this spoke
      var connectionsResponse = await client.get("/api/now/table/sys_alias", {
        params: {
          sysparm_query: "sys_scope=" + spokeData.sys_id,
          sysparm_fields: "sys_id,name,type,active",
          sysparm_limit: 50,
        },
      })

      var connections = connectionsResponse.data.result || []

      return createSuccessResult({
        action: "status",
        spoke: {
          sys_id: spokeData.sys_id,
          name: spokeData.name && spokeData.name.display_value ? spokeData.name.display_value : spokeData.name,
          version: spokeData.version,
          active: spokeData.active === "true" || spokeData.active === true,
          description: spokeData.description,
          vendor:
            spokeData.vendor && spokeData.vendor.display_value ? spokeData.vendor.display_value : spokeData.vendor,
        },
        actions: spokeActions.map(function (a: any) {
          return {
            sys_id: a.sys_id,
            name: a.name,
            description: a.description,
            active: a.active === "true",
            category: a.category,
          }
        }),
        action_count: spokeActions.length,
        connections: connections.map(function (c: any) {
          return {
            sys_id: c.sys_id,
            name: c.name,
            type: c.type,
            active: c.active === "true",
          }
        }),
        health: spokeData.active === "true" ? "active" : "inactive",
      })
    } else if (action === "activate" || action === "deactivate") {
      if (!spoke_id && !spoke_name) {
        return createErrorResult("spoke_id or spoke_name is required for " + action + " action")
      }

      // Find the spoke first
      var findQuery = spoke_id ? "sys_id=" + spoke_id : "nameLIKE" + spoke_name
      var findResponse = await client.get("/api/now/table/sys_hub_spoke", {
        params: {
          sysparm_query: findQuery,
          sysparm_limit: 1,
          sysparm_fields: "sys_id,name,active",
        },
      })

      if (!findResponse.data.result || findResponse.data.result.length === 0) {
        return createErrorResult("Spoke not found")
      }

      var foundSpoke = findResponse.data.result[0]
      var newActiveState = action === "activate"

      // Update the spoke
      await client.patch("/api/now/table/sys_hub_spoke/" + foundSpoke.sys_id, {
        active: newActiveState,
      })

      return createSuccessResult({
        action: action,
        spoke: {
          sys_id: foundSpoke.sys_id,
          name: foundSpoke.name,
          previous_state: foundSpoke.active === "true" ? "active" : "inactive",
          new_state: newActiveState ? "active" : "inactive",
        },
        message: "Spoke " + (newActiveState ? "activated" : "deactivated") + " successfully",
      })
    } else if (action === "install") {
      // Installation typically requires the plugin to be activated
      // This redirects to the plugin activation process
      return createSuccessResult({
        action: "install",
        message: "Spoke installation is handled through plugin activation",
        instructions: [
          "1. Use snow_list_plugins to find the spoke plugin",
          "2. Use snow_activate_plugin with the plugin sys_id to install",
          "3. After activation, configure connection aliases with snow_create_connection_alias",
          "4. Set up credentials with snow_create_credential_alias",
        ],
        common_spokes: [
          { name: "Jira Spoke", plugin: "com.snc.integration.jira" },
          { name: "Slack Spoke", plugin: "com.snc.integration.slack" },
          { name: "Microsoft Teams Spoke", plugin: "com.snc.integration.teams" },
          { name: "Azure DevOps Spoke", plugin: "com.snc.integration.azure_devops" },
          { name: "Salesforce Spoke", plugin: "com.snc.integration.salesforce" },
          { name: "ServiceNow Spoke", plugin: "com.snc.integration.servicenow" },
        ],
      })
    }

    return createErrorResult("Unknown action: " + action)
  } catch (error: any) {
    if (error.response?.status === 403) {
      return createErrorResult(
        "Permission denied (403): Your ServiceNow user lacks permissions to manage spokes. " +
          'Required roles: "admin" or "flow_designer". Please contact your ServiceNow administrator.',
      )
    }
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Team"
