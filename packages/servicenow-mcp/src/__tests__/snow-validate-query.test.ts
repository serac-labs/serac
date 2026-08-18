/**
 * The clause splitter behind snow_validate_query.
 *
 * The tool's whole value is that it does not cry wolf: a clause it reports as
 * an unknown field has to really be one, because the caller's next move is to
 * edit a query that was fine. Every case below is a way of getting that wrong,
 * and the four marked "regression" are ways the encoded-query parser private to
 * snow_manage_flow.ts (parseEncodedQuery, ~line 3921) gets it wrong today:
 *
 *   - splitting on a bare /\^OR/ turns "^ORDERBYnumber" into the clause
 *     "DERBYnumber", which reads as a misspelled field;
 *   - scanning a longest-first operator list and taking the first hit anywhere
 *     in the clause turns "short_description=IN PROGRESS" into field
 *     "short_description=" with operator IN, because IN is tried before =.
 *
 * Nothing here needs an instance: splitting is a pure function of the string,
 * and it runs before any dictionary lookup.
 */

import { describe, expect, test } from "@jest/globals"
import {
  countsContradictUnknown,
  parseQuery,
  toolDefinition,
} from "../servicenow-mcp-unified/tools/validators/snow_validate_query"

const fields = (query: string) => parseQuery(query).map((clause) => clause.field ?? null)
const unchecked = (query: string) => parseQuery(query).map((clause) => Boolean(clause.unchecked))

describe("parseQuery", () => {
  test("regression: ^ORDERBY is a sort directive, not an ^OR clause", () => {
    expect(fields("active=true^ORDERBYnumber")).toEqual(["active", null])
    expect(fields("active=true^ORDERBYDESCsys_created_on")).toEqual(["active", null])
    expect(unchecked("active=true^ORDERBYDESCsys_created_on")).toEqual([false, true])
  })

  test("^OR still separates a real or-clause", () => {
    expect(fields("active=true^ORstate=2")).toEqual(["active", "state"])
    expect(parseQuery("active=true^ORstate=2")[1]?.prefix).toBe("^OR")
  })

  test("regression: an operator word inside a value does not become the operator", () => {
    expect(parseQuery("short_description=IN PROGRESS")[0]).toMatchObject({
      field: "short_description",
      operator: "=",
      value: "IN PROGRESS",
    })
    expect(parseQuery("state=ON HOLD")[0]).toMatchObject({ field: "state", operator: "=", value: "ON HOLD" })
  })

  test("the longest operator wins when two start at the same position", () => {
    expect(parseQuery("priority>=2")[0]).toMatchObject({ operator: ">=", value: "2" })
    expect(parseQuery("sys_class_nameINSTANCEOFcmdb_ci_server")[0]).toMatchObject({
      field: "sys_class_name",
      operator: "INSTANCEOF",
    })
    expect(parseQuery("stateNOT IN1,2")[0]).toMatchObject({ field: "state", operator: "NOT IN" })
  })

  test("conditions inside a ^JOIN or RLQUERY block belong to another table and are not checked", () => {
    expect(unchecked("JOINincident.assignment_group=sys_user_group.sys_id!active=true^ENDJOIN^active=true")).toEqual([
      true,
      true,
      false,
    ])
    expect(unchecked("RLQUERYtask_ci.task,>0^ci_item.nameLIKEsrv^ENDRLQUERY^number=INC001")).toEqual([
      true,
      true,
      true,
      false,
    ])
  })

  test("an unterminated block suspends checking to the end rather than guessing", () => {
    expect(unchecked("JOINincident.caller_id=sys_user.sys_id!active=true^vip=true")).toEqual([true, true])
  })

  test("what lives outside sys_dictionary is unchecked, never unknown", () => {
    const parsed = parseQuery("assigned_to.department=x^variables.model=y^sys_tags=z^123TEXTQUERY321=printer")
    expect(parsed.map((clause) => clause.unchecked !== undefined)).toEqual([true, true, true, true])
    // The dot-walk still names its entry point, so the tool can say whether
    // `assigned_to` itself exists.
    expect(parsed[0]?.root).toBe("assigned_to")
    expect(parsed[1]?.root).toBeUndefined()
  })

  test("a javascript: value keeps its field checkable", () => {
    expect(parseQuery("caller_id=javascript:gs.getUserID()")[0]).toEqual({
      prefix: "",
      clause: "caller_id=javascript:gs.getUserID()",
      field: "caller_id",
      operator: "=",
      value: "javascript:gs.getUserID()",
    })
  })

  test("empty and terminator-only queries produce no clauses to check", () => {
    expect(parseQuery("")).toEqual([])
    expect(parseQuery("^EQ")).toEqual([])
    expect(fields("active=true^EQ")).toEqual(["active"])
  })

  test("a clause with no operator is unchecked instead of being read as a field", () => {
    expect(parseQuery("garbage")[0]).toMatchObject({ unchecked: "no encoded-query operator found in this clause" })
  })
})

/**
 * The tool used to keep its "unknown" verdict even when its own two count
 * queries had just disproved it: a clause that changes the number of matched
 * records is a clause the instance is filtering on, so the field exists and the
 * dictionary read missed it. That combination is unreachable under either
 * documented behaviour for an invalid clause, which is what makes it evidence.
 */
describe("countsContradictUnknown", () => {
  test("neither documented invalid-clause behaviour contradicts the verdict", () => {
    // Ignored: with and without the clause the query matches the same rows.
    expect(countsContradictUnknown(42, 42)).toBe(false)
    // glide.invalid_query.returns_no_rows: the query as written matches none.
    expect(countsContradictUnknown(0, 42)).toBe(false)
    expect(countsContradictUnknown(0, 0)).toBe(false)
  })

  test("a clause that moved the count is a clause the instance filtered on", () => {
    expect(countsContradictUnknown(3, 42)).toBe(true)
    // ^OR puts the unresolved clause on the widening side, so the count can also
    // drop when it is removed.
    expect(countsContradictUnknown(50, 42)).toBe(true)
  })

  test("a missing count proves nothing either way", () => {
    expect(countsContradictUnknown(null, 42)).toBe(false)
    expect(countsContradictUnknown(3, null)).toBe(false)
    expect(countsContradictUnknown(null, null)).toBe(false)
  })
})

describe("toolDefinition", () => {
  test("is read-only: it looks records up, it never selects them for change", () => {
    expect(toolDefinition.permission).toBe("read")
    expect(toolDefinition.allowedRoles).toContain("stakeholder")
  })
})
