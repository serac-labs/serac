/**
 * snow_instance_visibility — what can this connection actually SEE on this
 * instance, are its filters real, and what instance is it?
 *
 * The question behind it is the one nothing answers today: "I pointed an agent
 * at my ServiceNow instance, why does everything come back empty?" There are
 * four different answers — the account cannot read the table, the table is
 * genuinely empty, the filter was silently dropped so the number is about a
 * different population than you think, or this is not the instance you meant —
 * and a tool that reports a confident `0` for all four is worse than one that
 * says which.
 *
 * So the call reports, per table, whether the read succeeds and how much sits
 * behind it; whether `javascript:` date functions resolve at all in an encoded
 * query; which of ServiceNow's two invalid-query regimes the instance is in;
 * and which release, build and edition answered.
 *
 * WHY THIS RUNS ON HTTP AND snow_diagnose_setup DOES NOT. That tool reports the
 * credential CHAIN — environment variables, every auth.json on the machine and
 * its mtime — which on HTTP is the server's own configuration handed to
 * whichever tenant asked, and its stdio-only annotation says exactly that. This
 * one reads nothing but the instance, through the caller's own credential, so
 * it declares no transport restriction at all. The dividing line is drawn in
 * `shared/setup-doctor.ts`, above the probes this file calls. Do not reach
 * across it: `runSetupDoctor` and `resolveChain` are on the other side.
 *
 * WHY NOT snow_check_connection. `main` already ships snow_test_connection,
 * snow_check_health, snow_validate_live_connection, snow_auth_diagnostics and
 * snow_diagnose_setup. A sixth name for "is it working" makes the catalog
 * worse; this one is named for the answer it gives, not for the question.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import {
  dateFunctionCanary,
  invalidQueryProbe,
  loadRolesManifest,
  manifestStamp,
  probeHeldRoles,
  probeReach,
  probeTableRead,
  readInstanceIdentity,
  summarizeRoleCoverage,
  summarizeTableAccess,
  type Check,
  type DateFunctions,
  type HeldRoles,
  type InstanceIdentity,
  type InvalidQuery,
  type ProbeClient,
  type RoleCoverage,
  type TableAdvice,
  type TableRead,
} from "../../shared/setup-doctor.js"

/**
 * Every table costs one sequential GET, and a second one when the bounded read
 * comes back 400 or 0 — the two answers that can be about the date column
 * rather than about the table. Twenty is already a visible pause against a
 * waking developer instance, so the cap is declared in the schema — a caller
 * meets it before the call rather than in the latency.
 */
const TABLE_CAP = 20

/** What one call answers. Everything optional is something the caller turned off. */
export interface Visibility {
  reach: Check
  roles?: {
    held: string[]
    /** The held-role page came back full: `held` is a floor, not an inventory. */
    heldTruncated: boolean
    /**
     * False when the instance REFUSED the held-role read — which needs a role
     * of its own, so it is the low-privilege accounts that hit it.
     *
     * Carried because without it a refusal is byte-identical to an account
     * that genuinely holds nothing: `held: []`, `heldTruncated: false`, and a
     * coverage block computed from the empty list. A refused list is strictly
     * less knowable than a truncated one, and the truncated one already
     * renders as unknown rather than as blocked.
     */
    heldReadable: boolean
    /** The status behind `heldReadable`. 0 when the request never arrived. */
    heldHttpStatus: number
    /**
     * Absent when the held-role read was refused. `blocked: 247` computed from
     * a refusal is not a measurement of anything, and it is the number the
     * summary line prints.
     */
    coverage?: RoleCoverage
    /** How old the advice is. Roles move between ServiceNow families. */
    manifest: { validatedOn?: string; testedAt?: string }
  }
  tables: (TableRead & TableAdvice)[]
  dateFunctions?: DateFunctions
  invalidQuery?: InvalidQuery
  identity?: InstanceIdentity
  instanceUrl: string
}

