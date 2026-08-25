/**
 * Permission declaration test.
 *
 * `isWriteTool` (../instance-map-hook.ts) decides whether a call is a write by
 * reading the DECLARED `permission` string and nothing else:
 *
 *     const perm = definition.permission ?? "write"
 *     return perm === "write" || perm === "admin"
 *
 * Five separate protections consume that answer, so a tool that declares
 * "read" and then POSTs is invisible to all five at once:
 *
 *   1. the production write guard      — handlers/call-tool.ts
 *   2. its tool_execute mirror         — tools/meta/index.ts
 *   3. the active-update-set guard     — shared/update-set-guard.ts
 *   4. instance-map artifact reporting — shared/instance-map-hook.ts
 *   5. the stakeholder read-only check — shared/permission-validator.ts
 *
 * (5) is the defence-in-depth check written for exactly this mistake — its
 * comment says "Even if stakeholder is in allowedRoles (shouldn't happen),
 * never allow write or admin operations" — and it is defeated by the same
 * wrong declaration it was meant to catch.
 *
 * The permission field was originally bulk-assigned from a name heuristic;
 * 22 files still carry the comment "Read-only operation based on name
 * pattern". Nothing had ever compared the declaration to the code beneath it.
 *
 * This test does that comparison. It is a plain regex scan over the source —
 * no registry initialization — in the manner of transport-parity.test.ts.
 *
 * NOTE ON THE SIBLING TEST: stakeholder-write-protection.test.ts asserts
 * against hand-written MCPToolDefinition literals typed into that file. It can
 * never catch this class, because it never reads a real tool.
 */

import { describe, expect, test } from "@jest/globals"
import * as fs from "fs"
import * as path from "path"

const TOOLS_DIR = path.resolve(__dirname, "..", "..", "tools")

/**
 * Tools that declare `permission: "read"` and still issue a mutating verb,
 * each with the reason it has not been reclassified yet.
 *
 * This list is a ledger of open work, not a set of blessings. Entries leave it
 * by being fixed. Nothing should ever be ADDED to it: a new tool that writes
 * declares `permission: "write"`, and if it genuinely reads over POST it comes
 * here with its reason written down and reviewed.
 *
 * See serac-labs/serac#328.
 */
const KNOWN_READ_DECLARED_WRITERS = new Set<string>([
  // --- Reads that are POSTs by protocol. These are correct as "read". ---
  // GraphQL queries are POSTs by specification; the tool cannot mutate.
  "snow_graphql_query",

  // --- Pseudo-execution: the write is an insert into sys_script_execution(_history)
  // used to fake running a script. These tools report the insert as if it were
  // the result, so they need retiring rather than reclassifying — a different
  // decision, tracked separately. ---
  "snow_test_acl",
  "snow_collect_metric",
  "snow_validate_record",
  "snow_calculate_sla_duration",
  "snow_test_rest_connection",
  "snow_test_integration",

  // --- Arbitrary-method tools. Declaring these "write" would over-gate their
  // legitimate GET path behind __confirmProd. The fix is per-argument
  // classification (generalising SKIP_ACTIONS beyond args.action), which is a
  // design change and not a relabel. ---
  "snow_custom_api",
  "snow_scripted_rest_api",

  // --- Bounded self-cleanup: DELETEs only Serac's own SNOW_FLOW_EXEC_* marker
  // rows in sys_properties, never customer data. ---
  "snow_get_script_output",

  // --- Genuine writes awaiting reclassification. Each needs its own
  // updateSet call (configuration vs operational record) before it can flip,
  // which is why they are not in the first commit. ---
  "snow_velocity_tracking", // sn_devops_velocity
  "snow_event_handler", // sysevent_script_action — configuration
  "snow_send_notification", // sysevent_email_action — configuration
  "snow_send_push_notification", // sys_push_notification
  "snow_send_push",
  "snow_emergency_broadcast", // sysevent
  "snow_notification_preferences", // sys_user_preference
  "snow_run_discovery", // discovery_schedule_item
  "snow_error_handler", // sys_error_handler
  "snow_exception_handler", // syslog
  "snow_employee_offboarding", // sn_hr_core_case
  "snow_employee_onboarding", // sn_hr_le_onboarding
  "snow_pa_operate", // pa_scores, pa_collection_jobs
])

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (fs.statSync(full).isDirectory()) {
      if (entry !== "__tests__") walk(full, out)
      continue
    }
    if (entry.endsWith(".ts") && entry !== "index.ts") out.push(full)
  }
  return out
}

