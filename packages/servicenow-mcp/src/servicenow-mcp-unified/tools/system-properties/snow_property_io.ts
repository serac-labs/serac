/**
 * snow_property_io - System Property Import/Export/History
 *
 * Unified tool for property I/O operations: import from JSON, export to JSON, view history.
 *
 * Replaces: snow_property_import, snow_property_export, snow_property_history
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_property_io",
  description: "System property I/O operations (import, export, history)",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "properties",
  use_cases: ["properties", "backup", "migration", "audit"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Property I/O - imports properties which modifies ServiceNow
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "I/O action to perform",
        enum: ["import", "export", "history"],
      },
      // IMPORT parameters
      properties: {
        type: "array",
        description: "[import] Array of properties to import",
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
      // EXPORT parameters
      pattern: {
        type: "string",
        description: "[export] Property name pattern (exports matching properties)",
      },
      suffix: {
        type: "string",
        description: "[export] Filter by suffix",
      },
      // HISTORY parameters
      property_name: {
        type: "string",
        description: "[history] Property name to get history for",
      },
      limit: {
        type: "number",
        description: "[history] Maximum history records",
        default: 50,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    switch (action) {
      case "import":
        return await executeImport(args, context)
      case "export":
        return await executeExport(args, context)
      case "history":
        return await executeHistory(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== IMPORT ====================
async function executeImport(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { properties } = args

  if (!properties || !Array.isArray(properties) || properties.length === 0) {
    return createErrorResult("properties array is required for import action")
  }

  const client = await getAuthenticatedClient(context)

  const results: any[] = []
  let imported = 0
  let skipped = 0

  for (const prop of properties) {
    try {
      const { name, value, description, type = "string" } = prop

      if (!name || !value) {
        results.push({ name: name || "unknown", status: "skipped", reason: "Missing name or value" })
        skipped++
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
        // Update existing
        const sys_id = existingResponse.data.result[0].sys_id
        await client.put(`/api/now/table/sys_properties/${sys_id}`, {
          value,
          description,
          type,
        })
        results.push({ name, status: "updated" })
      } else {
        // Create new
        await client.post("/api/now/table/sys_properties", {
          name,
          value,
          description: description || "Imported by Serac",
          type,
          suffix: "global",
        })
        results.push({ name, status: "created" })
      }

      imported++
    } catch (error: any) {
      results.push({ name: prop.name, status: "error", error: error.message })
      skipped++
    }
  }

  return createSuccessResult({
    import_results: results,
    summary: {
      total: properties.length,
      imported,
      skipped,
    },
  })
}

// ==================== EXPORT ====================
async function executeExport(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { pattern, suffix } = args
  const client = await getAuthenticatedClient(context)

  // Build query
  let query = ""
  if (pattern) {
    query = `nameLIKE${pattern}`
  }
  if (suffix) {
    query += query ? `^suffix=${suffix}` : `suffix=${suffix}`
  }

  const response = await client.get("/api/now/table/sys_properties", {
    params: {
      sysparm_query: query,
      sysparm_fields: "name,value,description,type,suffix,is_private",
      sysparm_limit: 1000,
      sysparm_orderby: "name",
    },
  })

  const properties = response.data.result || []

  const exportData = properties.map((p: any) => ({
    name: p.name,
    value: p.value || "",
    description: p.description || "",
    type: p.type || "string",
    suffix: p.suffix || "global",
    is_private: p.is_private === "true",
  }))

  const exportJson = JSON.stringify(exportData, null, 2)

  return createSuccessResult({
    properties: exportData,
    export_json: exportJson,
    count: exportData.length,
    exported_at: new Date().toISOString(),
    filter: {
      pattern: pattern || null,
      suffix: suffix || null,
    },
  })
}

// ==================== HISTORY ====================
async function executeHistory(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { property_name, limit = 50 } = args

  if (!property_name) {
    return createErrorResult("property_name is required for history action")
  }

  const client = await getAuthenticatedClient(context)

  // Get property sys_id first
  const propResponse = await client.get("/api/now/table/sys_properties", {
    params: {
      sysparm_query: `name=${property_name}`,
      sysparm_fields: "sys_id",
      sysparm_limit: 1,
    },
  })

  if (!propResponse.data.result || propResponse.data.result.length === 0) {
    return createErrorResult(`Property not found: ${property_name}`)
  }

  const sys_id = propResponse.data.result[0].sys_id

  // Get audit history
  const historyResponse = await client.get("/api/now/table/sys_audit", {
    params: {
      sysparm_query: `tablename=sys_properties^documentkey=${sys_id}`,
      sysparm_fields: "fieldname,oldvalue,newvalue,sys_created_on,sys_created_by,reason",
      sysparm_limit: limit,
      sysparm_orderby: "DESCsys_created_on",
    },
  })

  const history = historyResponse.data.result || []

  return createSuccessResult({
    property_name,
    sys_id,
    history: history.map((h: any) => ({
      field: h.fieldname,
      old_value: h.oldvalue || "",
      new_value: h.newvalue || "",
      changed_at: h.sys_created_on,
      changed_by: h.sys_created_by,
      reason: h.reason || "",
    })),
    count: history.length,
    note: history.length === 0 ? "No audit history found (audit may not be enabled for this property)" : null,
  })
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging"
