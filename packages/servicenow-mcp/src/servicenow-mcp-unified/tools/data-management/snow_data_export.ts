/**
 * snow_data_export
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_data_export",
  description:
    "Export table data to CSV/XML/JSON format. Always includes sys_id. Returns records array with full data.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "data-utilities",
  use_cases: ["export", "data-management", "backup"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table name" },
      query: { type: "string", description: "Query filter" },
      fields: { type: "array", items: { type: "string" }, description: "Fields to export" },
      format: { type: "string", enum: ["csv", "xml", "json"], default: "json" },
      limit: { type: "number", default: 1000 },
    },
    required: ["table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, query, fields, format = "json", limit = 1000 } = args
  try {
    const client = await getAuthenticatedClient(context)
    const params: any = { sysparm_limit: limit }
    if (query) params.sysparm_query = query

    // Always include sys_id in exports
    if (fields && fields.length > 0) {
      const fieldsWithSysId = fields.includes("sys_id") ? fields : ["sys_id", ...fields]
      params.sysparm_fields = fieldsWithSysId.join(",")
    }

    const response = await client.get(`/api/now/table/${table}`, { params })
    const records = response.data.result || []

    // Format based on requested format
    let formattedData: any
    if (format === "csv") {
      // Convert to CSV format
      if (records.length === 0) {
        formattedData = ""
      } else {
        const headers = Object.keys(records[0])
        const csvRows = [headers.join(",")]
        for (const record of records) {
          const values = headers.map((h) => {
            const val = record[h] || ""
            // Escape commas and quotes in values
            const escaped = String(val).replace(/"/g, '""')
            return escaped.includes(",") || escaped.includes('"') || escaped.includes("\n") ? `"${escaped}"` : escaped
          })
          csvRows.push(values.join(","))
        }
        formattedData = csvRows.join("\n")
      }
    } else if (format === "xml") {
      // Simple XML format
      const xmlRecords = records
        .map((r: any) => {
          const fields = Object.entries(r)
            .map(
              ([k, v]) =>
                `    <${k}>${String(v || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] || c)}</${k}>`,
            )
            .join("\n")
          return `  <record>\n${fields}\n  </record>`
        })
        .join("\n")
      formattedData = `<?xml version="1.0" encoding="UTF-8"?>\n<${table}>\n${xmlRecords}\n</${table}>`
    } else {
      // JSON format (default)
      formattedData = records
    }

    return createSuccessResult({
      table,
      format,
      count: records.length,
      records: formattedData, // Main data is in 'records' for clarity
      message: `Exported ${records.length} records from ${table} in ${format.toUpperCase()} format`,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
