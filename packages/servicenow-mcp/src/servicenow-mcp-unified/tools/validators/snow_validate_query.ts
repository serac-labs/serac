/**
 * snow_validate_query - check an encoded query against the table's real schema
 *
 * ServiceNow does not reject a query that names a field the table does not
 * have. From the Table API reference for sysparm_query: "By default, if part of
 * a query is invalid, such as an invalid field name, the instance ignores the
 * invalid part."
 * https://www.servicenow.com/docs/bundle/zurich-api-reference/page/integrate/inbound-rest/concept/c_TableAPI.html
 *
 * So `active=true^assigment_group=abc` does not fail — it silently becomes
 * `active=true` and selects every active record. A caller that hands that query
 * to snow_bulk_update or snow_data_export then acts on a record set far wider
 * than the one it described. (The `glide.invalid_query.returns_no_rows`
 * property flips the behaviour to "return nothing" instead; this tool reports
 * which of the two the instance actually did rather than assuming either.)
 *
 * Everything here is read-only: sys_db_object, sys_dictionary, and — only when
 * count_matches is on — the caller's own query with sysparm_limit=1.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient, type ExtendedAxiosInstance } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_validate_query",
  description:
    "Check every field named in an encoded query against the table's sys_dictionary, walking the sys_db_object.super_class chain so inherited fields (incident.priority lives on task) resolve. ServiceNow does not error on a misspelled field in sysparm_query — by default it drops that condition and returns a WIDER result set — so run this before snow_bulk_update, snow_record_manage or snow_data_export act on the matched records. Returns one entry per clause marked known / unknown / unchecked (dot-walks, ^JOIN and RLQUERY blocks, ORDERBY, full-text search and task variables are reported as unchecked, never as errors), spelling suggestions for unknown fields, and how many records the query really matches.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "validation",
  use_cases: ["query-validation", "encoded-query", "bulk-update-safety", "schema"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - reads sys_db_object / sys_dictionary and optionally
  // runs the caller's own query with sysparm_limit=1. Changes nothing.
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Table the query will run against (e.g. incident, cmdb_ci_server)",
      },
      query: {
        type: "string",
        description:
          "Encoded query to check, e.g. active=true^priority=1. An empty string is accepted and reported as 'matches every record'.",
      },
      count_matches: {
        type: "boolean",
        description:
          "Also run the query read-only (sysparm_limit=1) and report how many records it matches, taken from the X-Total-Count response header. Default true.",
        default: true,
      },
    },
    required: ["table", "query"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  return validateQuery(args, context).catch((error: any) => createErrorResult(error?.message ?? String(error)))
}

async function validateQuery(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const table = String(args.table ?? "").trim()
  if (!table) return createErrorResult("table is required")
  const query = String(args.query ?? "").trim()
  const countMatches = (args.count_matches ?? args.countMatches ?? true) !== false

  const client = await getAuthenticatedClient(context)
  const walk = await tableChain(client, table)
  const parsed = parseQuery(query)

  // Only the fields this tool claims to check: plain columns, plus the first
  // segment of every dot-walk so the reader learns whether the entry point
  // itself is real.
  const candidates = [
    ...new Set(parsed.flatMap((clause) => [clause.root, clause.unchecked ? undefined : clause.field]).filter(isName)),
  ]
  const dictionary =
    candidates.length > 0 && walk.chain.length > 0 ? await readDictionary(client, walk.chain, candidates) : []
  const defined = new Map(
    candidates.flatMap((field) => {
      // A field redefined on a child table wins over the parent's row, so take
      // the match nearest the queried table.
      const row = dictionary
        .filter((entry: any) => entry.element === field)
        .sort((a: any, b: any) => walk.chain.indexOf(a.name) - walk.chain.indexOf(b.name))[0]
      return row ? [[field, row] as const] : []
    }),
  )

  const missing = parsed.filter((clause) => !clause.unchecked && clause.field && !defined.has(clause.field))
  // Fetched for the spelling suggestions, but it doubles as the honesty guard
  // below: a table with no readable dictionary rows at all cannot be the basis
  // for calling anything unknown.
  const columns = missing.length > 0 && walk.chain.length > 0 ? await readColumns(client, walk.chain) : []
  const unavailable =
    walk.chain.length === 0
      ? `${table} has no sys_db_object record, so no schema could be loaded — check the table name`
      : !walk.complete
        ? `the super_class chain above ${walk.chain[walk.chain.length - 1]} could not be resolved, so a field inherited from higher up cannot be told apart from a typo`
        : // A truncated read is the one remaining way to produce a false
          // "unknown": the row that would have resolved the field exists and was
          // simply not returned.
          dictionary.length >= DICTIONARY_LIMIT
          ? `the sys_dictionary read for ${walk.chain.join(" → ")} came back at its ${DICTIONARY_LIMIT}-row limit, so a field that does exist may not be among the rows this tool saw`
          : missing.length > 0 && columns.length === 0
            ? `no sys_dictionary rows are readable for ${walk.chain.join(" → ")} — a database view, or this account cannot read the dictionary`
            : undefined

  const clauses: {
    prefix: string
    clause: string
    field?: string
    operator?: string
    status: "known" | "unknown" | "unchecked"
    reason?: string
    defined_on?: string
    type?: string
    references?: string
    dictionary_active?: boolean
    did_you_mean?: string[]
  }[] = parsed.map((clause) => {
    const base = { prefix: clause.prefix, clause: clause.clause, field: clause.field, operator: clause.operator }
    if (clause.unchecked) return { ...base, status: "unchecked" as const, reason: reasonFor(clause, defined) }
    const row = defined.get(clause.field!)
    if (row)
      return {
        ...base,
        status: "known" as const,
        defined_on: row.name,
        type: typeOf(row),
        references: referenceOf(row),
        ...(row.active === "false" ? { dictionary_active: false } : {}),
      }
    if (unavailable) return { ...base, status: "unchecked" as const, reason: unavailable }
    const closest = suggest(clause.field!, columns)
    return { ...base, status: "unknown" as const, ...(closest.length > 0 ? { did_you_mean: closest } : {}) }
  })

  const unknown = clauses.filter((clause) => clause.status === "unknown")
  const matches = countMatches ? await countRecords(client, table, query) : null
  // Rebuilding the query without the unresolved clauses is what the instance is
  // documented to do by itself. Running both tells us which behaviour this
  // instance is configured for instead of assuming the default.
  const withoutUnknown =
    unknown.length === 0
      ? undefined
      : clauses
          .filter((clause) => clause.status !== "unknown")
          .map((clause) => clause.prefix + clause.clause)
          .join("")
          .replace(/^\^(OR|NQ)?/, "")
  const matchesWithoutUnknown =
    countMatches && withoutUnknown !== undefined ? await countRecords(client, table, withoutUnknown) : null

  const contradicted = countsContradictUnknown(matches, matchesWithoutUnknown)
  // Both of the sentences below describe a count, not a setting. Equal counts
  // are also what a real clause that excludes nothing produces, and a zero is
  // also what a real clause nothing matches produces, so neither may be stated
  // as a fact about how the instance is configured.
  const observed =
    matches === null || matchesWithoutUnknown === null
      ? null
      : contradicted
        ? `The unresolved clause(s) ${matches < matchesWithoutUnknown ? `narrowed the result set by ${matchesWithoutUnknown - matches}` : `widened the result set by ${matches - matchesWithoutUnknown}`} record(s): ${matches} as written, ${matchesWithoutUnknown} without them. An invalid clause cannot do that — ignored it leaves both counts equal, and under glide.invalid_query.returns_no_rows the query as written matches none — so at least one of the fields this tool could not resolve is real and it did not see it. Check whether this account can read every sys_dictionary row for ${walk.chain.join(" → ")}. (Records written to ${table} between the two counts would look the same way.)`
        : matches === matchesWithoutUnknown && matches > 1
          ? `With and without the unresolved clause(s) the query matches the same ${matches} records — consistent with the instance ignoring them, if they are indeed invalid, and equally with their being real clauses that exclude nothing.`
          : matches === 0 && matchesWithoutUnknown > 0
            ? `The query as written returned no rows; without the unresolved clause(s) it matches ${matchesWithoutUnknown} records. That is consistent with glide.invalid_query.returns_no_rows being switched on — or with one of the unresolved clauses being a real field that nothing on this table matches.`
            : null

  const counts = {
    known: clauses.filter((clause) => clause.status === "known").length,
    unknown: unknown.length,
    unchecked: clauses.filter((clause) => clause.status === "unchecked").length,
  }
  // Five outcomes, not two. "Nothing was checked" is its own answer: a ✓ on a
  // query where no field could be resolved is the lie this tool exists to stop,
  // and so is a ✓ on one where four of five clauses were skipped.
  const verdict = contradicted
    ? "unresolved-fields-contradicted"
    : counts.unknown > 0
      ? "unresolved-fields"
      : counts.known === 0
        ? "nothing-was-checked"
        : counts.unchecked > 0
          ? "some-clauses-unchecked"
          : "all-fields-resolved"
  const warnings = [
    query === "" ? `The query is empty, which selects every record in ${table}.` : undefined,
    // Worth saying when it cost the reader an answer — either nothing could be
    // loaded at all, or a clause landed in "unchecked" because of it.
    unavailable && (walk.chain.length === 0 || missing.length > 0) ? `${unavailable}.` : undefined,
    // Withheld once the counts show these clauses moving the result set: they
    // are being applied, whatever this tool made of the field names.
    unknown.length > 0 && !contradicted
      ? "ServiceNow does not raise an error for these clauses. Its Table API reference states that by default the instance ignores the invalid part of a query, so they do not narrow the result set — they widen it."
      : undefined,
    contradicted
      ? "Do not treat the unresolved field(s) as typos on this evidence: removing them changed how many records match, which is what a clause the instance is applying does."
      : undefined,
    query.includes("javascript:")
      ? "One or more values are javascript: expressions. This tool checks field names only, it does not evaluate them — and a ^ inside such a value would split the clause list wrongly."
      : undefined,
  ].filter(isName)

  return createSuccessResult(
    {
      table,
      hierarchy: walk.chain,
      query,
      verdict,
      counts,
      clauses,
      unknown_fields: unknown.map((clause) => clause.field),
      matches,
      matches_without_unresolved_clauses: matchesWithoutUnknown,
      query_without_unresolved_clauses: withoutUnknown,
      observed_behaviour: observed,
      warnings,
    },
    {
      table,
      hierarchy_depth: walk.chain.length,
      count_source: !countMatches
        ? "not requested"
        : matches === null
          ? "unavailable — the count query returned no X-Total-Count header"
          : "X-Total-Count header",
    },
    [
      `${
        {
          "unresolved-fields-contradicted": "!",
          "unresolved-fields": "✗",
          "some-clauses-unchecked": "~",
          "all-fields-resolved": "✓",
          "nothing-was-checked": "?",
        }[verdict]
      } ${table}: ${counts.known} field(s) resolved, ${counts.unknown} unresolved, ${counts.unchecked} not checked`,
      walk.chain.length > 1 ? `  hierarchy: ${walk.chain.join(" → ")}` : undefined,
      // The suggestions are held back once the counts contradict the verdict —
      // offering a spelling for a field that just filtered records is the
      // wrong-way-round advice this tool must not give.
      ...unknown.map(
        (clause) =>
          `  unresolved: ${clause.field}${!contradicted && clause.did_you_mean?.length ? ` — did you mean ${clause.did_you_mean.join(", ")}?` : ""}`,
      ),
      matches === null ? undefined : `  matches ${matches} record(s) as written`,
      observed ?? undefined,
      ...warnings.map((warning) => `  ! ${warning}`),
    ]
      .filter(isName)
      .join("\n"),
  )
}

/**
 * Whether the two counts rule out this tool's own "unknown" verdict. Neither
 * documented behaviour for an invalid clause can move the count: ignored, both
 * queries return the same rows; under glide.invalid_query.returns_no_rows the
 * query as written returns none. So a non-zero count that differs from the count
 * without those clauses means at least one of them really filters, and the tool
 * simply could not see the field. That evidence outranks the field lookup —
 * calling a valid clause invalid is the one failure worse than not checking.
 *
 * Exported for the tests: it is a pure function of two numbers, and getting it
 * wrong is invisible from the tool's output shape.
 */
