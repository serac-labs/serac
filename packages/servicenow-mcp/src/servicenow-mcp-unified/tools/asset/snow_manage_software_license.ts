/**
 * snow_manage_software_license - Manage software licenses with compliance tracking
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_manage_software_license",
  description: "Manage software licenses with compliance tracking and optimization",
  // Metadata for tool discovery (not sent to LLM)
  category: "asset-management",
  subcategory: "license-management",
  use_cases: ["licenses", "compliance", "sam"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Management operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      license_name: { type: "string", description: "Software license name" },
      publisher: { type: "string", description: "Software publisher/vendor" },
      licensed_installs: { type: "number", description: "Number of licensed installations" },
      license_type: {
        type: "string",
        description: "Type of license",
        enum: ["named_user", "concurrent_user", "server", "enterprise"],
      },
      cost_per_license: { type: "number", description: "Cost per license" },
      expiration_date: { type: "string", description: "License expiration (YYYY-MM-DD)" },
      auto_renew: { type: "boolean", description: "Automatic renewal enabled" },
    },
    required: ["license_name", "publisher", "licensed_installs"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    license_name,
    publisher,
    licensed_installs,
    license_type = "named_user",
    cost_per_license = 0,
    expiration_date,
    auto_renew = false,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Check if license already exists
    const existingLicense = await client.get(
      `/api/now/table/alm_license?sysparm_query=display_name=${license_name}^publisher=${publisher}&sysparm_limit=1`,
    )

    if (existingLicense.data.result.length > 0) {
      // Update existing license
      const licenseId = existingLicense.data.result[0].sys_id
      const response = await client.patch(`/api/now/table/alm_license/${licenseId}`, {
        license_count: licensed_installs,
        license_type,
        cost: cost_per_license,
        expiration_date,
        auto_renew,
      })

      return createSuccessResult({
        action: "updated",
        license: response.data.result,
        annual_cost: cost_per_license * licensed_installs,
      })
    } else {
      // Create new license
      const response = await client.post("/api/now/table/alm_license", {
        display_name: license_name,
        publisher,
        license_count: licensed_installs,
        license_type,
        cost: cost_per_license,
        expiration_date,
        auto_renew,
      })

      return createSuccessResult({
        action: "created",
        license: response.data.result,
        annual_cost: cost_per_license * licensed_installs,
      })
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
