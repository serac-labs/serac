/**
 * The set of ACL names `snow_acl_explain` looks for is the whole tool: whatever is missing from that list
 * is a rule the report cannot name, and the report exists to name the rule that is blocking someone.
 *
 * Both bugs this replaces are in the tree today. `snow_table_schema_discovery` queries
 * `name=<t>^ORname=*<t>.*`, whose second clause is a literal equality against the string `*incident.*` and
 * therefore matches nothing on any instance — the ACL name column holds literal names, never glob patterns.
 * And a report that stops at `<table>.<field>` names the wrong blocker in exactly the case it exists for:
 * when the rule with the roles on it sits on a parent table or on a wildcard.
 *
 * Nothing here needs an instance — the name set is derived from the table chain, which the executor reads
 * separately.
 */

import { describe, expect, test } from "bun:test"
import { aclCandidateNames } from "../servicenow-mcp-unified/tools/access-control/snow_acl_explain"

// A literal ACL name: a table or field identifier, or `*` in either position. Anything else is a pattern
// that will silently match zero rows through the Table API.
const LITERAL_NAME = /^(\*|[a-z0-9_$]+)(\.(\*|[a-z0-9_$]+))?$/

describe("aclCandidateNames", () => {
  test("covers all six field levels, most specific first", () => {
    expect(aclCandidateNames("incident", ["task"], "priority").field).toEqual([
      "incident.priority",
      "task.priority",
      "*.priority",
      "incident.*",
      "task.*",
      "*.*",
    ])
  })

  test("covers the table, every ancestor and the wildcard at record level", () => {
    expect(aclCandidateNames("sc_req_item", ["task"], "").record).toEqual(["sc_req_item", "task", "*"])
  })

  test("asks for no field-level names when no field was given", () => {
    expect(aclCandidateNames("incident", ["task"], "").field).toEqual([])
  })

  test("keeps every ancestor in the chain, not just the nearest one", () => {
    const names = aclCandidateNames("sn_hr_core_case", ["task", "sys_metadata"], "state")
    expect(names.field).toContain("sys_metadata.state")
    expect(names.record).toContain("sys_metadata")
  })

  test("collapses a table that repeats in the chain instead of querying it twice", () => {
    const names = aclCandidateNames("incident", ["incident", "task"], "priority")
    expect(names.record).toEqual(["incident", "task", "*"])
    expect(names.field.filter((name) => name === "incident.priority")).toHaveLength(1)
  })

  test("emits only literal names — a wildcard belongs in a position, never inside one", () => {
    const names = aclCandidateNames("incident", ["task"], "priority")
    ;[...names.record, ...names.field].forEach((name) => expect(name).toMatch(LITERAL_NAME))
  })
})