const MUTATING_CALL = /\bclient\.(post|put|patch|delete)\s*\(/g

interface Scanned {
  name: string
  file: string
  verbs: string[]
  stakeholder: boolean
}

const scan = (): Scanned[] => {
  const files = walk(TOOLS_DIR)
  return files.flatMap((file) => {
    const source = fs.readFileSync(file, "utf8")
    const permission = source.match(/\bpermission:\s*"(\w+)"/)
    if (!permission || permission[1] !== "read") return []
    const verbs = [...new Set([...source.matchAll(MUTATING_CALL)].map((m) => m[1]))].sort()
    if (verbs.length === 0) return []
    const name = source.match(/\bname:\s*"(snow_\w+)"/)
    const roles = source.match(/allowedRoles:\s*\[([^\]]*)\]/)
    return [
      {
        name: name ? name[1] : path.basename(file, ".ts"),
        file: path.relative(TOOLS_DIR, file),
        verbs,
        stakeholder: roles ? roles[1].includes("stakeholder") : false,
      },
    ]
  })
}

describe("permission declarations match the code", () => {
  const found = scan()

  test("no tool declares read and issues POST/PUT/PATCH/DELETE without being on the ledger", () => {
    const unlisted = found.filter((t) => !KNOWN_READ_DECLARED_WRITERS.has(t.name))
    const detail = unlisted
      .map((t) => `  ${t.name} (${t.file}) issues client.${t.verbs.join("/")} while declaring permission:"read"`)
      .join("\n")
    expect(
      unlisted.length === 0 ? "" : `\n${detail}\n\n` +
        `A tool that mutates must declare permission:"write" (and drop "stakeholder"\n` +
        `from allowedRoles, and choose an updateSet disposition). Every write guard\n` +
        `in this package keys on that declaration — see the header of this file.\n` +
        `Do not silence this by adding the tool to KNOWN_READ_DECLARED_WRITERS.\n`,
    ).toBe("")
  })

  test("the ledger has no stale entries", () => {
    const names = new Set(found.map((t) => t.name))
    const stale = [...KNOWN_READ_DECLARED_WRITERS].filter((n) => !names.has(n)).sort()
    expect(
      stale.length === 0 ? "" : `\nThese are on the ledger but no longer declare read-and-write:\n` +
        stale.map((n) => `  ${n}`).join("\n") +
        `\n\nRemove them from KNOWN_READ_DECLARED_WRITERS — the ledger is meant to shrink.\n`,
    ).toBe("")
  })

  test("the five tools fixed in #328 stay fixed", () => {
    const regressed = [
      "snow_security_risk_assessment",
      "snow_run_compliance_scan",
      "snow_scan_vulnerabilities",
      "snow_generate_records",
      "snow_auth_diagnostics",
    ].filter((n) => found.some((t) => t.name === n))
    expect(regressed).toEqual([])
  })

  test("the count of stakeholder-reachable read-declared writers only goes down", () => {
    // Being stakeholder-allowed is what makes this class exploitable rather
    // than merely untidy: a read-only role can reach a tool that writes. This
    // number is pinned exactly, so fixing one forces the constant down and
    // progress is visible in the diff. It must never be raised.
    const STAKEHOLDER_REACHABLE = 23
    const stakeholderWriters = found
      .filter((t) => t.stakeholder)
      .map((t) => t.name)
      .sort()
    expect({ count: stakeholderWriters.length, names: stakeholderWriters }).toEqual({
      count: STAKEHOLDER_REACHABLE,
      names: [...KNOWN_READ_DECLARED_WRITERS].sort(),
    })
  })
})
