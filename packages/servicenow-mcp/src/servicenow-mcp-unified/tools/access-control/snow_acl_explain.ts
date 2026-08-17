/**
 * snow_acl_explain - what stands between a user and a record
 *
 * Lists every ACL that can apply to a table (and optionally one field) for one
 * operation, resolves the roles each of them names through the
 * `sys_security_acl_role` m2m, and diffs those against the roles one named user
 * actually holds.
 *
 * It stops there on purpose. ServiceNow's real answer also depends on each
 * ACL's condition and advanced script, which run inside the platform against a
 * specific record; nothing reachable over the Table API evaluates them. The
 * output is therefore "here is what applies and here is what you hold", never a
 * verdict. `snow_test_acl` claims to produce that verdict by POSTing to
 * `sys_script_execution` — creating a record there executes nothing, and it
 * ignores both its `operation` and its `user` argument.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient, type ExtendedAxiosInstance } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

/**
 * The four operations this tool covers. `sys_security_acl.operation` also carries operations belonging to
 * the non-table ACL types (execute on a client-callable script include, for one); those are out of scope
 * here because the name chain this builds is a table/field chain.
 */
const OPERATIONS = ["read", "write", "create", "delete"]

/** Guard against a cyclic or pathological `super_class` chain. */
const CHAIN_DEPTH = 10

/** Page sizes. Both are reported as warnings when hit, because a silently short list here reads as "no rule". */
const ACL_PAGE = 200
const ROLE_PAGE = 500

