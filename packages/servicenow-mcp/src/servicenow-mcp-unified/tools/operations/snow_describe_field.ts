/**
 * snow_describe_field - describe one field, resolved through the class hierarchy
 *
 * A sys_dictionary row lives on the table that *declares* the column, so
 * `name=incident^element=short_description` returns nothing: short_description
 * is declared on task. snow_discover_table_fields and snow_table_schema_discovery
 * both query sys_dictionary by table name alone, which is why they report an
 * incident schema with no number, state, priority or assigned_to, and neither
 * reads a choice list at all. This tool walks sys_db_object.super_class to the
 * root class first, then applies the sys_dictionary_override rows found on that
 * chain, then resolves the field's sys_choice list.
 *
 * Everything it returns comes from a Table API read of sys_db_object,
 * sys_dictionary, sys_dictionary_override and sys_choice. Where a value is a
 * computation rather than a column (the merged `effective` block, the selected
 * choice set) the inputs are returned alongside it so the caller can check the
 * work.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient, type ExtendedAxiosInstance } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

/**
 * Only a cycle guard, not a real ceiling. cmdb_ci_win_server -> cmdb_ci_server ->
 * cmdb_ci_computer -> cmdb_ci_hardware -> cmdb_ci is already five levels, so the
 * maxDepth = 3 used by snow_blast_radius_field_references drops exactly the
 * fields defined on cmdb_ci itself.
 */
const MAX_CHAIN_DEPTH = 20

/**
 * Columns copied out of the sys_dictionary row. Absent columns are dropped
 * rather than reported empty, so this list can stay generous without the
 * output claiming a column exists on an instance where it does not.
 *
 * A field's hint and help text are not here because they are not on
 * sys_dictionary at all — they live on sys_documentation, which is also where the
 * per-table, per-language field label lives. `column_label` below is the base
 * label and is not language-resolved, so it is not necessarily the label a user
 * sees on a translated instance.
 */
const DICTIONARY_KEYS = [
  "name",
  "element",
  "column_label",
  "internal_type",
  "reference",
  "max_length",
  "mandatory",
  "read_only",
  "active",
  "display",
  "default_value",
  "choice",
  "choice_table",
  "choice_field",
  "dependent",
  "dependent_on_field",
  "use_dependent_field",
  "attributes",
  "reference_qual",
  "calculation",
  "virtual",
  "unique",
  "comments",
  "sys_scope",
]

const CHOICE_KEYS = ["value", "label", "sequence", "inactive", "language", "dependent_value", "hint", "sys_id"]

export const toolDefinition: MCPToolDefinition = {
  name: "snow_describe_field",
  description: `Describe one field on one table, resolved through table inheritance. Walks sys_db_object.super_class to the root class, so fields declared on a parent are found (incident.short_description is declared on task, incident.state on task, cmdb_ci_win_server.name on cmdb_ci). Applies the sys_dictionary_override rows found anywhere on that chain, nearest table wins.

Returns: the declaring table, the full parent-class chain, the effective column_label / internal_type / max_length / mandatory / read_only / default_value / reference target / reference qualifier / attributes after overrides, the raw dictionary row and the override rows it merged, and the field's sys_choice values.

Choice handling: the nearest table on the chain that defines any sys_choice rows for the field supplies the list — a child's choices replace the parent's, they are not merged — and the count for every other table on the chain is reported too. Inactive choices are filtered out (opt in with include_inactive_choices), rows are matched on language, and each choice keeps its own dependent_value instead of being flattened. sys_dictionary.choice is returned as choice_mode with the instance's own label for it, so an empty choices array is distinguishable from a field that has no choice list.

Use this instead of snow_discover_table_fields or snow_table_schema_discovery when you need one field's real definition: those two query sys_dictionary by table name only and therefore miss every inherited field.`,
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "discovery",
  use_cases: ["schema", "field-definition", "choice-list", "discovery"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - reads sys_db_object, sys_dictionary, sys_dictionary_override, sys_choice
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Table the field is used on, e.g. 'incident'. The field may be declared on a parent table.",
      },
      field: {
        type: "string",
        description: "Column name (sys_dictionary element), e.g. 'state'. Not the column label.",
      },
      language: {
        type: "string",
        description: "Language code for choice labels. Choices with no language set are always included.",
        default: "en",
      },
      include_inactive_choices: {
        type: "boolean",
        description: "Include sys_choice rows marked inactive (default: false)",
        default: false,
      },
      max_choices: {
        type: "number",
        description: "Maximum sys_choice rows to read across the whole chain (default: 500)",
        default: 500,
        minimum: 1,
        maximum: 5000,
      },
    },
    required: ["table", "field"],
  },
}

