/**
 * snow_cmdb_identify_reconcile - insert/update CIs through the Identification
 * and Reconciliation Engine (IRE).
 *
 * Every other CI writer in this package aims straight at a class table:
 * snow_create_ci POSTs /api/now/table/<ci_class>, snow_update_ci PUTs it,
 * snow_reconcile_ci PUTs base cmdb_ci. That skips identification entirely — a
 * host that already exists comes back as a second row, no identifier rule runs,
 * no reconciliation rule decides whether the calling source is even allowed to
 * overwrite the attribute, and no Source [sys_object_source] row is written.
 * IRE is the documented way in: "Use this API instead of updating the CMDB
 * directly."
 *
 * Request and response shapes below are taken from ServiceNow's own reference,
 * "Identification and Reconciliation API":
 *   https://www.servicenow.com/docs/r/api-reference/rest-apis/c_IdentifyReconcileAPI.html
 * read from ServiceNow's published documentation source (the docs site renders
 * client-side and cannot be fetched as text):
 *   https://github.com/ServiceNow/ServiceNowDocs
 *   markdown/api-reference/rest-apis/c_IdentifyReconcileAPI.md — release
 *   "australia", last_updated 2026-03-12.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_cmdb_identify_reconcile",
  description: `Insert or update CIs through the CMDB Identification and Reconciliation Engine: POST /api/now/identifyreconcile. IRE runs each class's identifier rules against the payload, so a CI that already exists is matched and updated instead of duplicated, reconciliation rules decide whether this data source may overwrite each attribute, and the source is recorded in Source [sys_object_source].

Returns the engine's verdict per payload item: operation (INSERT, UPDATE, NO_CHANGE, UPDATE_WITH_UPGRADE, UPDATE_WITH_DOWNGRADE, UPDATE_WITH_SWITCH, DELETE), sysId, identifierEntrySysId, each identification attempt with its attemptResult (MATCHED, MULTI_MATCH, NO_MATCH, SKIPPED) and the identifier rule it used, plus per-item errors and warnings. IRE answers HTTP 200 even when individual items fail identification, so this tool reports success only when no returned item, relation or additionally committed item carries an error or a non-zero errorCount.

dry_run: true posts the same payload to /api/now/identifyreconcile/query instead, which returns the same insert/update decision without committing anything. Run that first before pushing a large payload — it is the only way to see what IRE would do without doing it.

data_source is required and must be an existing choice on cmdb_ci.discovery_source; this tool checks it against sys_choice before posting. Without sysparm_data_source the documented behaviour is to store the payload in the incomplete-payloads table rather than commit it, which looks like success and changes nothing.

Use this instead of snow_create_ci and snow_update_ci, which write to a class table and never run identification. Do not reach for snow_reconcile_ci: despite the name it does not reconcile — it PUTs the caller's object onto base cmdb_ci and echoes its reconciliation_rule argument back untouched.

The ServiceNow account needs the itil or asset role.`,
  // Metadata for tool discovery (not sent to LLM)
  category: "cmdb",
  subcategory: "reconciliation",
  use_cases: ["cmdb", "identification", "reconciliation", "deduplication", "discovery-integration"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - the default path commits inserts/updates to the CMDB.
  // dry_run routes to /identifyreconcile/query and changes nothing, but permission
  // is per tool, not per argument, so the whole tool is classified by its writing path.
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "CIs to identify and then insert or update. At least one entry.",
        items: {
          type: "object",
          properties: {
            className: {
              type: "string",
              description:
                "Required. CMDB class/table of the CI, e.g. cmdb_ci_linux_server or cmdb_ci_win_server. Camel-cased key, snake_case table name.",
            },
            values: {
              type: "object",
              description:
                "Field name/value pairs to create or update on the CI. Reference fields take the referenced sys_id. The reference marks only className required, so this may be omitted when the CI is identified through lookup or sys_object_source_info instead — but an item with neither carries nothing for IRE to identify or write.",
            },
            internal_id: {
              type: "string",
              description:
                "Identifier for this item within this payload only. Any value, unique in the payload. Referenced by relations.parent_id/child_id and referenceItems.",
            },
            lookup: {
              type: "array",
              description:
                "Lookup-based identification records (e.g. cmdb_serial_number rows) used to identify the CI. Each entry takes className, values, and optionally internal_id and sys_object_source_info.",
              items: { type: "object" },
            },
            related: {
              type: "array",
              description:
                "Records on a table that references this CI, created or updated alongside it. Not used for identification; allowed types come from the Related Entry [cmdb_related_entry] table.",
              items: { type: "object" },
            },
            settings: {
              type: "object",
              description:
                "Per-item update restrictions: updateWithoutUpgrade, updateWithoutDowngrade, updateWithoutSwitch, skipReclassificationRestrictionRules. All booleans, all default false.",
            },
            sys_object_source_info: {
              type: "object",
              description:
                "Unique CI identifier for this data source: source_name (a cmdb_ci.discovery_source choice), source_native_key, optional source_feed, optional source_recency_timestamp as 'YYYY-MM-DD hh:mm:ss' UTC. Lets IRE match on the Source [sys_object_source] table instead of running identifier rules.",
            },
          },
          required: ["className"],
        },
      },
      relations: {
        type: "array",
        description:
          "Relationships between payload items. Each entry needs type (a name from CI Relationship Type [cmdb_rel_type], e.g. 'Runs on::Runs') plus either parent/child as integer indexes into items, or parent_id/child_id as internal_id values (the only form that can point at a related or lookup item). Optional sys_rel_source_info { source_name, source_feed }.",
        items: { type: "object" },
      },
      referenceItems: {
        type: "array",
        description:
          "References between two payload items, resolved before identification: { referenced, referencedBy, referenceField } where referenced/referencedBy are internal_id values and referenceField is the reference column on the referencedBy class.",
        items: { type: "object" },
      },
      data_source: {
        type: "string",
        description:
          "Required. Sent as sysparm_data_source. Must be a choice value of cmdb_ci.discovery_source on this instance, e.g. 'ServiceNow'. Checked against sys_choice before the payload is posted.",
      },
      dry_run: {
        type: "boolean",
        description:
          "Post to /api/now/identifyreconcile/query instead: same identification, same per-item verdict, nothing committed.",
        default: false,
      },
    },
    required: ["items", "data_source"],
  },
}

export async function execute(args: Record<string, any>, context: ServiceNowContext): Promise<ToolResult> {
  const items = Array.isArray(args.items) ? args.items : []
  if (items.length === 0)
    return createErrorResult(
      "items must be a non-empty array. Each entry needs className (a CMDB table such as cmdb_ci_linux_server), plus the data to identify and write the CI — usually values, otherwise lookup or sys_object_source_info.",
    )

  // The reference marks className "Required." and marks nothing else on an item,
  // so an item identified purely through lookup or sys_object_source_info is not
  // documented as invalid. className is enforced; values is only type-checked
  // when present, because refusing a payload the API would accept is this tool
  // inventing a rule and claiming it came from the API.
  const malformed = items.findIndex((item) => typeof item?.className !== "string" || item.className.length === 0)
  if (malformed !== -1)
    return createErrorResult(
      `items[${malformed}] needs a className string — the CMDB class/table of the CI, such as cmdb_ci_linux_server. It is the only field the reference marks required on an item.`,
    )

  const badValues = items.findIndex(
    (item) =>
      item.values !== undefined &&
      (typeof item.values !== "object" || item.values === null || Array.isArray(item.values)),
  )
  if (badValues !== -1)
    return createErrorResult(
      `items[${badValues}].values must be an object of field name/value pairs. Omit it only when the CI is identified through lookup or sys_object_source_info instead.`,
    )

  // Sent as a query parameter, not in the body. Omitting it does not fail loudly:
  // the documented default is to store the payload in the incomplete-payloads
  // table, so the call returns 200 and the CMDB is unchanged.
  const source: string | undefined = args.data_source ?? args.sysparm_data_source ?? args.discovery_source
  if (typeof source !== "string" || source.length === 0)
    return createErrorResult(
      "data_source is required. Without sysparm_data_source, IRE stores the payload in the incomplete-payloads table instead of committing it — the call succeeds and nothing changes.",
    )

  const relations = Array.isArray(args.relations) ? args.relations : []
  const badRelation = relations.findIndex(
    (relation) =>
      typeof relation?.type !== "string" ||
      relation.type.length === 0 ||
      !(
        (Number.isInteger(relation.parent) && Number.isInteger(relation.child)) ||
        (typeof relation.parent_id === "string" && typeof relation.child_id === "string")
      ),
  )
  if (badRelation !== -1)
    return createErrorResult(
      `relations[${badRelation}] needs type (a name from cmdb_rel_type, e.g. "Runs on::Runs") plus either parent/child as integer indexes into items, or parent_id/child_id as internal_id values.`,
    )

  const outOfRange = relations.findIndex(
    (relation) =>
      Number.isInteger(relation.parent) &&
      (relation.parent < 0 || relation.parent >= items.length || relation.child < 0 || relation.child >= items.length),
  )
  if (outOfRange !== -1)
    return createErrorResult(
      `relations[${outOfRange}] points outside the items array (${items.length} item(s)). parent and child are zero-based indexes into items; use parent_id/child_id if you meant an internal_id.`,
    )

  const dryRun: boolean = args.dry_run ?? false
  const client = await getAuthenticatedClient(context)

  // The reference states sysparm_data_source "must be one of the choice values
  // defined for the discovery_source field of the Configuration Item [cmdb_ci]
  // table". The instance's rejection of an unknown value does not name the valid
  // ones, so read them first. A failed or empty read is not treated as proof the
  // value is wrong — the call goes ahead and the check is reported as skipped.
  // sys_choice rows are per language, so an instance with language packs holds
  // the same value once per language; without the language filter a real choice
  // can fall outside the row limit and this check then rejects a valid write.
  const choices: string[] = await client
    .get("/api/now/table/sys_choice", {
      params: {
        sysparm_query: "name=cmdb_ci^element=discovery_source^language=en",
        sysparm_fields: "value",
        sysparm_limit: 500,
      },
    })
    .then((response) =>
      (response.data.result ?? [])
        .map((row: Record<string, any>) => row.value)
        .filter((value: unknown): value is string => typeof value === "string" && value.length > 0),
    )
    .catch(() => [])

  if (choices.length > 0 && !choices.includes(source))
    return createErrorResult(
      `data_source '${source}' is not a choice on cmdb_ci.discovery_source. Values read from sys_choice on this instance (language en): ${[...new Set(choices)].sort().join(", ")}`,
      { data_source: source, valid_data_sources: [...new Set(choices)].sort() },
    )

  const endpoint = dryRun ? "/api/now/identifyreconcile/query" : "/api/now/identifyreconcile"
  const referenceItems = Array.isArray(args.referenceItems) ? args.referenceItems : []
  const response = await client.post(
    endpoint,
    {
      items,
      ...(relations.length > 0 ? { relations } : {}),
      ...(referenceItems.length > 0 ? { referenceItems } : {}),
    },
    { params: { sysparm_data_source: source } },
  )

  // The worked example in the reference returns `result` as an object; only its
  // schema table prints array brackets around the same named keys. The object is
  // the real shape — the array read stays because reading the wrong one would
  // report zero items for a payload that was in fact processed.
  const result = Array.isArray(response.data.result) ? response.data.result[0] : response.data.result
  const resultItems: Record<string, any>[] = Array.isArray(result?.items) ? result.items : []
  const resultRelations: Record<string, any>[] = Array.isArray(result?.relations) ? result.relations : []
  const additionalItems: Record<string, any>[] = Array.isArray(result?.additionalCommittedItems)
    ? result.additionalCommittedItems
    : []

  // result.items is documented as "List of CIs included in the request body
  // items array", so an empty one for a non-empty payload means the verdict was
  // not returned in the shape read here. Report that rather than a clean run of
  // zero items, which would read as success.
  if (resultItems.length === 0)
    return createErrorResult(
      `${endpoint} returned no per-item result for a ${items.length}-item payload, so what IRE did with it cannot be confirmed from the response. The raw body is in metadata.`,
      { endpoint, data_source: source, dry_run: dryRun, response: response.data },
    )

  const failures = [
    ...collectErrors(resultItems, "items"),
    ...collectErrors(resultRelations, "relations"),
    ...collectErrors(additionalItems, "additionalCommittedItems"),
  ]

  const summary = [
    dryRun
      ? `IRE dry run against ${endpoint} — nothing committed, ${resultItems.length} item verdict(s):`
      : `IRE processed ${resultItems.length} item(s) as data source '${source}':`,
    ...resultItems.slice(0, 10).map((item, index) => {
      const sysId = typeof item?.sysId === "string" && item.sysId !== "Unknown" ? ` sys_id: ${item.sysId}` : ""
      return `  ${index + 1}. ${item?.className ?? "?"} ${item?.operation ?? "?"}${sysId}`
    }),
    ...(resultItems.length > 10 ? [`  ... and ${resultItems.length - 10} more`] : []),
    ...failures.slice(0, 5).map((failure) => `  ✗ ${failure.where}: ${failure.message ?? failure.error}`),
    ...(failures.length > 5 ? [`  ✗ ... and ${failures.length - 5} more error(s)`] : []),
  ].join("\n")

  const data = {
    dry_run: dryRun,
    endpoint,
    data_source: source,
    data_source_checked: choices.length > 0,
    operations: resultItems.reduce<Record<string, number>>((counts, item) => {
      const operation = typeof item?.operation === "string" ? item.operation : "UNKNOWN"
      counts[operation] = (counts[operation] ?? 0) + 1
      return counts
    }, {}),
    items: resultItems,
    relations: resultRelations,
    additional_committed_items: additionalItems,
    errors: failures,
  }

  if (failures.length > 0)
    return {
      success: false,
      error:
        `IRE returned ${failures.length} error(s) for this payload: ` +
        failures
          .slice(0, 3)
          .map((failure) => `${failure.where} ${failure.message ?? failure.error}`)
          .join("; ") +
        (failures.length > 3 ? ` (+${failures.length - 3} more)` : "") +
        (dryRun
          ? ""
          : " — partial commits are an Enhanced-IRE feature and this endpoint is not the enhanced one, so do not assume the error-free items committed; re-read the CIs to confirm. Per-item verdicts are in data.items."),
      data,
      summary,
      metadata: { endpoint, data_source: source, dry_run: dryRun },
    }

  // Only a single-item payload has one unambiguous artifact, and "Unknown" is
  // the documented sysId for an item whose identification failed.
  const single = resultItems.length === 1 ? resultItems[0] : undefined
  const artifact =
    !dryRun && typeof single?.sysId === "string" && single.sysId.length > 0 && single.sysId !== "Unknown"
      ? {
          sys_id: single.sysId,
          type: "cmdb_ci",
          table: typeof single.className === "string" ? single.className : undefined,
        }
      : undefined

  return createSuccessResult(data, { endpoint, data_source: source, dry_run: dryRun }, summary, artifact)
}

/**
 * IRE reports per-item failure inside a 200 response, one `errors` array per
 * result row, so the caller only learns a CI was rejected by reading them. The
 * reference documents errorCount beside errors on items, relations and
 * additionalCommittedItems, and its inline shape sample for
 * additionalCommittedItems prints errorCount without the errors array. A count
 * with no detail is still a failure, so it is reported rather than dropped.
 */
function collectErrors(rows: Record<string, any>[], label: string) {
  return rows.flatMap((row, index) => {
    const className = typeof row?.className === "string" ? row.className : undefined
    const errors: Record<string, any>[] = Array.isArray(row?.errors) ? row.errors : []
    if (errors.length > 0)
      return errors.map((entry) => ({
        where: `${label}[${index}]`,
        className,
        error: entry?.error,
        message: entry?.message,
      }))
    // Number() rather than a typeof check: the reference types errorCount as a
    // Number, but a count that arrives as "2" is still two errors.
    if (Number(row?.errorCount) > 0)
      return [
        {
          where: `${label}[${index}]`,
          className,
          error: "errorCount",
          message: `${row.errorCount} error(s) reported, with no errors[] detail in the response`,
        },
      ]
    return []
  })
}

export const version = "1.0.0"
export const author = "Serac"
