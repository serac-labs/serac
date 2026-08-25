/**
 * The pure halves of snow_query_table: the arguments it turns into Table API
 * parameters, and the total it reads back out of the response headers.
 *
 * Both were wrong in the same way — a plausible answer to a question nobody
 * asked. `order_by: "sys_created_on"` emitted `^ORDERBYASC<field>`; ASC is not
 * part of any ServiceNow operator, so the instance dropped the clause and
 * answered in whatever order it liked, and "give me the oldest record" came
 * back as an arbitrary one. The descending form, `ORDERBYDESC`, is spelled
 * correctly, which is why the bug survived: half the callers got what they
 * asked for. And `total` read `"100+"` whenever the page filled — a string
 * that is not the count and not a bound anyone measured.
 *
 * Neither needs an instance to detect. Both are visible in what the tool
 * builds before it sends anything.
 */

import { describe, expect, test } from "@jest/globals"
import { buildQueryParams, readTotal } from "../servicenow-mcp-unified/tools/operations/snow_query_table"

describe("buildQueryParams", () => {
  test("regression: ascending order emits ORDERBY, not ORDERBYASC", () => {
    expect(buildQueryParams({ table: "incident", order_by: "sys_created_on" }).params.sysparm_query).toBe(
      "ORDERBYsys_created_on",
    )
  })

  test("descending order emits ORDERBYDESC and strips the minus", () => {
    expect(buildQueryParams({ table: "incident", order_by: "-sys_created_on" }).params.sysparm_query).toBe(
      "ORDERBYDESCsys_created_on",
    )
  })

  test("the caller's own query survives alongside the ordering", () => {
    // The ordering is appended, never substituted: a filtered "oldest open
    // incident" has to stay filtered.
    expect(
      buildQueryParams({ table: "incident", query: "active=true^priority=1", order_by: "sys_created_on" }).params
        .sysparm_query,
    ).toBe("active=true^priority=1^ORDERBYsys_created_on")
  })

  test("no query and no ordering sends no sysparm_query at all", () => {
    expect(buildQueryParams({ table: "incident" }).params).not.toHaveProperty("sysparm_query")
  })

  test("a query with no ordering reaches the instance unchanged", () => {
    expect(buildQueryParams({ table: "incident", query: "active=true" }).params.sysparm_query).toBe("active=true")
  })

  test("sys_id is always in the field list, wherever the caller put it", () => {
    // Every follow-up operation needs it, and a caller asking for three
    // columns is not asking to be unable to act on the rows.
    expect(buildQueryParams({ table: "incident", fields: ["number", "state"] }).params.sysparm_fields).toBe(
      "sys_id,number,state",
    )
    expect(buildQueryParams({ table: "incident", fields: ["number", "sys_id"] }).params.sysparm_fields).toBe(
      "number,sys_id",
    )
  })

  test("fields as a comma-separated string is accepted rather than spread character by character", () => {
    expect(buildQueryParams({ table: "incident", fields: "number, state" }).params.sysparm_fields).toBe(
      "sys_id,number,state",
    )
  })

  test("the camelCase a model sends is read too", () => {
    const params = buildQueryParams({ table: "incident", orderBy: "-number", displayValue: true }).params
    expect(params.sysparm_query).toBe("ORDERBYDESCnumber")
    expect(params.sysparm_display_value).toBe("true")
  })

  test("display values are only requested when they were asked for", () => {
    expect(buildQueryParams({ table: "incident" }).params).not.toHaveProperty("sysparm_display_value")
  })

  test("a call with no table is refused rather than sent to /api/now/table/undefined", () => {
    expect(() => buildQueryParams({})).toThrow(/table is required/)
  })

  test("regression: a string offset is a number by the time anyone adds to it", () => {
    // `has_more` is `offset + records.length < total`. With the string an LLM
    // sends, that is `"100" + 25 === "10025"`, which is not less than 8123 —
    // so page two of a long table reports that there is nothing after it. The
    // instance accepts the string happily; only the arithmetic on this side
    // notices.
    const plan = buildQueryParams({ table: "incident", offset: "100", limit: "50" })

    expect(plan.offset).toBe(100)
    expect(plan.limit).toBe(50)
    expect(plan.offset + 25).toBe(125)
  })

  test("what is not a count falls back to the default rather than becoming one", () => {
    // Number(null) is 0 and Number("") is 0, and a limit of 0 asks the
    // instance for nothing at all.
    expect(buildQueryParams({ table: "incident", limit: null, offset: undefined }).limit).toBe(100)
    expect(buildQueryParams({ table: "incident", limit: "", offset: "  " }).limit).toBe(100)
    expect(buildQueryParams({ table: "incident", limit: "twenty" }).limit).toBe(100)
    expect(buildQueryParams({ table: "incident", offset: -5 }).offset).toBe(0)
    expect(buildQueryParams({ table: "incident", limit: 25.7 }).limit).toBe(25)
  })
})

describe("readTotal", () => {
  test("the header is the total", () => {
    expect(readTotal({ "x-total-count": "8123" })).toBe(8123)
  })

  test("regression: no header means no total, not a fabricated one", () => {
    // The field is omitted entirely by the caller when this is undefined. The
    // old behaviour returned the string "100+" as soon as the page filled,
    // which reads like an answer and is not one.
    expect(readTotal({})).toBeUndefined()
    expect(readTotal(undefined)).toBeUndefined()
  })

  test("a header that is not a count is not a count", () => {
    expect(readTotal({ "x-total-count": "" })).toBeUndefined()
    expect(readTotal({ "x-total-count": "many" })).toBeUndefined()
  })

  test("the capitalised spelling some proxies send is read as well", () => {
    expect(readTotal({ "X-Total-Count": "42" })).toBe(42)
  })
})