export function countsContradictUnknown(matches: number | null, matchesWithoutUnknown: number | null) {
  return matches !== null && matchesWithoutUnknown !== null && matches > 0 && matches !== matchesWithoutUnknown
}

/**
 * Segments that are not field conditions. Longest first where one is a prefix
 * of another (ORDERBYDESC before ORDERBY), and all uppercase — dictionary
 * column names are lower case, so none of these can shadow a real field.
 */
const STRUCTURAL: ReadonlyArray<readonly [string, string]> = [
  ["ORDERBYDESC", "sort directive, not a filter condition"],
  ["ORDERBY", "sort directive, not a filter condition"],
  ["GROUPBY", "grouping directive, not a filter condition"],
  ["GOTO", "list 'go to' directive"],
  ["ENDJOIN", "end of a ^JOIN block"],
  ["JOIN", "^JOIN block — the conditions inside it apply to the joined table"],
  ["ENDRLQUERY", "end of a related-list query"],
  ["RLQUERY", "related-list query — the conditions inside it apply to the related table"],
  ["123TEXTQUERY321", "full-text search, not a field condition"],
  ["EQ", "clause terminator"],
  ["NQ", "new-query separator"],
]

/**
 * Encoded-query operators, as ServiceNow's "Available operators for filters and
 * queries" reference lists them.
 * https://www.servicenow.com/docs/bundle/zurich-platform-user-interface/page/use/common-ui-elements/reference/r_OpAvailableFiltersQueries.html
 */