export const toolDefinition: MCPToolDefinition = {
  name: "snow_instance_visibility",
  description:
    "Report what this ServiceNow connection can actually see: per table whether the read succeeds (with the HTTP status and the row count behind it), which roles the account holds and which ones a refused table needs, whether javascript: date filters resolve on this instance or are silently dropped, whether a condition on an unknown column is ignored or returns no rows, and which release, build, edition and plugin count answered. Call this when queries come back empty or a filtered count looks wrong, before trusting any number from this instance. Read-only: every call is a GET.",
  category: "platform",
  subcategory: "diagnostics",
  use_cases: [
    "empty results",
    "permissions",
    "roles",
    "reachability",
    "filters",
    "instance identity",
    "troubleshooting",
  ],
  complexity: "beginner",
  frequency: "medium",
  permission: "read",
  // A status surface has to exist for the read-only persona: "why is this
  // empty" is the first question a stakeholder asks, and sending them to a
  // developer to find out is how the answer stops being asked for.
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      tables: {
        type: "array",
        items: { type: "string" },
        maxItems: TABLE_CAP,
        default: [],
        description: `Tables to probe for read access, one GET each (max ${TABLE_CAP}). Omit to skip the per-table probe and report only roles, filters and identity.`,
      },
      lifetime_days: {
        type: "number",
        default: 365,
        minimum: 0,
        description:
          "Bound each table's row count to rows created within this many days. 0 counts the whole table. A table that refuses the bounded read, or answers 0 to it, is re-read unbounded before that answer is reported: on a table with no sys_created_on the clause is silently dropped or matches nothing, and neither shows up as an error.",
      },
      date_canary: {
        type: "boolean",
        default: true,
        description:
          "Test whether javascript: date functions resolve, with one count whose clause cannot match anything. Costs two calls.",
      },
      canary_table: {
        type: "string",
        default: "sys_user",
        description:
          "Table the date and invalid-column canaries run against. It has to hold rows to be conclusive, and it has to be one this connection can read.",
      },
      invalid_query_probe: {
        type: "boolean",
        default: true,
        description:
          "Test what the instance does with a condition on a column that does not exist: ignore it and answer for the whole table, or return no rows. Costs one call.",
      },
      include_identity: {
        type: "boolean",
        default: true,
        description: "Read release, build tag, edition, active-plugin count and domain scope. Costs three calls.",
      },
      include_role_coverage: {
        type: "boolean",
        default: true,
        description:
          "Read the roles the account holds and fold them against the shipped role manifest. Costs one call. With this off, a refused table lists every role that could read it instead of only the ones this account is missing.",
      },
    },
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const tables = names(args.tables)
  if (tables.length > TABLE_CAP)
    return createErrorResult(
      `tables holds ${tables.length} entries and the cap is ${TABLE_CAP} — each one is a sequential GET. Split the call.`,
    )

  const canary = text(args.canary_table) ?? "sys_user"
  const lifetimeDays = typeof args.lifetime_days === "number" ? args.lifetime_days : 365
  const wantsCanary = args.date_canary !== false
  const wantsInvalid = args.invalid_query_probe !== false

  // The auth manager's own failure message names the likely cause and points
  // at snow_diagnose_setup. Flattening it into a generic error would send the
  // reader back to exactly the opaque failure this tool exists to replace.
  const authenticated = await getAuthenticatedClient(context).then(
    (client) => ({ client }),
    (error: unknown) => ({
      failure: error instanceof Error ? error.message : String(error),
      status: httpStatus(error),
    }),
  )
  // The status rides in the metadata rather than only in the sentence. This is
  // the hardest failure to act on — a dead credential answers 401 everywhere,
  // so no probe below ever runs — and "the credential is dead" and "the
  // instance could not be reached" call for opposite responses. Same rule as
  // snow_aggregate_metrics' error metadata: nobody should have to regex an
  // error message for a number the response already carried.
  if ("failure" in authenticated)
    return createErrorResult(
      `No authenticated client for ${context.instanceUrl}: ${authenticated.failure}`,
      authenticated.status === undefined ? {} : { http_status: authenticated.status },
    )
  const client: ProbeClient = authenticated.client

  const reach = await probeReach(client)
  const roles = args.include_role_coverage !== false ? await probeHeldRoles(client) : undefined
  const manifest = loadRolesManifest()

  // Sequential on purpose. These probes run against instances that are waking
  // up, and a burst of parallel reads from a diagnostic is how the diagnostic
  // becomes the reason the next tool call times out.
  const reads: TableRead[] = []
  for (const table of tables) reads.push(await probeTableRead(client, table, lifetimeDays))

  // The canaries compare against the WHOLE canary table, so it gets its own
  // unbounded count: a total already narrowed to lifetime_days describes a
  // different population than the clause under test, and "the clause matched
  // everything" is only a statement when both sides cover the same rows.
  const total = wantsCanary || wantsInvalid ? (await probeTableRead(client, canary, 0)).lifetime : null

  const data: Visibility = {
    reach: reach.check,
    roles: roles
      ? {
          held: roles.held,
          heldTruncated: roles.truncated,
          heldReadable: roles.readable,
          heldHttpStatus: roles.httpStatus,
          coverage: manifest && roles.readable ? summarizeRoleCoverage(manifest, roles.held) : undefined,
          manifest: manifestStamp(manifest),
        }
      : undefined,
    tables: reads.map((read) => ({ ...read, ...advice(manifest, read, roles) })),
    dateFunctions: wantsCanary ? await dateFunctionCanary(client, canary, "gs.daysAgoStart", total) : undefined,
    invalidQuery: wantsInvalid ? await invalidQueryProbe(client, canary, total) : undefined,
    identity: args.include_identity !== false ? await readInstanceIdentity(client, reach.domain) : undefined,
    instanceUrl: context.instanceUrl,
  }

  // Always a success envelope: the diagnosis ran. A refused table is the
  // answer, not a failure of the tool, and an error envelope here reads as
  // "try again" for a result that will not change.
  return createSuccessResult(
    data,
    { tables: data.tables.length, readable: data.tables.filter((table) => table.readable).length },
    summarize(data),
  )
}