export async function execute(args: Record<string, any>, context: ServiceNowContext): Promise<ToolResult> {
  // The sibling schema tools take `table_name`, and the blast-radius tools take
  // `table_name`/`field_name`, so models reach for those names here too. Accept
  // the synonyms rather than failing on one.
  const table: string | undefined = args.table ?? args.table_name
  const field: string | undefined = args.field ?? args.field_name ?? args.element
  const language: string = args.language ?? "en"
  const includeInactive: boolean = args.include_inactive_choices ?? false
  const maxChoices: number = args.max_choices ?? 500

  if (!table || !field) return createErrorResult("table and field are required")

  try {
    const client = await getAuthenticatedClient(context)

    const walk = await resolveTableChain(client, table)
    if (walk.chain.length === 0) {
      return createErrorResult(`Table not found in sys_db_object: ${table}`, { table, field })
    }

    const names = walk.chain.map((entry) => entry.name)
    const scope = `nameIN${names.join(",")}^element=${field}`

    // sys_dictionary_override and sys_choice are allowed to fail independently:
    // a locked-down instance can refuse them while the dictionary read succeeds,
    // and a partial answer with a note beats no answer at all.
    const [dictionaryResult, overrideResult, choiceResult] = await Promise.allSettled([
      client.get("/api/now/table/sys_dictionary", {
        params: { sysparm_query: scope, sysparm_display_value: "all", sysparm_limit: names.length },
      }),
      client.get("/api/now/table/sys_dictionary_override", {
        params: { sysparm_query: scope, sysparm_display_value: "all", sysparm_limit: names.length },
      }),
      client.get("/api/now/table/sys_choice", {
        params: { sysparm_query: scope, sysparm_limit: maxChoices },
      }),
    ])

    if (dictionaryResult.status === "rejected") {
      return createErrorResult(reasonOf(dictionaryResult.reason), { table, field, table_chain: names })
    }

    const dictionaryRows: Record<string, unknown>[] = dictionaryResult.value.data.result ?? []
    // Chain order is most-derived first, so the first hit is the nearest declaration.
    // `element` is re-checked client-side because ServiceNow drops query conditions it
    // considers invalid instead of erroring: a degraded query returns every field's
    // rows, and merging those into `effective` would be a confident wrong answer
    // rather than a visible failure.
    const definitions = names.flatMap((name) =>
      dictionaryRows.filter((row) => cell(row.name) === name && cell(row.element) === field),
    )
    const dictionary = definitions[0]

    if (!dictionary) {
      const suggestions = await client
        .get("/api/now/table/sys_dictionary", {
          params: {
            sysparm_query: `nameIN${names.join(",")}^elementLIKE${field}`,
            sysparm_fields: "name,element,column_label",
            sysparm_limit: 10,
          },
        })
        .then((response) => response.data.result ?? [])
        .catch(() => [])
      return createErrorResult(
        `Field '${field}' is not defined on ${table} or any of its parent classes (${names.join(" -> ")}). ` +
          `Note that a field defined only on a child table is not visible from ${table}.`,
        { table, field, table_chain: names, similar_fields: suggestions },
      )
    }

    const overrideRows: Record<string, unknown>[] =
      overrideResult.status === "fulfilled" ? (overrideResult.value.data.result ?? []) : []
    const overrides = names.flatMap((name) =>
      overrideRows
        .filter((row) => cell(row.name) === name && cell(row.element) === field)
        .map((row) => readOverride(name, row)),
    )

    const attributes = project(dictionary, DICTIONARY_KEYS)
    const merged = applyOverrides(attributes, overrides)

    const choiceRows: Record<string, unknown>[] =
      choiceResult.status === "fulfilled" ? (choiceResult.value.data.result ?? []) : []
    const choices = selectChoiceSet(
      names,
      choiceRows.filter((row) => cell(row.element) === field),
      { language, includeInactive },
    )

    const declaredOn = cell(dictionary.name)
    // Both columns are references that store a *name*, not a sys_id — a real row has
    // <internal_type display_value="Reference">reference</internal_type> and
    // <reference display_value="" name="sys_user">sys_user</reference>, against a
    // genuine sys_id reference like <sys_scope display_value="NeedIt">6ead...</sys_scope>
    // in the same row. So `value` is already what the caller needs, and display_value
    // is only a label — empty on `reference`, which is what makes a `value || display`
    // read of that column fall through to the raw cell object.
    const internalType = cell(dictionary.internal_type)
    const referenceTable = cell(dictionary.reference)

    const effective = compact({
      column_label: merged.column_label,
      internal_type: internalType,
      internal_type_label: label(dictionary.internal_type),
      reference_table: referenceTable,
      reference_label: label(dictionary.reference),
      max_length: merged.max_length,
      mandatory: merged.mandatory === "true",
      read_only: merged.read_only === "true",
      active: merged.active === "true",
      display: merged.display === "true",
      default_value: merged.default_value,
      reference_qual: merged.reference_qual,
      calculation: merged.calculation,
      attributes: merged.attributes,
      dependent: merged.dependent,
    })

    const notes = [
      overrideResult.status === "rejected"
        ? `sys_dictionary_override could not be read (${reasonOf(overrideResult.reason)}); the effective values are the base dictionary row only.`
        : undefined,
      choiceResult.status === "rejected"
        ? `sys_choice could not be read (${reasonOf(choiceResult.reason)}); no choice list is reported for this field.`
        : undefined,
      choiceRows.length >= maxChoices
        ? `sys_choice returned the full ${maxChoices}-row limit, so the list may be cut off. Raise max_choices.`
        : undefined,
      choices.counts_by_table.length > 1
        ? `${choices.source_table} defines its own choices for this field; the other tables on the chain (${choices.counts_by_table
            .slice(1)
            .map((entry) => `${entry.table}: ${entry.count}`)
            .join(
              ", ",
            )}) are reported for reference only. This tool treats the nearest table's choice list as replacing its parents' rather than merging them.`
        : undefined,
      overrides.some((entry) => entry.sets && entry.table !== table)
        ? `Dictionary overrides declared on ancestor tables (${overrides
            .filter((entry) => entry.sets && entry.table !== table)
            .map((entry) => entry.table)
            .join(
              ", ",
            )}) were merged into the effective values, nearest table last. Every entry in 'overrides' names the table it came from, so an override you consider irrelevant to ${table} can be discounted.`
        : undefined,
      overrides.some((entry) => entry.unpaired)
        ? `An override row flags ${overrides.flatMap((entry) => entry.unpaired ?? []).join(", ")} as overridden but carries no column holding the new value, so those attributes are reported unchanged from the base dictionary row. display is normally one of these: sys_dictionary_override has display_override without a 'display' column beside it.`
        : undefined,
      merged.choice_table || merged.choice_field
        ? `The dictionary row points the choice list elsewhere (choice_table='${merged.choice_table ?? ""}', choice_field='${merged.choice_field ?? ""}'). The choices below were read from the class hierarchy of ${table} and may not be the list this field renders.`
        : undefined,
      choices.skipped_for_language.length > 0
        ? `${choices.skipped_for_language.join(", ")} define sys_choice rows for this field but none in language '${language}' and none with no language set, so they were skipped — and each of them sits nearer ${table} than ${choices.source_table ?? "any table that did match"}. Re-run with the instance's own language before trusting the list below.`
        : undefined,
      walk.chain.length >= MAX_CHAIN_DEPTH
        ? `Parent-class walk stopped at ${MAX_CHAIN_DEPTH} tables; the chain may continue past ${names[names.length - 1]}.`
        : undefined,
    ].filter((note): note is string => typeof note === "string")

    const data = {
      table,
      field,
      declared_on: declaredOn,
      inherited: declaredOn !== table,
      table_chain: walk.chain,
      dictionary_sys_id: cell(dictionary.sys_id),
      effective,
      choice_mode:
        dictionary.choice === undefined
          ? undefined
          : { value: cell(dictionary.choice), label: label(dictionary.choice) },
      choices: choices.choices,
      choices_source_table: choices.source_table,
      choice_counts_by_table: choices.counts_by_table,
      choices_language: language,
      choices_skipped_for_language: choices.skipped_for_language,
      // Counted across every table on the chain, not just the one that supplied the
      // returned list — the name says so because the number is otherwise read as
      // "this many choices were dropped from `choices`".
      inactive_choices_excluded_on_chain: choices.inactive_excluded,
      overrides,
      dictionary: attributes,
      other_definitions: definitions.slice(1).map((row) => cell(row.name)),
      notes,
    }

    const summary = [
      `${table}.${field} — ${internalType || "unknown type"}` +
        (merged.max_length ? `(${merged.max_length})` : "") +
        (referenceTable ? ` -> ${referenceTable}` : ""),
      `  declared on ${declaredOn}${declaredOn === table ? "" : ` (inherited by ${table} via ${names.join(" -> ")})`}`,
      `  label: ${merged.column_label ?? "(none)"} | mandatory: ${effective.mandatory} | read only: ${effective.read_only}`,
      // Counted on `sets`, not on row count: most override rows carry all eight flags
      // and set none of them, and "3 overrides applied" for three inert rows is a
      // claim about work that did not happen.
      overrides.length > 0
        ? `  ${overrides.filter((entry) => entry.sets).length} of ${overrides.length} dictionary override row(s) changed a value (rows on ${overrides.map((entry) => entry.table).join(", ")})`
        : undefined,
      choices.choices.length > 0
        ? `  ${choices.choices.length} choice(s) from ${choices.source_table}: ${choices.choices
            .slice(0, 8)
            .map((choice) => `${choice.value}=${choice.label}`)
            .join(", ")}${choices.choices.length > 8 ? ", ..." : ""}`
        : `  no sys_choice rows on the chain (sys_dictionary.choice = ${cell(dictionary.choice) || "unset"})`,
      ...notes.map((note) => `  note: ${note}`),
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n")

    return createSuccessResult(data, { table, field, apiCalls: walk.calls + 3 }, summary)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

/**
 * Walk sys_db_object.super_class from `table` up to the root class.
 * Returns [table, parent, grandparent, ...]; empty if `table` has no
 * sys_db_object row at all, plus the number of GETs it took.
 *
 * Dot-walking inside sysparm_fields is undocumented — the Table API reference
 * says only that invalid fields are ignored — so `super_class.name` can in
 * principle come back absent rather than empty. That failure is silent and
 * expensive: the chain would stop at one table and the tool would answer
 * `inherited: false` for incident.short_description, the exact wrong answer it
 * exists to prevent. Plain `super_class` is requested alongside it as the
 * ground truth (it is a real sys_id reference), and the parent is resolved by
 * sys_id whenever the dotted column did not arrive.
 */
async function resolveTableChain(
  client: ExtendedAxiosInstance,
  table: string,
  chain: { name: string; label: string }[] = [],
  calls = 0,
): Promise<{ chain: { name: string; label: string }[]; calls: number }> {
  // A super_class cycle is corrupt data, not a hierarchy — stop rather than loop.
  if (chain.length >= MAX_CHAIN_DEPTH || chain.some((entry) => entry.name === table)) return { chain, calls }

  const response = await client.get("/api/now/table/sys_db_object", {
    params: {
      sysparm_query: `name=${table}`,
      sysparm_fields: "name,label,super_class,super_class.name",
      sysparm_limit: 1,
    },
  })
  const row = response.data.result?.[0]
  if (!row) return { chain, calls: calls + 1 }

  const next = [...chain, { name: table, label: cell(row.label) }]
  const dotted = cell(row["super_class.name"])
  const parentId = dotted ? "" : cell(row.super_class)
  const parent = dotted || (await resolveParentName(client, parentId))
  const spent = calls + (parentId ? 2 : 1)
  return parent ? resolveTableChain(client, parent, next, spent) : { chain: next, calls: spent }
}

/** Name of the sys_db_object row with this sys_id, or "" — never throws. */
async function resolveParentName(client: ExtendedAxiosInstance, sysId: string): Promise<string> {
  if (!sysId) return ""
  return client
    .get("/api/now/table/sys_db_object", {
      params: { sysparm_query: `sys_id=${sysId}`, sysparm_fields: "name", sysparm_limit: 1 },
    })
    .then((response) => cell(response.data.result?.[0]?.name))
    .catch(() => "")
}

/**
 * Read one sys_dictionary_override row into the set of attributes it actually
 * changes. Derived from the row's own `<attribute>_override` flags rather than a
 * hardcoded list, so an instance whose override columns differ from the ones
 * this file expects still produces a correct answer instead of a confident wrong
 * one. A flag set true with no matching column is reported in `unpaired` rather
 * than dropped silently.
 *
 * The flag columns are suffixed, not prefixed: a real row carries
 * mandatory_override, read_only_override, default_value_override,
 * reference_qual_override, attributes_override, calculation_override,
 * dependent_override and display_override. Every one of those pairs with a
 * same-named sys_dictionary_override column except display_override, which has no
 * `display` column beside it — so `unpaired: ["display"]` is expected output on a
 * row that sets it, not a sign of bad data.
 *
 * Exported for the test beside this file — the merge rule is the thing worth
 * pinning, and it cannot be exercised through `execute` without an instance.
 */
export function readOverride(table: string, row: Record<string, unknown>) {
  const flagged = Object.keys(row)
    .filter((key) => key.endsWith("_override") && cell(row[key]) === "true")
    .map((key) => key.slice(0, -"_override".length))

  return compact({
    table,
    base_table: cell(row.base_table),
    sys_id: cell(row.sys_id),
    sets: Object.fromEntries(
      flagged.filter((attribute) => row[attribute] !== undefined).map((attribute) => [attribute, cell(row[attribute])]),
    ) as Record<string, string>,
    unpaired: flagged.filter((attribute) => row[attribute] === undefined),
  })
}

/**
 * Merge dictionary overrides onto the base dictionary attributes. `overrides` is
 * in chain order (nearest table first), so it is applied in reverse: the
 * override closest to the queried table is the one that survives.
 *
 * Exported for the test beside this file.
 */
export function applyOverrides(
  attributes: Record<string, string>,
  overrides: { table?: string; sets?: Record<string, string> }[],
) {
  return [...overrides]
    .reverse()
    .reduce<
      Record<string, string>
    >((accumulator, override) => ({ ...accumulator, ...(override.sets ?? {}) }), attributes)
}

/**
 * Pick the choice list that actually applies to the queried table.
 *
 * A child table's sys_choice rows replace its parent's for that element, they do
 * not add to them — so the first table on the chain with any rows wins outright
 * and the rest are reported as counts only. Rows are filtered by language (rows
 * with no language set always count, since that is how choices created through
 * the API arrive) and by `inactive`, and each row keeps its own dependent_value
 * rather than being flattened into one list.
 *
 * The language filter can hand the win to the wrong table: on a non-English
 * instance a child whose rows exist only in `nl` drops out and the parent's list
 * is returned as if the child defined none. Those tables come back in
 * `skipped_for_language` so the caller sees it happened instead of trusting a
 * list the field cannot actually hold.
 *
 * Exported for the test beside this file.
 */
export function selectChoiceSet(
  chain: string[],
  rows: Record<string, unknown>[],
  options: { language: string; includeInactive: boolean },
) {
  const inLanguage = rows.filter((row) => {
    const value = cell(row.language)
    return value === "" || value === options.language
  })
  const active = options.includeInactive ? inLanguage : inLanguage.filter((row) => cell(row.inactive) !== "true")

  const grouped = chain
    .map((table) => ({ table, rows: active.filter((row) => cell(row.name) === table) }))
    .filter((group) => group.rows.length > 0)

  const winner = grouped[0]
  const choices = (winner?.rows ?? [])
    .slice()
    .sort((left, right) => sequenceOf(left) - sequenceOf(right))
    .map((row) => project(row, CHOICE_KEYS))

  return {
    source_table: winner?.table,
    choices,
    counts_by_table: grouped.map((group) => ({ table: group.table, count: group.rows.length })),
    inactive_excluded: inLanguage.length - active.length,
    // Only the tables nearer than the winner matter: those are the ones whose list
    // would have been returned had the language matched.
    skipped_for_language: chain
      .slice(0, winner ? chain.indexOf(winner.table) : chain.length)
      .filter((table) => rows.some((row) => cell(row.name) === table))
      .filter((table) => !inLanguage.some((row) => cell(row.name) === table)),
  }
}

function sequenceOf(row: Record<string, unknown>): number {
  const parsed = Number(cell(row.sequence))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Read a Table API cell. With sysparm_display_value=all every column arrives as
 * `{ display_value, value }`; without it, as a plain string.
 */
function cell(raw: unknown): string {
  if (raw === null || raw === undefined) return ""
  if (typeof raw === "object") {
    const value = (raw as Record<string, unknown>).value
    return typeof value === "string" ? value : ""
  }
  return String(raw)
}

/** The instance's own display value for a cell, or "" when it did not send one. */
function label(raw: unknown): string {
  if (!raw || typeof raw !== "object") return ""
  const display = (raw as Record<string, unknown>).display_value
  return typeof display === "string" ? display : ""
}

/** Copy the requested columns that the row actually has. Absent stays absent. */
function project(row: Record<string, unknown>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, cell(row[key])]))
}

function compact<T extends Record<string, unknown>>(object: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => {
      if (value === undefined || value === "") return false
      if (Array.isArray(value)) return value.length > 0
      if (value && typeof value === "object") return Object.keys(value).length > 0
      return true
    }),
  ) as Partial<T>
}

function reasonOf(reason: any): string {
  return reason?.message ?? String(reason)
}

export const version = "1.0.0"
export const author = "Serac"
