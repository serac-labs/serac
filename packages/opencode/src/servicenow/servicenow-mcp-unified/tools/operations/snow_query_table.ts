/**
 * snow_query_table - Universal table querying
 *
 * Query any ServiceNow table with pagination, filtering, and field selection.
 * The most frequently used tool in Serac.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

// Fields that typically contain large content and should be truncated
const LARGE_CONTENT_FIELDS = [
  "template",
  "script",
  "server_script",
  "client_script",
  "css",
  "html",
  "xml",
  "json",
  "payload",
  "body",
  "content",
  "description",
  "comments",
  "work_notes",
  "additional_comments",
  "close_notes",
  "resolution_notes",
  "instructions",
  "short_description",
  "long_description",
]

// Maximum length for field values before truncation
const MAX_FIELD_LENGTH = 200

/**
 * Truncate large field values in records for cleaner output
 */
function truncateRecords(records: any[], truncate: boolean): any[] {
  if (!truncate) return records

  return records.map((record) => {
    const truncated: any = {}
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string" && value.length > MAX_FIELD_LENGTH) {
        // Check if it's a known large content field or just a long string
        const isLargeField = LARGE_CONTENT_FIELDS.some((f) => key.toLowerCase().includes(f))
        if (isLargeField || value.length > MAX_FIELD_LENGTH * 2) {
          truncated[key] = value.substring(0, MAX_FIELD_LENGTH) + `... [truncated, ${value.length} chars total]`
        } else {
          truncated[key] = value
        }
      } else {
        truncated[key] = value
      }
    }
    return truncated
  })
}

export const toolDefinition: MCPToolDefinition = {
  name: "snow_query_table",
  description:
    "Query any ServiceNow table with filtering, pagination, and field selection. Always returns sys_id for each record.",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "crud",
  use_cases: ["query", "read", "records"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - only queries data, no modifications
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],

  inputSchema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Table name to query (e.g., incident, task, sys_user)",
      },
      query: {
        type: "string",
        description: "Encoded query string (e.g., active=true^priority=1)",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Fields to return (default: all fields)",
        default: [],
      },
      limit: {
        type: "number",
        description: "Maximum number of records to return",
        default: 100,
        minimum: 1,
        maximum: 10000,
      },
      offset: {
        type: "number",
        description: "Number of records to skip (for pagination)",
        default: 0,
        minimum: 0,
      },
      order_by: {
        type: "string",
        description: "Field to order by (prefix with - for descending, e.g., -sys_created_on)",
      },
      display_value: {
        type: "boolean",
        description: "Return display values instead of sys_ids for reference fields",
        default: false,
      },
      truncate_output: {
        type: "boolean",
        description: "Truncate large field values (scripts, templates, etc.) for cleaner output",
        default: true,
      },
    },
    required: ["table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    table,
    query = "",
    limit = 100,
    offset = 0,
    truncate_output = true,
  } = args

  // Be permissive: LLMs routinely send snake_case OR camelCase, and `fields`
  // as array OR comma-separated string. Normalize before use — a wrongly-typed
  // string would otherwise spread character-by-character into params.
  const rawFields = args.fields ?? []
  const fields: string[] = Array.isArray(rawFields)
    ? rawFields
    : typeof rawFields === "string"
    ? rawFields.split(",").map((s) => s.trim()).filter(Boolean)
    : []
  const order_by: string | undefined = args.order_by ?? args.orderBy
  const display_value: boolean = args.display_value ?? args.displayValue ?? false

  try {
    const client = await getAuthenticatedClient(context)

    // Build query parameters
    const params: any = {
      sysparm_limit: limit,
      sysparm_offset: offset,
    }

    if (query) {
      params.sysparm_query = query
    }

    if (fields.length > 0) {
      // ALWAYS include sys_id - it's essential for follow-up operations
      const fieldsWithSysId = fields.includes("sys_id") ? fields : ["sys_id", ...fields]
      params.sysparm_fields = fieldsWithSysId.join(",")
    }

    if (order_by) {
      // Handle descending order (prefix with -)
      const direction = order_by.startsWith("-") ? "DESC" : "ASC"
      const field = order_by.replace(/^-/, "")
      params.sysparm_query = (params.sysparm_query || "") + `^ORDERBY${direction}${field}`
    }

    if (display_value) {
      params.sysparm_display_value = "true"
    }

    // Execute query
    const response = await client.get(`/api/now/table/${table}`, { params })

    const rawRecords = response.data.result
    const records = truncateRecords(rawRecords, truncate_output)

    // Build a human-readable summary with record preview
    const summaryLines: string[] = []
    summaryLines.push(`Found ${records.length} record(s) in ${table}`)

    if (records.length > 0) {
      summaryLines.push("")
      summaryLines.push("Record Preview:")

      // Show first 5 records with key fields
      const previewCount = Math.min(records.length, 5)
      for (let i = 0; i < previewCount; i++) {
        const record = records[i]
        const sysId = record.sys_id || "unknown"
        const identifier = record.number || record.name || record.short_description || record.title || sysId

        // Show key fields for this record
        const keyFields: string[] = [`sys_id: ${sysId}`]
        if (record.number) keyFields.push(`number: ${record.number}`)
        if (record.name && record.name !== record.number) keyFields.push(`name: ${record.name}`)
        if (record.short_description)
          keyFields.push(
            `short_description: ${record.short_description.substring(0, 50)}${record.short_description.length > 50 ? "..." : ""}`,
          )
        if (record.state) keyFields.push(`state: ${record.state}`)
        if (record.active !== undefined) keyFields.push(`active: ${record.active}`)

        summaryLines.push(`  ${i + 1}. ${identifier}`)
        summaryLines.push(`     ${keyFields.join(" | ")}`)
      }

      if (records.length > 5) {
        summaryLines.push(`  ... and ${records.length - 5} more records`)
      }
    }

    if (records.length === limit) {
      summaryLines.push("")
      summaryLines.push(`Note: Results may be limited. Use offset parameter to paginate.`)
    }

    return createSuccessResult(
      {
        records,
        count: records.length,
        total: records.length < limit ? records.length : "100+", // Actual total requires additional query
        has_more: records.length === limit,
        truncated: truncate_output,
      },
      {
        table,
        query,
        limit,
        offset,
      },
      summaryLines.join("\n"),
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