const OPERATORS = [
  "IN_HIERARCHY_DYNAMIC",
  "GT_OR_EQUALS_FIELD",
  "LT_OR_EQUALS_FIELD",
  "IN_HIERARCHY",
  "DOESNOTHAVE",
  "EMPTYSTRING",
  "INSTANCEOF",
  "ISNOTEMPTY",
  "CHANGESFROM",
  "VALCHANGES",
  "CHANGESTO",
  "STARTSWITH",
  "RELATIVEGT",
  "RELATIVELT",
  "RELATIVEGE",
  "RELATIVELE",
  "EXCLUDING",
  "GT_FIELD",
  "LT_FIELD",
  "MORETHAN",
  "LESSTHAN",
  "DATEPART",
  "ANYTHING",
  "ENDSWITH",
  "ISEMPTY",
  "BETWEEN",
  "NOT LIKE",
  "NSAMEAS",
  "DYNAMIC",
  "SAMEAS",
  "NOT IN",
  "NOTON",
  "LIKE",
  "ON",
  "IN",
  "!=",
  "<=",
  ">=",
  "=",
  "<",
  ">",
]

/**
 * Split an encoded query into clauses and say, for each, whether its field can
 * be looked up at all. Exported for the tests: every rule below is a pure
 * function of the string, and both of the parsing bugs it exists to avoid are
 * invisible from the tool's output shape.
 */
