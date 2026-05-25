/**
 * snow_get_catalog_item_details - Get catalog item details
 *
 * Gets detailed information about a catalog item including variables, pricing, and availability.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_catalog_item_details",
  description: "Gets detailed information about a catalog item including variables, pricing, and availability.",
  // Metadata for tool discovery (not sent to LLM)
  category: "itsm",
  subcategory: "service-catalog",
  use_cases: ["catalog", "retrieval", "details"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      sys_id: { type: "string", description: "Catalog item sys_id" },
      include_variables: { type: "boolean", description: "Include all variables", default: true },
      include_ui_policies: { type: "boolean", description: "Include UI policies", default: false },
      include_client_scripts: { type: "boolean", description: "Include client scripts", default: false },
    },
    required: ["sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { sys_id, include_variables = true, include_ui_policies = false, include_client_scripts = false } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Get catalog item
    const itemResponse = await client.get(`/api/now/table/sc_cat_item/${sys_id}`)
    const item = itemResponse.data.result

    // Get variables if requested
    let variables = []
    if (include_variables) {
      const varResponse = await client.get("/api/now/table/item_option_new", {
        params: {
          sysparm_query: `cat_item=${sys_id}`,
          sysparm_limit: 50,
        },
      })
      variables = varResponse.data.result
    }

    // Get UI policies if requested
    let uiPolicies = []
    if (include_ui_policies) {
      const policyResponse = await client.get("/api/now/table/catalog_ui_policy", {
        params: {
          sysparm_query: `catalog_item=${sys_id}`,
          sysparm_limit: 50,
        },
      })
      uiPolicies = policyResponse.data.result
    }

    // Get client scripts if requested
    let clientScripts = []
    if (include_client_scripts) {
      const scriptResponse = await client.get("/api/now/table/catalog_script_client", {
        params: {
          sysparm_query: `cat_item=${sys_id}`,
          sysparm_limit: 50,
        },
      })
      clientScripts = scriptResponse.data.result
    }

    return createSuccessResult(
      {
        item,
        variables: include_variables ? variables : undefined,
        ui_policies: include_ui_policies ? uiPolicies : undefined,
        client_scripts: include_client_scripts ? clientScripts : undefined,
        variable_count: variables.length,
        ui_policy_count: uiPolicies.length,
        client_script_count: clientScripts.length,
      },
      {
        operation: "get_catalog_item_details",
        item_id: sys_id,
      },
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
