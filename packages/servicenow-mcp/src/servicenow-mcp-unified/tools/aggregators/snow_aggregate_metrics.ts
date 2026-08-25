/**
 * snow_aggregate_metrics — COUNT / SUM / AVG / MIN / MAX over a table through
 * the Aggregate API, GET /api/now/stats/{table}.
 *
 * This tool used to answer a different question than the one it was asked. It
 * sent `sysparm_query: ""` on every call, so any filter the caller had in mind
 * was silently dropped and COUNT came back for the whole table — a real,
 * plausible number for the wrong question. And the only aggregate parameter it
 * ever sent was sysparm_count, so SUM/AVG/MIN/MAX asked the API to aggregate
 * nothing, got an empty stats object back, and the wrapper still reported
 * `aggregated: true`. The `field` argument was destructured and never used.
 *
 * Parameter names, the `aggregate^field^operator^value` syntax of
 * sysparm_having, and the stats / groupby_fields response shape all come from
 * the Aggregate API reference:
 * https://www.servicenow.com/docs/bundle/zurich-api-reference/page/integrate/inbound-rest/concept/c_AggregateAPI.html
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

const AGGREGATIONS = ["COUNT", "SUM", "AVG", "MIN", "MAX"]

/**
 * The four documented field-list parameters. COUNT has no field list — it is
 * sysparm_count, which this tool sends on every request so each row also
 * carries how many records it covers.
 */
const FIELD_PARAM: Record<string, string> = {
  SUM: "sysparm_sum_fields",
  AVG: "sysparm_avg_fields",
  MIN: "sysparm_min_fields",
  MAX: "sysparm_max_fields",
}

export const toolDefinition: MCPToolDefinition = {
  name: "snow_aggregate_metrics",
  description:
    "Count, average, sum, min or max over a table, grouped by a field and filtered by an encoded query. Uses the Aggregate API (/api/now/stats), so it returns the rolled-up numbers per group, never the records themselves.",
  // Metadata for tool discovery (not sent to LLM)
  category: "reporting",
  subcategory: "analytics",
  use_cases: ["aggregation", "count", "group by", "metrics", "reporting"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - a single GET against /api/now/stats, changes nothing
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table to aggregate over (e.g. incident)" },
      aggregation: {
        type: "string",
        enum: ["COUNT", "SUM", "AVG", "MIN", "MAX"],
        default: "COUNT",
        description: "Which aggregate to compute. Everything except COUNT needs `field`.",
      },
      field: {
        type: "string",
        description:
          "Field to aggregate, required for SUM/AVG/MIN/MAX and ignored for COUNT. Must hold a number (e.g. reassignment_count); for elapsed time use the numeric seconds fields such as business_stc rather than the duration fields. Comma-separate to aggregate several fields at once.",
      },
      query: {
        type: "string",
        description:
          "Encoded query filtering which records are aggregated (e.g. active=true^priority=1). Omit to cover the whole table.",
      },
      group_by: {
        type: "string",
        description:
          "Field to group by, comma-separated for several (e.g. assignment_group). One result row per distinct combination.",
      },
      having: {
        type: "string",
        description:
          "Filter on the aggregate itself, syntax aggregate^field^operator^value (e.g. count^priority^>^3). Only meaningful together with group_by.",
      },
      order_by: {
        type: "string",
        description:
          "Order the rows by a field or by an aggregate. The documented forms are a field (state), an aggregate over a field (AVG^state) and COUNT; append ^DESC for descending (state^DESC). Only upper-case aggregate names are documented.",
      },
      display_value: {
        type: "string",
        enum: ["true", "false", "all"],
        default: "false",
        description:
          "Return display values. Set true when grouping by a reference or choice field, otherwise the groups come back as sys_ids and numeric choice values. `all` asks the API for both values and is passed through, but the row labels only change if the instance sends a display value alongside the raw one.",
      },
      max_groups: {
        type: "number",
        default: 100,
        description:
          "Cap on rows returned. Rows past it are dropped and the result says how many; the instance's own ordering decides which survive, so pair this with order_by. Must be a row count — anything else falls back to 100.",
      },
    },
    required: ["table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  return aggregate(args, context).catch((error: any) => {
    // The Aggregate API answers an unknown field or a malformed sysparm_having
    // with a 400 whose body names the problem; the axios message is only the
    // status code, which is not enough to fix the call.
    const snow = error?.response?.data?.error
    return createErrorResult(
      snow?.message ? [snow.message, snow.detail].filter(Boolean).join(" — ") : (error?.message ?? String(error)),
      // A rejected call is nearly always about the parameters, so carry the
      // same request detail the success path carries. Arguments refused before
      // the request went out have none, and get an empty metadata object.
      //
      // http_status rides along beside it because 403, 401 and 400 need three
      // different responses — ask for a role, re-authenticate, fix the query —
      // and the only other place that distinction survives is inside the
      // prose. A caller should not have to regex an error message to find out
      // which of the three happened; a call refused before it went out has no
      // status, and the field is absent rather than guessed at.
      {
        ...(error?.snow_request ?? {}),
        ...(typeof error?.response?.status === "number" ? { http_status: error.response.status } : {}),
      },
    )
  })
}