export function parseQuery(query: string) {
  // `^OR` must not eat `^ORDERBY`. Splitting on a bare /\^OR/ leaves the clause
  // "DERBYnumber", which then reads as a misspelled field — a false positive,
  // which is the one failure this tool cannot afford.
  const parts = query.replace(/\^EQ$/, "").split(/(\^OR(?!DERBY)|\^NQ|\^)/)
  const segments = parts.flatMap((part, i) =>
    i % 2 === 1 || part.length === 0 ? [] : [{ prefix: i === 0 ? "" : parts[i - 1], clause: part }],
  )
  // A ^JOIN or RLQUERY block re-points everything inside it at another table.
  // An unterminated block suspends checking to the end of the query on purpose:
  // over-reporting "unchecked" is safe, calling a valid clause invalid is not.
  const inBlock = segments.reduce<boolean[]>(
    (acc, segment) => [
      ...acc,
      /^(ENDJOIN|ENDRLQUERY)/.test(segment.clause)
        ? false
        : /^(JOIN|RLQUERY)/.test(segment.clause)
          ? true
          : (acc[acc.length - 1] ?? false),
    ],
    [],
  )
  return segments.map((segment, i) => ({ ...segment, ...describe(segment.clause, inBlock[i]) }))
}

// The shape is spelled out because every branch below returns a different
// subset of it, and the caller reads `root` and `field` across all of them.
function describe(
  clause: string,
  inBlock: boolean,
): { field?: string; operator?: string; value?: string; root?: string; unchecked?: string } {
  // Structural first, so the segment that opens a block is named as the opener
  // rather than as something inside it.
  const structural = STRUCTURAL.find(([keyword]) => clause.startsWith(keyword))
  if (structural) return { unchecked: structural[1] }
  if (inBlock) return { unchecked: "inside a ^JOIN / RLQUERY block — the condition applies to another table" }

  // Take the operator that starts earliest, and the longest one at that
  // position. Taking the first hit from a longest-first list instead reads
  // "short_description=IN PROGRESS" as field "short_description=" operator "IN".
  const hit = OPERATORS.flatMap((op) => {
    const at = clause.indexOf(op)
    return at > 0 ? [{ op, at }] : []
  }).sort((a, b) => a.at - b.at || b.op.length - a.op.length)[0]
  if (!hit) return { unchecked: "no encoded-query operator found in this clause" }

  const field = clause.slice(0, hit.at)
  const rest = { field, operator: hit.op, value: clause.slice(hit.at + hit.op.length) }
  if (field === "sys_tags")
    return { ...rest, unchecked: "tag filter — this tool does not resolve sys_tags, so the clause is left unchecked" }
  if (field === "variables" || field.startsWith("variables."))
    return { ...rest, unchecked: "task variable — held in the variable tables, not in this table's dictionary" }
  if (field.includes("."))
    return {
      ...rest,
      root: field.split(".")[0],
      unchecked: "dot-walk — only the first segment is looked up, the fields beyond it live on other tables",
    }
  return rest
}