export const toolDefinition: MCPToolDefinition = {
  name: "snow_acl_explain",
  description:
    "Explain which ACLs apply to a table (optionally one field) for one operation, and what a named user is missing. Walks sys_db_object.super_class so parent-table rules are included, covers the wildcard names (*, *.field, table.*, *.*), resolves each rule's required roles through the sys_security_acl_role m2m, and reports which of those roles the user actually holds (sys_user_has_role, inherited roles included). Returns the applicable rules plus the role gap — NOT an access decision: ACL conditions and advanced scripts are reported and counted but never evaluated.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "access-control",
  use_cases: ["acl", "security", "roles", "permissions", "debugging"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - queries sys_security_acl, sys_security_acl_role,
  // sys_db_object, sys_user and sys_user_has_role; writes nothing.
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Table the record lives on, e.g. 'incident'",
      },
      operation: {
        type: "string",
        enum: OPERATIONS,
        description: "The operation being denied: read, write, create or delete",
      },
      field: {
        type: "string",
        description:
          "Optional field name, e.g. 'priority' or 'incident.priority'. Adds the six field-level ACL names to the report; without it only the record-level names are checked.",
      },
      user: {
        type: "string",
        description:
          "Optional sys_id or user_name of the user to diff against. Without it the report lists the rules and their roles but nothing about who holds what.",
      },
      include_inactive: {
        type: "boolean",
        description: "Include ACLs with active=false. Default: false.",
        default: false,
      },
    },
    required: ["table", "operation"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const table = typeof args.table === "string" ? args.table.trim() : ""
  const operation = typeof args.operation === "string" ? args.operation.trim().toLowerCase() : ""
  if (!table) return createErrorResult("Missing 'table' argument")
  if (!OPERATIONS.includes(operation))
    return createErrorResult(`'operation' must be one of: ${OPERATIONS.join(", ")} (got '${String(args.operation)}')`)

  // Callers write the field either bare ("priority") or qualified
  // ("incident.priority"); the ACL name is composed below, so drop the prefix.
  const rawField = typeof args.field === "string" ? args.field.trim() : ""
  const field = rawField.includes(".") ? rawField.slice(rawField.lastIndexOf(".") + 1) : rawField
  const includeInactive = args.include_inactive === true
  const who = typeof args.user === "string" ? args.user.trim() : ""

  const client = await getAuthenticatedClient(context)
  const warnings: string[] = []

  if (rawField.includes(".") && !rawField.startsWith(`${table}.`))
    warnings.push(
      `Read 'field' as '${field}': the '${rawField.slice(0, rawField.lastIndexOf("."))}.' prefix was dropped, because ACL names are composed from the 'table' argument. Pass table='${rawField.slice(0, rawField.lastIndexOf("."))}' if that was the table you meant.`,
    )

  const root = await client
    .get("/api/now/table/sys_db_object", {
      params: { sysparm_query: `name=${table}`, sysparm_fields: "name,super_class", sysparm_limit: 1 },
    })
    .then((r) => ({ row: (r.data?.result ?? [])[0] as Record<string, unknown> | undefined }))
    .catch((err: Error) => ({ error: err.message || "sys_db_object lookup failed" }))

  if ("error" in root)
    warnings.push(`Table hierarchy could not be read (${root.error}) — parent-table ACLs are NOT in this report.`)
  const rootRow = "row" in root ? root.row : undefined
  if ("row" in root && !rootRow)
    warnings.push(
      `No sys_db_object row named '${table}'. Either the table name is wrong, or this connection cannot read sys_db_object — parent-table ACLs are NOT in this report.`,
    )

  const ancestors = rootRow ? await superClassChain(client, referenceValue(rootRow.super_class), CHAIN_DEPTH) : []
  const candidates = aclCandidateNames(table, ancestors, field)
  const names = [...candidates.record, ...candidates.field]
  // Record-level and field-level names are orthogonal — both levels apply to the same
  // request — so they are not two points on one scale. Rank inside each level instead:
  // one index across both would put the record-level `*` above `incident.priority`.
  const order = new Map(
    (["record", "field"] as const).flatMap((level, group) =>
      candidates[level].map((name, index) => [name, { level, group, index }] as const),
    ),
  )

  const acls = await client
    .get("/api/now/table/sys_security_acl", {
      params: {
        // `nameIN` is exact-match per element, which is what these names need: "*" and
        // "*.*" are literal ACL names, not patterns. Plain `name=*` equality is proven
        // against a live instance (script/probe-sn-roles/acl-resolve.ts, and 189 rows of
        // sn-roles.manifest.json resolved through it); a literal "*" *inside* an IN list
        // is not, which is why the zero-match caveat below names it as a possibility.
        sysparm_query: `nameIN${names.join(",")}^operation=${operation}${includeInactive ? "" : "^active=true"}`,
        sysparm_fields:
          "sys_id,name,operation,type,active,admin_overrides,condition,script,sys_updated_on,sys_updated_by",
        sysparm_limit: ACL_PAGE,
      },
    })
    .then((r) => ({ rows: (r.data?.result ?? []) as Record<string, string>[] }))
    .catch((err: Error) => ({ error: err.message || "sys_security_acl query failed" }))

  if ("error" in acls) return createErrorResult(`Could not read sys_security_acl: ${acls.error}`)

  const aclRows = acls.rows.slice().sort((a, b) => {
    const left = order.get(a.name) ?? { group: 9, index: 999 }
    const right = order.get(b.name) ?? { group: 9, index: 999 }
    return left.group - right.group || left.index - right.index
  })
  if (aclRows.length === ACL_PAGE)
    warnings.push(`Hit the ${ACL_PAGE}-row page limit on sys_security_acl — there may be more rules than listed.`)

  // Required roles live in the m2m, never on sys_security_acl itself — there is
  // no `roles` column there, which is why tools that read one always report none.
  const aclRoles =
    aclRows.length === 0
      ? { rows: [] as ReferenceRow[] }
      : await client
          .get("/api/now/table/sys_security_acl_role", {
            params: {
              sysparm_query: `sys_security_aclIN${aclRows.map((row) => row.sys_id).join(",")}`,
              sysparm_fields: "sys_security_acl,sys_user_role",
              sysparm_display_value: "all",
              sysparm_limit: ROLE_PAGE,
            },
          })
          .then((r) => ({ rows: (r.data?.result ?? []) as ReferenceRow[] }))
          .catch((err: Error) => ({ error: err.message || "sys_security_acl_role query failed" }))

  if ("error" in aclRoles)
    warnings.push(
      `Required roles could not be read (${aclRoles.error}) — every rule below reports requires_roles: null, which means unknown, not "no role needed".`,
    )
  const roleRows = "rows" in aclRoles ? aclRoles.rows : undefined
  if (roleRows?.length === ROLE_PAGE)
    warnings.push(`Hit the ${ROLE_PAGE}-row page limit on sys_security_acl_role — required roles may be incomplete.`)

  const resolved = who ? await resolveUser(client, who) : undefined
  if (resolved && !resolved.ok) return createErrorResult(resolved.error)
  const user = resolved?.ok ? resolved : undefined
  if (user?.warning) warnings.push(user.warning)
  if (user?.truncated)
    warnings.push(`The user's role list hit the ${ROLE_PAGE}-row page limit — roles_not_held may be overstated.`)
  const held = user ? new Set(user.roles) : undefined

  const rules = aclRows.map((row) => {
    const required = roleRows === undefined ? null : rolesOf(roleRows, row.sys_id)
    const place = order.get(row.name)
    return {
      sys_id: row.sys_id,
      name: row.name,
      level: place?.level ?? "unknown",
      specificity_within_level: place?.index ?? null,
      operation: row.operation,
      type: row.type,
      active: row.active === "true",
      admin_overrides: row.admin_overrides === "true",
      requires_roles: required,
      // The roles on one rule are alternatives, so these two are a split of
      // `requires_roles`, not a checklist: a non-empty `user_holds` already satisfies
      // this rule's role check, and `roles_not_held` is then only the remainder — never
      // read it as "grant these". Hence the neutral name.
      user_holds: required && held ? required.filter((role) => held.has(role)) : null,
      roles_not_held: required && held ? required.filter((role) => !held.has(role)) : null,
      has_condition: Boolean(row.condition?.trim()),
      has_script: Boolean(row.script?.trim()),
      condition: row.condition?.trim() ? clip(row.condition.trim()) : "",
      script_preview: row.script?.trim() ? clip(row.script.trim()) : "",
      updated_on: row.sys_updated_on,
      updated_by: row.sys_updated_by,
    }
  })

  const rolesNamed = [...new Set(rules.flatMap((rule) => rule.requires_roles ?? []))].sort()
  const withCondition = rules.filter((rule) => rule.has_condition).length
  const withScript = rules.filter((rule) => rule.has_script).length
  const types = [...new Set(rules.map((rule) => rule.type).filter(Boolean))].sort()

  const caveats = [
    "This is not an access decision. It lists the rules that carry the decision and the roles the user holds.",
    "The roles on one rule are alternatives: holding any one satisfies that rule's role check, and a rule naming no roles imposes no role requirement. So 'roles_not_held' is the remainder of 'requires_roles', not a list of roles to grant — if 'user_holds' is non-empty, that rule's role check is already met.",
    rules.length === 0
      ? "No rule matched any of the candidate names for this operation. Either none exists, or this connection cannot see them. A third possibility: the literal wildcard names ('*', '*.*') are matched through 'nameIN', and an instance whose query parser treated them as patterns rather than literals would contribute nothing from those levels."
      : withCondition + withScript > 0
        ? `${withCondition} of these rules carry a condition and ${withScript} carry a script. Both run inside the platform against a specific record and are NOT evaluated here — a user holding every role listed can still be denied by them.`
        : "None of these rules carry a condition or a script, so the role lists below are the whole of what they check.",
    "Roles are listed exactly as each rule names them in sys_security_acl_role. Which rule ServiceNow lets decide, and how several matching rules combine, is not modelled here.",
    "sys_security_acl is itself ACL-protected: an empty or short result can mean 'not visible to this connection' rather than 'does not exist'. Reading it needs an elevated role (admin, or a reader role such as access_control_read_admin).",
    // sys_security_acl also holds the non-table ACL types. This tool does not filter on
    // `type` because it could not confirm which value field-level rules carry, and a
    // wrong filter would silently drop rules — the failure this tool exists to prevent.
    // So it reports instead: silent on an all-`record` result, loud otherwise.
    types.some((type) => type !== "record")
      ? `sys_security_acl also holds rules for the non-table ACL types (ui_page, processor, rest_endpoint, client_callable_script_include), and one of those can carry a name that matched here — '*' most plausibly — without governing table access. Types matched: ${types.join(", ")}. Check each rule's 'type' before acting on it.`
      : "",
    rules.some((rule) => rule.admin_overrides)
      ? "Some rules have admin_overrides set. The flag is reported per rule; its effect is not modelled."
      : "",
  ].filter(Boolean)

  const data = {
    table,
    operation,
    field: field || null,
    table_chain: [table, ...ancestors],
    candidate_names: candidates,
    matched: rules.length,
    rules,
    roles_named_by_rules: rolesNamed,
    user: user
      ? {
          // Deliberately not `sys_id`: createSuccessResult hoists a nested
          // `sys_id` into `result.artifact`, and a read-only report has no
          // artifact — the write-tracking post-hooks would record this user as one.
          user_sys_id: user.sys_id,
          user_name: user.user_name,
          name: user.name,
          active: user.active,
          role_count: user.roles.length,
          roles: user.roles,
          // Same reason as the per-rule split: `roles_named_by_rules` is a union across
          // rules that are alternatives to each other, so the complement of it is even
          // less of a to-do list than the per-rule one. Named neutrally on purpose.
          holds_of_named: rolesNamed.filter((role) => user.roles.includes(role)),
          not_held_of_named: rolesNamed.filter((role) => !user.roles.includes(role)),
        }
      : null,
    not_evaluated: { rules_with_condition: withCondition, rules_with_script: withScript },
    caveats,
    warnings,
  }

  const target = field ? `${table}.${field}` : table
  const heldNamed = data.user ? data.user.holds_of_named : []
  const summary = [
    `ACLs applying to ${target} · ${operation}${includeInactive ? " (incl. inactive)" : ""}`,
    `  table chain: ${data.table_chain.join(" → ")}`,
    `  record-level names checked: ${candidates.record.join(", ")}`,
    candidates.field.length ? `  field-level names checked:  ${candidates.field.join(", ")}` : "",
    rules.length === 0
      ? `  no ACL matched any of these ${names.length} names for '${operation}'`
      : `  matched ${rules.length} rule(s): ${rules.map((rule) => rule.name).join(", ")}`,
    rolesNamed.length ? `  roles named by these rules: ${rolesNamed.join(", ")}` : "",
    data.user
      ? `  ${data.user.user_name} holds ${data.user.role_count} role(s); of the roles named above ${
          heldNamed.length ? `holds ${heldNamed.join(", ")}` : "holds none"
        }`
      : "  no user given — nothing is being diffed against held roles",
    `  not evaluated: ${withCondition} condition(s), ${withScript} script(s)`,
    warnings.length ? `  ⚠ ${warnings.length} warning(s) — see data.warnings` : "",
    "This lists what applies and what the user holds; it is not an access decision.",
  ]
    .filter(Boolean)
    .join("\n")

  return createSuccessResult(data, { matched: rules.length, warnings: warnings.length }, summary)
}