async function aggregate(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const table = String(args.table ?? "").trim()
  if (!table) return createErrorResult("table is required")

  const plan = buildStatsParams(args)
  const maxGroups = resolveMaxGroups(args.max_groups ?? args.maxGroups)
  const endpoint = `/api/now/stats/${encodeURIComponent(table)}`
  const client = await getAuthenticatedClient(context)
  const response = await client.get(endpoint, { params: plan.params }).catch((error: unknown) => {
    // Not `request`: axios already puts the underlying HTTP request there.
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      snow_request: { endpoint, params: plan.params },
    })
  })

  const all = readStats(response.data?.result, plan.aggregation, plan.fields)
  const rows = all.slice(0, maxGroups)
  const label = plan.aggregation === "COUNT" ? "COUNT" : `${plan.aggregation}(${plan.fields.join(",")})`

  // One aggregate over one field either came back or it did not. Say which,
  // instead of returning a success that reads like an answer of zero.
  const warning =
    plan.aggregation !== "COUNT" &&
    plan.fields.length === 1 &&
    rows.length > 0 &&
    rows.every((row) => row.value === undefined)
      ? `The instance answered but carried no ${label} value, so nothing was aggregated. Check that ${plan.fields[0]} exists on ${table} and holds a number.`
      : undefined

  return createSuccessResult(
    {
      table,
      aggregation: plan.aggregation,
      // COUNT takes no field list, so do not echo one back as if it had been used.
      field: plan.aggregation === "COUNT" ? undefined : plan.fields.join(","),
      query: plan.query || undefined,
      group_by: plan.group_by || undefined,
      value: plan.group_by ? undefined : rows[0]?.value,
      rows,
      total_rows: all.length,
      truncated: all.length > rows.length,
      warning,
    },
    { endpoint, params: plan.params },
    summarize(label, table, plan, rows, all.length, maxGroups),
  )
}

/**
 * Translate the tool's arguments into Aggregate API query parameters.
 *
 * Exported because which sysparm_* key the field lands under, and whether the
 * caller's filter reaches sysparm_query at all, is the whole of what this tool
 * got wrong — and both are decidable without an instance.
 *
 * Throws on input the API cannot act on; `execute` turns that into an error
 * result rather than sending a request whose answer would be meaningless.
 */