/**
 * The manifest half of a table row, subject to three rules the manifest cannot
 * enforce on itself.
 *
 * The probe outranks the manifest: a table that was just read needs no advice
 * about roles, whatever a static role map says about it.
 *
 * A subtraction needs a list to subtract. A truncated held-role list cannot
 * support one — the page caps at 500 with no ORDERBY and it is admins who
 * overflow it, so "you are missing these roles" would be a guess dressed as
 * advice, aimed at the one account that is missing nothing — and a REFUSED
 * list supports it even less: there, `held` is empty because the instance said
 * no, so every role the manifest names would be printed as missing, including
 * the ones the account already holds. `include_role_coverage: false` is the
 * one case where an empty list is not a claim, and the schema says what
 * happens then: the full list of roles that could read the table.
 *
 * And a refusal has to be role-shaped before roles are the answer. 401 and 403
 * are about this account; a 404 is about the table, a 400 about the query, and
 * a 200 that did not parse is a hibernating instance answering with a login
 * page. Telling someone to go ask an admin for `update_set_admin` because
 * their PDI is asleep sends them to the wrong person with the wrong request.
 */
const advice = (manifest: unknown, read: TableRead, roles: HeldRoles | undefined): TableAdvice => {
  const summary = manifest ? summarizeTableAccess(manifest, read.table, roles?.held ?? []) : EMPTY_ADVICE
  return refusedForRoles(read) && knowsWhatIsHeld(roles) ? summary : { ...summary, missingRoles: [] }
}

/** ServiceNow answers an ACL failure on a table read with one of these two. */
const ROLE_SHAPED = [401, 403]

const refusedForRoles = (read: TableRead): boolean => !read.readable && ROLE_SHAPED.includes(read.httpStatus ?? 0)

const knowsWhatIsHeld = (roles: HeldRoles | undefined): boolean =>
  roles === undefined || (roles.readable && !roles.truncated)

const EMPTY_ADVICE: TableAdvice = { missingRoles: [], scriptAcls: 0 }

const names = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.map(String).map((name) => name.trim()).filter(Boolean)
    : typeof raw === "string"
      ? raw.split(",").map((name) => name.trim()).filter(Boolean)
      : []