/**
 * Every ACL name that can carry a rule for this table/field, returned as two
 * lists because the two levels are not comparable: a record-level name and a
 * field-level name both apply to the same request, so ordering them against each
 * other is meaningless. Within each list the names run most specific first.
 * `ancestors` is the `sys_db_object.super_class` chain, nearest parent first.
 *
 * A field can be covered by its own name on this table or on any ancestor, by
 * the same field on any table, or by a table-wide field wildcard — so a report
 * that stops at `table.field` names the wrong blocker exactly when the inherited
 * or wildcard rule is the one with the roles on it.
 */
export function aclCandidateNames(table: string, ancestors: string[], field: string) {
  const tables = [...new Set([table, ...ancestors])]
  const record = [...tables, "*"]
  if (!field) return { record, field: [] as string[] }
  return {
    record,
    field: [...tables.map((name) => `${name}.${field}`), `*.${field}`, ...tables.map((name) => `${name}.*`), "*.*"],
  }
}

/** One row read with `sysparm_display_value=all`: every field is a value/display pair. */
type ReferenceRow = Record<string, { display_value?: string; value?: string } | undefined>

/**
 * `sys_db_object.super_class` points back at `sys_db_object`, so the chain can
 * only be walked one record at a time.
 */
async function superClassChain(
  client: ExtendedAxiosInstance,
  superClass: string | undefined,
  depth: number,
): Promise<string[]> {
  if (!superClass || depth <= 0) return []
  const row = await client
    .get(`/api/now/table/sys_db_object/${superClass}`, { params: { sysparm_fields: "name,super_class" } })
    .then((r) => r.data?.result as Record<string, unknown> | undefined)
    .catch(() => undefined)
  const name = typeof row?.name === "string" ? row.name : ""
  if (!name) return []
  return [name, ...(await superClassChain(client, referenceValue(row?.super_class), depth - 1))]
}

