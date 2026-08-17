/**
 * The two pure halves of snow_aggregate_metrics: the arguments it turns into
 * Aggregate API parameters, and the payload it turns back into rows.
 *
 * Both are the bug this tool shipped with. It sent `sysparm_query: ""` however
 * it was called, so a filtered COUNT quietly counted the whole table, and the
 * only aggregate parameter it ever sent was sysparm_count, so an AVG asked the
 * API to average nothing and still reported success. Neither failure needs an
 * instance to detect: the first is visible in the parameters, the second in
 * how the response is read.
 *
 * The fixture in the second block is the grouped-average response body from
 * the Aggregate API reference, not an invented one:
 * https://www.servicenow.com/docs/bundle/zurich-api-reference/page/integrate/inbound-rest/concept/c_AggregateAPI.html
 */

import { describe, expect, test } from "@jest/globals"
import {
  buildStatsParams,
  readStats,
  resolveMaxGroups,
} from "../servicenow-mcp-unified/tools/aggregators/snow_aggregate_metrics"

describe("buildStatsParams", () => {
  test("regression: the caller's filter reaches sysparm_query", () => {
    expect(buildStatsParams({ query: "active=true^priority=1" }).params).toMatchObject({
      sysparm_query: "active=true^priority=1",
      sysparm_count: "true",
    })
  })

  test("no filter sends no sysparm_query at all, rather than an empty one", () => {
    expect(buildStatsParams({}).params).not.toHaveProperty("sysparm_query")
  })

  test("regression: each aggregation carries the field in its own documented parameter", () => {
    expect(buildStatsParams({ aggregation: "AVG", field: "reassignment_count" }).params).toMatchObject({
      sysparm_avg_fields: "reassignment_count",
    })
    expect(buildStatsParams({ aggregation: "SUM", field: "business_stc" }).params).toMatchObject({
      sysparm_sum_fields: "business_stc",
    })
    expect(buildStatsParams({ aggregation: "MIN", field: "business_stc" }).params).toMatchObject({
      sysparm_min_fields: "business_stc",
    })
    expect(buildStatsParams({ aggregation: "MAX", field: "business_stc" }).params).toMatchObject({
      sysparm_max_fields: "business_stc",
    })
  })

  test("COUNT sends no field list even when a field is passed", () => {
    const params = buildStatsParams({ aggregation: "COUNT", field: "reassignment_count" }).params
    expect(Object.keys(params).filter((key) => key.endsWith("_fields"))).toEqual([])
  })

  test("several fields go into one comma-separated list", () => {
    expect(buildStatsParams({ aggregation: "AVG", field: "business_stc, reassignment_count" }).params).toMatchObject({
      sysparm_avg_fields: "business_stc,reassignment_count",
    })
  })

  test("an aggregation that needs a field refuses to run without one", () => {
    expect(() => buildStatsParams({ aggregation: "AVG" })).toThrow(/needs a field/)
    expect(() => buildStatsParams({ aggregation: "SUM", field: "  " })).toThrow(/needs a field/)
  })

  test("an unsupported aggregation is refused instead of silently aggregating nothing", () => {
    expect(() => buildStatsParams({ aggregation: "MEDIAN", field: "business_stc" })).toThrow(/must be one of/)
  })

  test("the case a model sends is accepted", () => {
    expect(buildStatsParams({ aggregation: "avg", field: "business_stc" }).aggregation).toBe("AVG")
  })

  test("a filter that is not a string is refused rather than sent as [object Object]", () => {
    // The stringified version reaches sysparm_query as an unparseable encoded
    // query, and the caller would read the answer as a filtered number.
    expect(() => buildStatsParams({ query: { active: true } })).toThrow(/query must be an encoded query string/)
    expect(() => buildStatsParams({ having: 3 })).toThrow(/having must be/)
  })

  test("group_by stays lenient, because a list of field names stringifies correctly", () => {
    expect(buildStatsParams({ group_by: ["assignment_group", "state"] }).params.sysparm_group_by).toBe(
      "assignment_group,state",
    )
  })

  test("display_value takes the boolean a model sends as well as the API's own values", () => {
    expect(buildStatsParams({ display_value: true }).params.sysparm_display_value).toBe("true")
    expect(buildStatsParams({ display_value: "all" }).params.sysparm_display_value).toBe("all")
    expect(buildStatsParams({ display_value: false }).params).not.toHaveProperty("sysparm_display_value")
  })
})

describe("readStats", () => {
  const grouped = [
    {
      stats: { avg: { business_stc: "804162.7143", reassignment_count: "1.0000" } },
      groupby_fields: [{ value: "", field: "assignment_group" }],
    },
  ]

  test("a grouped average is read out of stats.avg.<field>", () => {
    expect(readStats(grouped, "AVG", ["business_stc"])[0]).toMatchObject({
      group: { assignment_group: "" },
      value: "804162.7143",
    })
  })

  test("an aggregate the instance did not return stays undefined, never 0", () => {
    const row = readStats(grouped, "SUM", ["business_stc"])[0]
    expect(row?.value).toBeUndefined()
    // The raw stats still travel back, so the caller can see what did come.
    expect(row?.stats).toEqual(grouped[0].stats)
  })

  test("an ungrouped response is a single object, not an array", () => {
    expect(readStats({ stats: { count: "249" } }, "COUNT", [])).toEqual([
      { group: undefined, count: "249", value: "249", stats: { count: "249" } },
    ])
  })

  test("no matching records is an empty list, not a row of zeroes", () => {
    expect(readStats([], "COUNT", [])).toEqual([])
    expect(readStats(undefined, "COUNT", [])).toEqual([])
  })

  test("a group label uses the display value when the instance sends one", () => {
    const row = readStats(
      [
        {
          stats: { count: "3" },
          groupby_fields: [{ field: "assignment_group", value: "abc123", display_value: "Network" }],
        },
      ],
      "COUNT",
      [],
    )[0]
    expect(row?.group).toEqual({ assignment_group: "Network" })
  })
})

describe("resolveMaxGroups", () => {
  test("a value that is not a row count falls back to the default instead of becoming NaN", () => {
    // Math.max(1, Number("all")) is NaN and slice(0, NaN) is [], so this used
    // to return zero rows and then report that the instance answered nothing.
    expect(resolveMaxGroups("all")).toBe(100)
    expect(resolveMaxGroups("")).toBe(100)
    expect(resolveMaxGroups({})).toBe(100)
    expect(resolveMaxGroups(undefined)).toBe(100)
    expect(resolveMaxGroups(-5)).toBe(100)
  })

  test("a usable cap is kept", () => {
    expect(resolveMaxGroups(25)).toBe(25)
    expect(resolveMaxGroups("25")).toBe(25)
  })
})
