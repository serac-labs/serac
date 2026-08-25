/**
 * snow_query_table - Universal table querying
 *
 * Query any ServiceNow table with pagination, filtering, and field selection.
 * The most frequently used tool in Serac.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
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

/**
 * Translate the tool's arguments into Table API query parameters.
 *
 * Exported and pure for the same reason `buildStatsParams` is: the ordering
 * clause is the whole of what this tool got wrong, and it is decidable without
 * an instance. `order_by: "sys_created_on"` used to emit
 * `^ORDERBYASCsys_created_on` — ASC is not part of any ServiceNow operator, so
 * the instance dropped the clause and answered in its own order. The caller
 * asked for the oldest record and got an arbitrary one, with nothing in the
 * response to say so; the descending direction, spelled ORDERBYDESC, worked
 * the whole time, which is why this survived.
 *
 * Throws on input the API cannot act on, the way buildStatsParams does.
 */
export function buildQueryParams(args: any) {
  const table = String(args.table ?? "").trim()
  if (!table) throw new Error("table is required")

  // Be permissive: LLMs routinely send snake_case OR camelCase, and `fields`
  // as array OR comma-separated string. Normalize before use — a wrongly-typed
  // string would otherwise spread character-by-character into params.
  const raw = args.fields ?? []
  const fields: string[] = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : []
  const order: string = String(args.order_by ?? args.orderBy ?? "").trim()
  const display: boolean = args.display_value ?? args.displayValue ?? false
  const query = String(args.query ?? "").trim()
  // Coerced here, once, because these two leave this function as numbers used
  // in arithmetic: `has_more` is `offset + records.length < total`, and a
  // string offset makes that `"100" + 25 === "10025"` — "there is no more" on
  // page two of a long table, silently. Same reason `limit` is coerced: it is
  // compared with `===` against a length. LLM callers send both as strings.
  const limit = numeric(args.limit, 100)
  const offset = numeric(args.offset, 0)

  // ORDERBY<field> ascending, ORDERBYDESC<field> descending — those are the two
  // operators. It joins onto the caller's own conditions with ^, and stands
  // alone when there are none rather than leading with a bare separator.
  const ordered = order === "" ? "" : `ORDERBY${order.startsWith("-") ? "DESC" : ""}${order.replace(/^-/, "")}`
  const conditions = [query, ordered].filter(Boolean).join("^")

  const params: any = { sysparm_limit: limit, sysparm_offset: offset }
  if (conditions) params.sysparm_query = conditions
  // ALWAYS include sys_id - it's essential for follow-up operations
  if (fields.length > 0) params.sysparm_fields = (fields.includes("sys_id") ? fields : ["sys_id", ...fields]).join(",")
  if (display) params.sysparm_display_value = "true"

  return { table, query, fields, limit, offset, params }
}

/** A non-negative whole number, or the default. Anything else is not a count. */
function numeric(raw: unknown, fallback: number): number {
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : Number.NaN
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/**
 * How many records the query really matches, from `x-total-count`. Undefined
 * rather than a number when the instance did not send the header, so the
 * caller sees no total at all instead of a made-up one: this field used to
 * read `"100+"` whenever the page filled, a string that is not the count, not
 * a bound anyone verified, and not distinguishable from a real answer.
 */
export function readTotal(headers: Record<string, unknown> | undefined): number | undefined {
  const total = headers?.["x-total-count"] ?? headers?.["X-Total-Count"]
  return typeof total === "string" && /^\d+$/.test(total) ? Number(total) : undefined
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const truncate_output = args.truncate_output ?? true

  try {
    const client = await getAuthenticatedClient(context)
    const plan = buildQueryParams(args)

    // Execute query
    const response = await client.get(`/api/now/table/${plan.table}`, { params: plan.params })

    const rawRecords = response.data.result
    const records = truncateRecords(rawRecords, truncate_output)

    // Build a human-readable summary with record preview
    const summaryLines: string[] = []
    summaryLines.push(`Found ${records.length} record(s) in ${plan.table}`)

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

    if (records.length === plan.limit) {
      summaryLines.push("")
      summaryLines.push(`Note: Results may be limited. Use offset parameter to paginate.`)
    }

    const total = readTotal(response.headers)

    return createSuccessResult(
      {
        records,
        count: records.length,
        ...(total === undefined ? {} : { total }),
        has_more: total === undefined ? records.length === plan.limit : plan.offset + records.length < total,
        truncated: truncate_output,
      },
      { table: plan.table, query: plan.query, limit: plan.limit, offset: plan.offset },
      summaryLines.join("\n"),
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.1.0"
export const author = "Serac SDK Migration"
