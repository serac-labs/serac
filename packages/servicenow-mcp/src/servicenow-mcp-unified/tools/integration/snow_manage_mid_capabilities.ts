/**
 * snow_manage_mid_capabilities - Manage MID Server capabilities
 *
 * View, add, remove, and manage MID Server capabilities for
 * Discovery, Orchestration, and Integration purposes.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_manage_mid_capabilities",
  description: "Manage MID Server capabilities for Discovery, Orchestration, and integrations",
  category: "integration",
  subcategory: "mid-server",
  use_cases: ["mid-server", "capabilities", "discovery", "orchestration"],
  complexity: "advanced",
  frequency: "low",

  permission: "admin",
  allowedRoles: ["admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "list_available", "add", "remove", "status", "recommend"],
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
      capability_name: {
        type: "string",
        description: "Name of the capability to add/remove",
      },
      capability_id: {
        type: "string",
        description: "sys_id of the capability to add/remove",
      },
      use_case: {
        type: "string",
        enum: ["discovery", "orchestration", "integration", "service_mapping", "cloud", "all"],
        description: "Filter capabilities by use case",
        default: "all",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var action = args.action || "list"
  var mid_server_name = args.mid_server_name || ""
  var mid_server_id = args.mid_server_id || ""
  var capability_name = args.capability_name || ""
  var capability_id = args.capability_id || ""
  var use_case = args.use_case || "all"

  try {
    var client = await getAuthenticatedClient(context)

    // Resolve MID Server ID if name provided
    var midId = mid_server_id
    var midName = mid_server_name
    if (!midId && mid_server_name) {
      var lookupResponse = await client.get("/api/now/table/ecc_agent", {
        params: {
          sysparm_query: "name=" + mid_server_name,
          sysparm_limit: 1,
          sysparm_fields: "sys_id,name",
        },
      })

      if (lookupResponse.data.result && lookupResponse.data.result.length > 0) {
        midId = lookupResponse.data.result[0].sys_id
        midName = lookupResponse.data.result[0].name
      }
    } else if (midId && !midName) {
      var nameLookup = await client.get("/api/now/table/ecc_agent/" + midId, {
        params: {
          sysparm_fields: "name",
        },
      })
      if (nameLookup.data.result) {
        midName = nameLookup.data.result.name
      }
    }

    if (action === "list") {
      if (!midId) {
        return createErrorResult("mid_server_id or mid_server_name is required for list action")
      }

      // Get capabilities assigned to this MID Server
      var assignedResponse = await client.get("/api/now/table/ecc_agent_capability_m2m", {
        params: {
          sysparm_query: "agent=" + midId,
          sysparm_fields: "sys_id,capability",
          sysparm_display_value: "all",
          sysparm_limit: 200,
        },
      })

      var assigned = assignedResponse.data.result || []

      // Get full capability details
      var capabilityDetails = []
      for (var i = 0; i < assigned.length; i++) {
        var assignment = assigned[i]
        var capId = assignment.capability?.value || assignment.capability

        if (capId) {
          var capResponse = await client.get("/api/now/table/ecc_agent_capability/" + capId, {
            params: {
              sysparm_fields: "name,description,category,active",
            },
          })

          if (capResponse.data.result) {
            var cap = capResponse.data.result
            capabilityDetails.push({
              assignment_id: assignment.sys_id,
              capability_id: capId,
              name: cap.name,
              description: cap.description,
              category: cap.category,
              active: cap.active === "true" || cap.active === true,
            })
          }
        }
      }

      // Filter by use case if specified
      if (use_case !== "all") {
        var useCaseMapping: any = {
          discovery: ["Discovery", "Network", "SNMP", "WMI", "SSH"],
          orchestration: ["Orchestration", "PowerShell", "SSH", "REST"],
          integration: ["REST", "HTTP", "SOAP", "JDBC"],
          service_mapping: ["ServiceMapping", "Discovery", "Pattern"],
          cloud: ["AWS", "Azure", "GCP", "Cloud"],
        }

        var keywords = useCaseMapping[use_case] || []
        capabilityDetails = capabilityDetails.filter(function (cap: any) {
          for (var j = 0; j < keywords.length; j++) {
            if (
              (cap.name && cap.name.indexOf(keywords[j]) >= 0) ||
              (cap.category && cap.category.indexOf(keywords[j]) >= 0)
            ) {
              return true
            }
          }
          return false
        })
      }

      // Group by category
      var byCategory: any = {}
      capabilityDetails.forEach(function (cap: any) {
        var cat = cap.category || "Uncategorized"
        if (!byCategory[cat]) {
          byCategory[cat] = []
        }
        byCategory[cat].push(cap)
      })

      return createSuccessResult({
        action: "list",
        mid_server: {
          sys_id: midId,
          name: midName,
        },
        capabilities: capabilityDetails,
        total: capabilityDetails.length,
        by_category: byCategory,
        filter: use_case,
      })
    } else if (action === "list_available") {
      // List all available capabilities
      var queryParts: string[] = ["active=true"]

      if (use_case !== "all") {
        var categoryKeywords: any = {
          discovery: "Discovery",
          orchestration: "Orchestration",
          integration: "Integration",
          service_mapping: "ServiceMapping",
          cloud: "Cloud",
        }
        if (categoryKeywords[use_case]) {
          queryParts.push("categoryLIKE" + categoryKeywords[use_case] + "^ORnameLIKE" + categoryKeywords[use_case])
        }
      }

      var availableResponse = await client.get("/api/now/table/ecc_agent_capability", {
        params: {
          sysparm_query: queryParts.join("^") + "^ORDERBYcategory^ORDERBYname",
          sysparm_limit: 500,
          sysparm_fields: "sys_id,name,description,category,active",
        },
      })

      var available = availableResponse.data.result || []

      // Group by category
      var availableByCategory: any = {}
      available.forEach(function (cap: any) {
        var cat = cap.category || "Uncategorized"
        if (!availableByCategory[cat]) {
          availableByCategory[cat] = []
        }
        availableByCategory[cat].push({
          sys_id: cap.sys_id,
          name: cap.name,
          description: cap.description,
        })
      })

      return createSuccessResult({
        action: "list_available",
        capabilities: available.map(function (cap: any) {
          return {
            sys_id: cap.sys_id,
            name: cap.name,
            description: cap.description,
            category: cap.category,
          }
        }),
        total: available.length,
        by_category: availableByCategory,
        filter: use_case,
      })
    } else if (action === "add") {
      if (!midId) {
        return createErrorResult("mid_server_id or mid_server_name is required")
      }

      var capToAdd = capability_id
      if (!capToAdd && capability_name) {
        var capLookup = await client.get("/api/now/table/ecc_agent_capability", {
          params: {
            sysparm_query: "name=" + capability_name,
            sysparm_limit: 1,
            sysparm_fields: "sys_id,name",
          },
        })
        if (capLookup.data.result && capLookup.data.result.length > 0) {
          capToAdd = capLookup.data.result[0].sys_id
        }
      }

      if (!capToAdd) {
        return createErrorResult("Capability not found. Use list_available to see options.")
      }

      // Check if already assigned
      var existingCheck = await client.get("/api/now/table/ecc_agent_capability_m2m", {
        params: {
          sysparm_query: "agent=" + midId + "^capability=" + capToAdd,
          sysparm_limit: 1,
          sysparm_fields: "sys_id",
        },
      })

      if (existingCheck.data.result && existingCheck.data.result.length > 0) {
        return createSuccessResult({
          action: "add",
          already_assigned: true,
          message: "Capability is already assigned to this MID Server",
          assignment_id: existingCheck.data.result[0].sys_id,
        })
      }

      // Add capability
      var addResponse = await client.post("/api/now/table/ecc_agent_capability_m2m", {
        agent: midId,
        capability: capToAdd,
      })

      return createSuccessResult({
        action: "add",
        mid_server: {
          sys_id: midId,
          name: midName,
        },
        capability_id: capToAdd,
        assignment_id: addResponse.data.result?.sys_id,
        message: "Capability added successfully",
      })
    } else if (action === "remove") {
      if (!midId) {
        return createErrorResult("mid_server_id or mid_server_name is required")
      }

      var capToRemove = capability_id
      if (!capToRemove && capability_name) {
        var capRemoveLookup = await client.get("/api/now/table/ecc_agent_capability", {
          params: {
            sysparm_query: "name=" + capability_name,
            sysparm_limit: 1,
            sysparm_fields: "sys_id",
          },
        })
        if (capRemoveLookup.data.result && capRemoveLookup.data.result.length > 0) {
          capToRemove = capRemoveLookup.data.result[0].sys_id
        }
      }

      if (!capToRemove) {
        return createErrorResult("Capability not found")
      }

      // Find assignment record
      var assignmentLookup = await client.get("/api/now/table/ecc_agent_capability_m2m", {
        params: {
          sysparm_query: "agent=" + midId + "^capability=" + capToRemove,
          sysparm_limit: 1,
          sysparm_fields: "sys_id",
        },
      })

      if (!assignmentLookup.data.result || assignmentLookup.data.result.length === 0) {
        return createSuccessResult({
          action: "remove",
          not_assigned: true,
          message: "Capability is not assigned to this MID Server",
        })
      }

      // Remove capability
      await client.delete("/api/now/table/ecc_agent_capability_m2m/" + assignmentLookup.data.result[0].sys_id)

      return createSuccessResult({
        action: "remove",
        mid_server: {
          sys_id: midId,
          name: midName,
        },
        capability_id: capToRemove,
        message: "Capability removed successfully",
      })
    } else if (action === "status") {
      if (!midId) {
        return createErrorResult("mid_server_id or mid_server_name is required")
      }

      // Get all capabilities and check status
      var statusResponse = await client.get("/api/now/table/ecc_agent_capability_m2m", {
        params: {
          sysparm_query: "agent=" + midId,
          sysparm_fields: "capability",
          sysparm_display_value: "all",
          sysparm_limit: 200,
        },
      })

      var statusCaps = statusResponse.data.result || []

      // Get MID Server status
      var midStatus = await client.get("/api/now/table/ecc_agent/" + midId, {
        params: {
          sysparm_fields: "name,status,validated,ip_address,version",
        },
      })

      var midInfo = midStatus.data.result

      // Categorize capabilities
      var capsByCategory: any = {
        discovery: [],
        orchestration: [],
        integration: [],
        other: [],
      }

      for (var k = 0; k < statusCaps.length; k++) {
        var capName = statusCaps[k].capability?.display_value || statusCaps[k].capability || ""
        var capNameLower = capName.toLowerCase()

        if (
          capNameLower.indexOf("discovery") >= 0 ||
          capNameLower.indexOf("snmp") >= 0 ||
          capNameLower.indexOf("wmi") >= 0 ||
          capNameLower.indexOf("ssh") >= 0
        ) {
          capsByCategory.discovery.push(capName)
        } else if (capNameLower.indexOf("orchestration") >= 0 || capNameLower.indexOf("powershell") >= 0) {
          capsByCategory.orchestration.push(capName)
        } else if (
          capNameLower.indexOf("rest") >= 0 ||
          capNameLower.indexOf("http") >= 0 ||
          capNameLower.indexOf("jdbc") >= 0 ||
          capNameLower.indexOf("soap") >= 0
        ) {
          capsByCategory.integration.push(capName)
        } else {
          capsByCategory.other.push(capName)
        }
      }

      return createSuccessResult({
        action: "status",
        mid_server: {
          sys_id: midId,
          name: midInfo.name,
          status: midInfo.status,
          validated: midInfo.validated === "true",
          ip_address: midInfo.ip_address,
          version: midInfo.version,
        },
        capability_summary: {
          total: statusCaps.length,
          discovery: capsByCategory.discovery.length,
          orchestration: capsByCategory.orchestration.length,
          integration: capsByCategory.integration.length,
          other: capsByCategory.other.length,
        },
        capabilities_by_category: capsByCategory,
        readiness: {
          discovery_ready: capsByCategory.discovery.length > 0,
          orchestration_ready: capsByCategory.orchestration.length > 0,
          integration_ready: capsByCategory.integration.length > 0,
        },
      })
    } else if (action === "recommend") {
      // Recommend capabilities based on use case
      var recommendations: any = {
        discovery: ["SSH", "WMI", "SNMP", "PowerShell", "VMware", "Network Discovery", "IP Network", "Pattern Probe"],
        orchestration: ["PowerShell", "SSH", "REST", "Orchestration", "Script Execution", "Remote Commands"],
        integration: ["REST", "HTTP", "SOAP", "JDBC", "File Transfer", "Email", "LDAP"],
        service_mapping: ["Pattern Probe", "Service Mapping", "Discovery", "SSH", "WMI", "Network Discovery"],
        cloud: ["AWS", "Azure", "GCP", "Cloud Discovery", "REST", "HTTP"],
      }

      var selectedUseCase = use_case === "all" ? "discovery" : use_case

      return createSuccessResult({
        action: "recommend",
        use_case: selectedUseCase,
        recommended_capabilities: recommendations[selectedUseCase] || [],
        all_use_cases: Object.keys(recommendations),
        instructions: [
          "Use list_available to find exact capability names",
          "Use add action to assign recommended capabilities",
          "Validate MID Server after adding capabilities",
        ],
      })
    }

    return createErrorResult("Unknown action: " + action)
  } catch (error: any) {
    if (error.response?.status === 403) {
      return createErrorResult(
        "Permission denied (403): Your ServiceNow user lacks permissions to manage MID capabilities. " +
          'Required roles: "mid_server" or "admin".',
      )
    }
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Team"
