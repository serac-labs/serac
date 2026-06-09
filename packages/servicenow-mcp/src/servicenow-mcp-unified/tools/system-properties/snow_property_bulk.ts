/**
 * snow_property_bulk - Bulk System Property Operations
 *
 * Unified tool for bulk property operations: get multiple or set multiple.
 *
 * Replaces: snow_property_bulk_get, snow_property_bulk_set
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_property_bulk",
  description: "Bulk system property operations (get/set multiple)",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "properties",
  use_cases: ["properties", "bulk-operations", "batch"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Bulk operation - modifies multiple properties
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Bulk action to perform",
        enum: ["get", "set"],
      },
      // GET parameters
      names: {
        type: "array",
        description: "[get] Array of property names to retrieve",
        items: { type: "string" },
      },
      // SET parameters
      properties: {
        type: "array",
        description: "[set] Array of properties to set",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "string" },
            description: { type: "string" },
            type: { type: "string" },
          },
        },
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    switch (action) {
      case "get":
        return await executeBulkGet(args, context)
      case "set":
        return await executeBulkSet(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== BULK GET ====================
async function executeBulkGet(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { names } = args

  if (!names || !Array.isArray(names) || names.length === 0) {
    return createErrorResult("names array is required for bulk get action")
  }

  const client = await getAuthenticatedClient(context)

  // Build query for all names
  const nameQuery = names.map((name) => `name=${name}`).join("^OR")

  const response = await client.get("/api/now/table/sys_properties", {
    params: {
      sysparm_query: nameQuery,
      sysparm_fields: "name,value,description,type,suffix",
      sysparm_limit: names.length,
    },
  })

  const properties = response.data.result || []
  const propertyMap: Record<string, any> = {}

  properties.forEach((p: any) => {
    propertyMap[p.name] = {
      value: p.value,
      description: p.description || "",
      type: p.type || "string",
      suffix: p.suffix || "global",
    }
  })

  // Include not found properties
  const notFound = names.filter((name) => !propertyMap[name])

  return createSuccessResult({
    properties: propertyMap,
    found_count: properties.length,
    not_found: notFound,
    requested_count: names.length,
  })
}

// ==================== BULK SET ====================
async function executeBulkSet(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { properties } = args

  if (!properties || !Array.isArray(properties) || properties.length === 0) {
    return createErrorResult("properties array is required for bulk set action")
  }

  const client = await getAuthenticatedClient(context)

  const results: any[] = []
  let successCount = 0
  let errorCount = 0

  for (const prop of properties) {
    try {
      const { name, value, description, type = "string" } = prop

      if (!name || !value) {
        results.push({ name: name || "unknown", success: false, error: "Missing name or value" })
        errorCount++
        continue
      }

      // Check if exists
      const existingResponse = await client.get("/api/now/table/sys_properties", {
        params: {
          sysparm_query: `name=${name}`,
          sysparm_limit: 1,
        },
      })

      if (existingResponse.data.result && existingResponse.data.result.length > 0) {
        // Update
        const sys_id = existingResponse.data.result[0].sys_id
        await client.put(`/api/now/table/sys_properties/${sys_id}`, {
          value,
          description,
          type,
        })
        results.push({ name, success: true, action: "updated" })
      } else {
        // Create
        await client.post("/api/now/table/sys_properties", {
          name,
          value,
          description: description || "Created by Serac bulk operation",
          type,
          suffix: "global",
        })
        results.push({ name, success: true, action: "created" })
      }

      successCount++
    } catch (error: any) {
      results.push({ name: prop.name, success: false, error: error.message })
      errorCount++
    }
  }

  return createSuccessResult({
    results,
    summary: {
      total: properties.length,
      success: successCount,
      errors: errorCount,
    },
  })
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging"