function reasonFor(clause: ReturnType<typeof parseQuery>[number], defined: Map<string, any>) {
  if (!clause.root) return clause.unchecked
  const row = defined.get(clause.root)
  if (row)
    return `${clause.unchecked}. First segment "${clause.root}" is a ${typeOf(row) ?? "field"} on ${row.name}${referenceOf(row) ? ` referencing ${referenceOf(row)}` : ""}.`
  // Deliberately not called a typo: variable prefixes and related-list syntax
  // are legitimate here and are not dictionary columns either.
  return `${clause.unchecked}. First segment "${clause.root}" is not a field on this table or its ancestors — worth re-reading, though some prefixes are legitimately not dictionary columns.`
}

/**
 * table → super_class → … to the root. Nothing is capped at three levels:
 * cmdb_ci_win_server → cmdb_ci_server → cmdb_ci_computer → cmdb_ci_hardware →
 * cmdb_ci is five, and stopping early reports every field on the root class as
 * unknown. `complete` is false when the walk stopped somewhere other than a
 * table with no parent, and the caller then declines to call anything unknown.
 */
async function tableChain(
  client: ExtendedAxiosInstance,
  table: string,
  seen: string[] = [],
): Promise<{ chain: string[]; complete: boolean }> {
  if (!table || seen.includes(table) || seen.length >= 20) return { chain: seen, complete: !table }
  const response = await client.get("/api/now/table/sys_db_object", {
    params: {
      sysparm_query: `name=${table}`,
      sysparm_fields: "name,super_class,super_class.name",
      sysparm_limit: 1,
    },
  })
  const row = response.data.result?.[0]
  if (!row) return { chain: seen, complete: false }
  const walked = row["super_class.name"]
  const parent = typeof walked === "string" && walked ? walked : await parentName(client, row.super_class)
  if (!parent && referenceValue(row.super_class)) return { chain: [...seen, table], complete: false }
  return tableChain(client, parent, [...seen, table])
}