export function buildStatsParams(args: any) {
  const aggregation = String(args.aggregation ?? "COUNT")
    .trim()
    .toUpperCase()
  if (!AGGREGATIONS.includes(aggregation))
    throw new Error(`aggregation must be one of ${AGGREGATIONS.join(", ")} — received "${args.aggregation}"`)

  const fields = String(args.field ?? args.fields ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  if (aggregation !== "COUNT" && fields.length === 0)
    throw new Error(
      `${aggregation} needs a field to aggregate: pass field (e.g. reassignment_count), or use aggregation COUNT to count records`,
    )

  const query = expression(args.query ?? args.filter, "query", "an encoded query string, e.g. active=true^priority=1")
  const having = expression(args.having, "having", "aggregate^field^operator^value, e.g. count^priority^>^3")
  // group_by and order_by stay lenient: both are documented as comma-separated
  // lists, so an array of field names stringifies to exactly the right value,
  // and neither can change which records are counted — a mangled one is either
  // rejected by the instance or ignored.
  const group_by = String(args.group_by ?? args.groupBy ?? "").trim()
  const order_by = String(args.order_by ?? args.orderBy ?? "").trim()
  // sysparm_display_value takes true/false/all. A caller sending the boolean
  // true means "true"; anything else keeps the API default of database values.
  const display = args.display_value ?? args.displayValue

  const params: Record<string, string> = { sysparm_count: "true" }
  if (query) params.sysparm_query = query
  if (aggregation !== "COUNT") params[FIELD_PARAM[aggregation]] = fields.join(",")
  if (group_by) params.sysparm_group_by = group_by
  if (having) params.sysparm_having = having
  if (order_by) params.sysparm_order_by = order_by
  if (display === true || display === "true") params.sysparm_display_value = "true"
  if (display === "all") params.sysparm_display_value = "all"

  return { aggregation, fields, query, group_by, params }
}

/**
 * The two parameters that decide which records are counted. Both reach the
 * instance verbatim, so a non-string would arrive as "[object Object]", and an
 * encoded query the instance cannot parse is the case where the condition may
 * be dropped and the whole table aggregated instead — a confident number for a
 * filter that was never applied. Refuse the value rather than send it.
 */
function expression(value: unknown, name: string, shape: string) {
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") throw new Error(`${name} must be ${shape}`)
  return value.trim()
}

/**
 * How many rows to keep, exported for the same reason as the helpers around it:
 * a cap that quietly becomes NaN slices the result to nothing, and `summarize`
 * would then report that the instance returned no value — a false statement
 * about what the instance answered. Anything that is not a usable row count
 * (`"all"`, `""`, an object, a negative number) falls back to the schema's
 * default of 100, and the summary names the cap it actually applied.
 */
export function resolveMaxGroups(raw: unknown) {
  const parsed = Math.floor(Number(raw))
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 100
}

/**
 * Normalise the Aggregate API payload into one row per group.
 *
 * Grouped requests answer with an array of `{ stats, groupby_fields }`; an
 * ungrouped request answers with a single object, so both are flattened to a
 * list. Every documented aggregate but count nests one level deeper —
 * `stats.avg.<field>` — and a value the instance did not return stays
 * undefined rather than becoming 0, because "no aggregate came back" and "the
 * aggregate is zero" are opposite answers for whoever asked.
 *
 * Group labels prefer a display value when one arrives. The documented sample
 * response carries only `field` and `value`, so under sysparm_display_value=all
 * this is a fallback that costs nothing rather than a shape being relied on.
 */
export function readStats(result: unknown, aggregation: string, fields: string[]) {
  const entries: StatsEntry[] = Array.isArray(result) ? result : result ? [result as StatsEntry] : []
  return entries.map((entry) => {
    const stats: Stats = entry?.stats ?? {}
    const nested = stats[aggregation.toLowerCase()]
    return {
      group: Array.isArray(entry?.groupby_fields)
        ? Object.fromEntries(
            entry.groupby_fields.map((pair) => [pair?.field ?? "", pair?.display_value ?? pair?.value ?? ""]),
          )
        : undefined,
      count: stats.count,
      value:
        aggregation === "COUNT"
          ? stats.count
          : fields.length === 1 && nested && typeof nested === "object"
            ? nested[fields[0]]
            : undefined,
      stats,
    }
  })
}

/** COUNT sits directly on `stats`; every other aggregate nests one level, `stats.avg.<field>`. */
type Stats = { count?: string | number } & Record<string, string | number | Record<string, string | number> | undefined>

type StatsEntry = {
  stats?: Stats
  groupby_fields?: { field?: string; value?: string; display_value?: string }[]
}

function summarize(
  label: string,
  table: string,
  plan: ReturnType<typeof buildStatsParams>,
  rows: ReturnType<typeof readStats>,
  total: number,
  maxGroups: number,
) {
  const header = `${label} over ${table}${plan.query ? ` where ${plan.query}` : ""}${plan.group_by ? ` grouped by ${plan.group_by}` : ""}`
  if (total === 0) return `${header}: no records matched`
  if (!plan.group_by) return `${header} = ${rows[0]?.value ?? "(no value returned)"}`

  const preview = rows
    .slice(0, 10)
    .map((row) => `  ${Object.values(row.group ?? {}).join(" / ") || "(empty)"}: ${row.value ?? "(none)"}`)
  return [
    `${header}: ${total} row(s)`,
    ...preview,
    ...(rows.length > preview.length ? [`  ... and ${rows.length - preview.length} more in the result`] : []),
    ...(total > rows.length
      ? [
          `  ${total - rows.length} further row(s) dropped by max_groups=${maxGroups}; the instance's own ordering decided which were kept`,
        ]
      : []),
  ].join("\n")
}

export const version = "1.2.0"
export const author = "Serac SDK Migration"