/**
 * A reference field is `{ link, value }` on the Table API's default
 * representation and `{ display_value, value }` with `sysparm_display_value=all`,
 * but a bare sys_id string on some responses.
 */
function referenceValue(field: unknown): string | undefined {
  if (typeof field === "string") return field || undefined
  if (field && typeof field === "object" && "value" in field) {
    const value = (field as { value?: unknown }).value
    return typeof value === "string" && value ? value : undefined
  }
  return undefined
}

function rolesOf(rows: ReferenceRow[], aclId: string) {
  return [
    ...new Set(
      rows
        .filter((row) => referenceValue(row.sys_security_acl) === aclId)
        .map((row) => row.sys_user_role?.display_value ?? "")
        .filter(Boolean),
    ),
  ].sort()
}

/**
 * Resolve the user and their roles. `sys_user_has_role` already materializes
 * inherited roles (each row carries `inherited`), so there is no need to expand
 * `sys_user_role_contains` on top of it.
 */
async function resolveUser(client: ExtendedAxiosInstance, who: string) {
  const query = /^[0-9a-f]{32}$/i.test(who) ? `sys_id=${who}` : `user_name=${who}`
  const found = await client
    .get("/api/now/table/sys_user", {
      params: { sysparm_query: query, sysparm_fields: "sys_id,user_name,name,active", sysparm_limit: 2 },
    })
    .then((r) => ({ rows: (r.data?.result ?? []) as Record<string, string>[] }))
    .catch((err: Error) => ({
      rows: [] as Record<string, string>[],
      failure: `Could not read sys_user: ${err.message}`,
    }))

  if ("failure" in found) return { ok: false as const, error: found.failure }
  if (found.rows.length === 0)
    return {
      ok: false as const,
      error: `No sys_user matched ${query}. Pass a 32-character sys_id or an exact user_name.`,
    }

  const row = found.rows[0]
  const roles = await client
    .get("/api/now/table/sys_user_has_role", {
      params: {
        sysparm_query: `user=${row.sys_id}`,
        sysparm_fields: "role.name,inherited,granted_by.name",
        sysparm_display_value: "true",
        sysparm_limit: ROLE_PAGE,
      },
    })
    .then((r) => ({ rows: (r.data?.result ?? []) as Record<string, string>[] }))
    .catch((err: Error) => ({
      rows: [] as Record<string, string>[],
      failure: `Could not read sys_user_has_role: ${err.message}`,
    }))

  if ("failure" in roles) return { ok: false as const, error: roles.failure }

  return {
    ok: true as const,
    sys_id: row.sys_id,
    user_name: row.user_name,
    name: row.name,
    active: row.active === "true",
    roles: [...new Set(roles.rows.map((role) => role["role.name"]).filter(Boolean))].sort(),
    truncated: roles.rows.length === ROLE_PAGE,
    warning:
      found.rows.length > 1 ? `More than one sys_user matched ${query}; used ${row.user_name} (${row.sys_id}).` : "",
  }
}

function clip(value: string) {
  return value.length > 300 ? `${value.slice(0, 300)}… [${value.length} chars]` : value
}

export const version = "1.0.0"
export const author = "Serac SDK"