const text = (raw: unknown): string | undefined => (typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** The HTTP status an auth failure carried, when it carried one. */
const httpStatus = (error: unknown): number | undefined => {
  const response = isRecord(error) ? error.response : undefined
  const status = isRecord(response) ? response.status : undefined
  return typeof status === "number" ? status : undefined
}

/**
 * The report as a human reads it. Plain text for the same reason
 * `renderReport` is: it comes back as the MCP summary and is printed by
 * clients that assume nothing about a terminal.
 */
const summarize = (data: Visibility): string => {
  const lines = [
    `  ${label("api access")} ${data.reach.title}`,
    ...(data.roles ? [`  ${label("roles")} ${held(data.roles)}`] : []),
    ...(data.identity ? [`  ${label("identity")} ${identity(data.identity)}`] : []),
    ...(data.dateFunctions
      ? [
          `  ${label("date filters")} ${DATE_VERDICTS[data.dateFunctions.verdict]} (${data.dateFunctions.fn}: ${
            data.dateFunctions.canary ?? "?"
          } of ${data.dateFunctions.total ?? "?"} rows matched a clause that cannot match)`,
        ]
      : []),
    ...(data.invalidQuery ? [`  ${label("bad columns")} ${REGIMES[data.invalidQuery.verdict]}`] : []),
    ...(data.tables.length > 0 ? ["", "  tables"] : []),
    ...data.tables.map((table) => `    ${(table.readable ? "ok" : String(table.httpStatus ?? "—")).padEnd(5)} ${row(table)}`),
    // Said once, and said even where every count is zero: the number comes
    // from the ACL `script` column alone, so a 0 means no scripted ACL was
    // seen — never that no row-level filter applies to what you just counted.
    ...(data.tables.some((table) => table.readable)
      ? ["", "  Scripted-ACL counts cover the ACL script column only. Row-level conditions are invisible to this check."]
      : []),
  ]

  return ["ServiceNow MCP — instance visibility", "", ...lines].join("\n")
}

// 13 characters, so continuation lines land under the text rather than under
// the label — the same measure renderReport uses.
const label = (name: string) => name.padEnd(13)

/**
 * The roles line. A refusal is reported as a refusal: "0 held", with a
 * coverage figure beside it, is this tool inventing the one number a reader
 * acts on out of an answer that was never given.
 */
const held = (roles: NonNullable<Visibility["roles"]>): string => {
  if (roles.heldReadable)
    return `${roles.held.length} held${roles.heldTruncated ? " (full page — a floor, not an inventory)" : ""}${
      roles.coverage ? `; ${roles.coverage.unlocked} of ${roles.coverage.resolved} resolvable tools in reach` : ""
    }`

  const why =
    roles.heldHttpStatus === 0
      ? "the request never got an answer"
      : ROLE_SHAPED.includes(roles.heldHttpStatus)
        ? `the read was refused (HTTP ${roles.heldHttpStatus}); reading sys_user_has_role needs a role of its own`
        : `HTTP ${roles.heldHttpStatus}, but not a role list`
  return `unknown — ${why}. That is not an account that holds nothing.`
}

const identity = (identity: InstanceIdentity): string =>
  [
    identity.release,
    identity.edition,
    identity.productDescription,
    identity.pluginCount === null ? undefined : `${identity.pluginCount} active plugins`,
    identity.domainSeparated === "separated" ? "domain separation installed" : undefined,
    identity.integrationUserDomain ? `domain ${identity.integrationUserDomain}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ") || "nothing readable in sys_properties"

const row = (table: TableRead & TableAdvice): string =>
  `${table.table.padEnd(30)} ${
    table.readable
      ? [
          table.lifetime === null
            ? "readable, but the instance sent no count"
            : `${table.lifetime} rows${table.lifetimeWindowDays === null ? "" : ` over ${table.lifetimeWindowDays}d`}`,
          `${table.scriptAcls} scripted ACL(s)`,
        ].join(" · ")
      : `${table.error ?? "not readable"}${
          table.missingRoles.length > 0 ? ` · ask an admin for one of: ${table.missingRoles.join(", ")}` : ""
        }`
  }`

const DATE_VERDICTS: Record<DateFunctions["verdict"], string> = {
  resolved: "resolve — a windowed count on this instance really is windowed",
  evaporated: "DROPPED — the instance ignored the date clause and answered for the whole table",
  inconclusive: "inconclusive — nothing was shown either way",
}

const REGIMES: Record<InvalidQuery["verdict"], string> = {
  ignores: "ignored — a condition on a column that does not exist answers for the whole table",
  returns_no_rows: "no rows — a condition the instance cannot apply answers 0 rather than everything",
  unknown: "unknown — the probe could not tell which regime this instance is in",
}

export const version = "1.0.0"
export const author = "Serac"