// sysparm_fields normally returns the dot-walked super_class.name directly. If
// an instance answers with only the reference cell, resolve it by sys_id rather
// than truncating the chain.
async function parentName(client: ExtendedAxiosInstance, superClass: any) {
  const sysId = referenceValue(superClass)
  if (!sysId) return ""
  const response = await client
    .get(`/api/now/table/sys_db_object/${encodeURIComponent(sysId)}`, { params: { sysparm_fields: "name" } })
    .catch(() => undefined)
  const name = response?.data?.result?.name
  return typeof name === "string" ? name : ""
}

// One row per (table in the chain × field named in the query), so reaching the
// limit takes a query naming ~100 distinct fields against a five-deep chain. The
// caller checks for it anyway because a silently short read is the only path
// left to a field being called unknown when it is not.
const DICTIONARY_LIMIT = 500

async function readDictionary(client: ExtendedAxiosInstance, chain: string[], elements: string[]) {
  const response = await client.get("/api/now/table/sys_dictionary", {
    params: {
      sysparm_query: `nameIN${chain.join(",")}^elementIN${elements.join(",")}`,
      sysparm_fields: "name,element,internal_type,internal_type.name,reference,reference.name,active",
      sysparm_limit: DICTIONARY_LIMIT,
    },
  })
  return (response.data.result ?? []) as any[]
}

async function readColumns(client: ExtendedAxiosInstance, chain: string[]) {
  const response = await client.get("/api/now/table/sys_dictionary", {
    params: {
      sysparm_query: `nameIN${chain.join(",")}^elementISNOTEMPTY`,
      sysparm_fields: "element",
      sysparm_limit: 5000,
    },
  })
  const elements = ((response.data.result ?? []) as any[]).map((row) => String(row.element ?? "")).filter(isName)
  return [...new Set(elements)]
}

/**
 * How many records the query really matches. Null rather than 0 when the count
 * is unavailable — a query that could not be counted and a query that matches
 * nothing are opposite answers for a caller deciding whether to run an update.
 */
async function countRecords(client: ExtendedAxiosInstance, table: string, query: string) {
  const response = await client
    .get(`/api/now/table/${encodeURIComponent(table)}`, {
      params: { sysparm_query: query, sysparm_limit: 1, sysparm_fields: "sys_id" },
    })
    .catch(() => undefined)
  const total = response?.headers?.["x-total-count"]
  return typeof total === "string" && /^\d+$/.test(total) ? Number(total) : null
}

/**
 * Trigram overlap, used only to offer a spelling suggestion beside an unknown
 * field. It never decides a status.
 */
function suggest(field: string, columns: string[]) {
  return columns
    .map((column) => ({ column, score: overlap(field, column) }))
    .filter((scored) => scored.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((scored) => scored.column)
}

function overlap(a: string, b: string) {
  const left = trigrams(a)
  const right = trigrams(b)
  const shared = [...left].filter((gram) => right.has(gram)).length
  return shared / (left.size + right.size - shared)
}

function trigrams(value: string) {
  const padded = `  ${value} `
  return new Set(Array.from({ length: padded.length - 2 }, (_, i) => padded.slice(i, i + 3)))
}

function typeOf(row: any) {
  const walked = row["internal_type.name"]
  if (typeof walked === "string" && walked) return walked
  return typeof row.internal_type === "string" && row.internal_type ? row.internal_type : undefined
}

function referenceOf(row: any) {
  const walked = row["reference.name"]
  if (typeof walked === "string" && walked) return walked
  return typeof row.reference === "string" && row.reference ? row.reference : undefined
}

// Reference cells come back as { link, value } unless the instance flattens
// them to the sys_id string.
function referenceValue(cell: any) {
  const value = typeof cell === "string" ? cell : cell?.value
  return typeof value === "string" && value ? value : ""
}

function isName(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0
}

export const version = "1.0.0"
export const author = "Serac"
