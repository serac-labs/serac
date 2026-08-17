/**
 * The two resolution rules snow_describe_field exists for.
 *
 * Both are rules the rest of the repo gets wrong today, and both are pure
 * functions of rows already fetched — so they can be pinned without an
 * instance, and a regression in either is invisible from the tool's output
 * shape alone.
 *
 *   1. A child table's sys_choice rows *replace* its parent's for that element.
 *      Merging the two sets produces a list containing values the child cannot
 *      hold, which is worse than returning nothing: it reads as authoritative.
 *      snow_fsm_work_order_manage hardcodes its own state list under a TODO
 *      rather than reading this, so nothing else in the repo would catch it.
 *
 *   2. Dictionary overrides apply nearest-table-last. The override rows arrive
 *      in chain order (most-derived first) and are applied in reverse, so the
 *      override closest to the queried table survives. Applying them in the
 *      order received silently hands the win to the root class.
 *
 * The row shapes below are the two the Table API actually produces: plain
 * strings, and the `{ display_value, value }` cells that sysparm_display_value=all
 * returns. Both paths go through the same cell reader, so both are exercised.
 */

import { describe, expect, test } from "@jest/globals"
import { applyOverrides, readOverride, selectChoiceSet, toolDefinition } from "../servicenow-mcp-unified/tools/operations/snow_describe_field"

const choice = (table: string, value: string, label: string, extra: Record<string, string> = {}) => ({
  name: table,
  element: "state",
  value,
  label,
  sequence: "0",
  inactive: "false",
  language: "en",
  ...extra,
})

const cell = (value: string) => ({ display_value: value, value })

describe("selectChoiceSet", () => {
  test("a child table's choices replace its parent's, they are not merged", () => {
    const result = selectChoiceSet(
      ["incident", "task"],
      [
        choice("task", "1", "Open"),
        choice("task", "3", "Closed Complete"),
        choice("incident", "1", "New"),
        choice("incident", "6", "Resolved"),
      ],
      { language: "en", includeInactive: false },
    )

    expect(result.source_table).toBe("incident")
    expect(result.choices.map((entry) => entry.value)).toEqual(["1", "6"])
    expect(result.choices.map((entry) => entry.label)).toEqual(["New", "Resolved"])
    // The parent's set is reported as a count so the caller can see it exists,
    // but none of its values leak into the answer.
    expect(result.counts_by_table).toEqual([
      { table: "incident", count: 2 },
      { table: "task", count: 2 },
    ])
  })

  test("the parent's choices apply when the child defines none", () => {
    const result = selectChoiceSet(["incident", "task"], [choice("task", "1", "Open")], {
      language: "en",
      includeInactive: false,
    })

    expect(result.source_table).toBe("task")
    expect(result.choices.map((entry) => entry.value)).toEqual(["1"])
    expect(result.counts_by_table).toEqual([{ table: "task", count: 1 }])
  })

  test("a table with only inactive choices does not shadow its parent's list", () => {
    const result = selectChoiceSet(
      ["incident", "task"],
      [choice("incident", "9", "Retired", { inactive: "true" }), choice("task", "1", "Open")],
      { language: "en", includeInactive: false },
    )

    expect(result.source_table).toBe("task")
    expect(result.choices.map((entry) => entry.value)).toEqual(["1"])
    expect(result.inactive_excluded).toBe(1)
  })

  test("include_inactive_choices brings the inactive rows back and keeps the flag visible", () => {
    const result = selectChoiceSet(
      ["incident", "task"],
      [choice("incident", "9", "Retired", { inactive: "true" }), choice("task", "1", "Open")],
      { language: "en", includeInactive: true },
    )

    expect(result.source_table).toBe("incident")
    expect(result.choices).toEqual([
      { value: "9", label: "Retired", sequence: "0", inactive: "true", language: "en" },
    ])
  })

  test("rows in another language are excluded, rows with no language set are kept", () => {
    const result = selectChoiceSet(
      ["incident"],
      [
        choice("incident", "1", "Nieuw", { language: "nl" }),
        choice("incident", "1", "New"),
        choice("incident", "2", "In Progress", { language: "" }),
      ],
      { language: "en", includeInactive: false },
    )

    expect(result.choices.map((entry) => entry.label)).toEqual(["New", "In Progress"])
  })

  test("choices are ordered by sequence and each keeps its own dependent_value", () => {
    const result = selectChoiceSet(
      ["sc_cat_item"],
      [
        choice("sc_cat_item", "b", "Second", { sequence: "20", dependent_value: "hardware" }),
        choice("sc_cat_item", "a", "First", { sequence: "10", dependent_value: "software" }),
      ],
      { language: "en", includeInactive: false },
    )

    expect(result.choices.map((entry) => entry.value)).toEqual(["a", "b"])
    expect(result.choices.map((entry) => entry.dependent_value)).toEqual(["software", "hardware"])
  })

  test("a child whose choices exist only in another language is reported, not silently skipped", () => {
    // The dangerous case: the parent's list is returned for a child that has its own,
    // which is the union-vs-replace error inverted. Answering is fine; answering
    // without saying the child was dropped is not.
    const result = selectChoiceSet(
      ["incident", "task"],
      [choice("incident", "6", "Opgelost", { language: "nl" }), choice("task", "1", "Open")],
      { language: "en", includeInactive: false },
    )

    expect(result.source_table).toBe("task")
    expect(result.skipped_for_language).toEqual(["incident"])
  })

  test("a parent skipped for language is not reported — its list was never going to win", () => {
    const result = selectChoiceSet(
      ["incident", "task"],
      [choice("incident", "1", "New"), choice("task", "1", "Open", { language: "nl" })],
      { language: "en", includeInactive: false },
    )

    expect(result.source_table).toBe("incident")
    expect(result.skipped_for_language).toEqual([])
  })

  test("no rows anywhere on the chain leaves the source table unset rather than guessing one", () => {
    const result = selectChoiceSet(["incident", "task"], [], { language: "en", includeInactive: false })

    expect(result.source_table).toBeUndefined()
    expect(result.choices).toEqual([])
    expect(result.counts_by_table).toEqual([])
  })
})

describe("readOverride", () => {
  /**
   * The row below is ServiceNow's own, field for field: the sys_dictionary_override
   * shipped in the NeedIt training application, which overrides task.state to default
   * to 13. It is here because the flag columns are *suffixed* (`default_value_override`),
   * and an earlier version of this file looked for `override_default_value` — every
   * override silently produced an empty `sets` while the summary still reported
   * "1 dictionary override(s) applied".
   *
   * https://raw.githubusercontent.com/ServiceNow/devtraining-needit-utah/master/update/sys_dictionary_override_5bd046529f703200bde5f79ff57fcfe2.xml
   */
  test("a real sys_dictionary_override row yields the one attribute its flag marks", () => {
    const result = readOverride("x_58872_needit_needit", {
      name: cell("x_58872_needit_needit"),
      element: cell("state"),
      base_table: cell("task"),
      sys_id: cell("5bd046529f703200bde5f79ff57fcfe2"),
      attributes: cell(""),
      attributes_override: cell("false"),
      calculation: cell(""),
      calculation_override: cell("false"),
      default_value: cell("13"),
      default_value_override: cell("true"),
      dependent: cell(""),
      dependent_override: cell("false"),
      display_override: cell("false"),
      mandatory: cell("false"),
      mandatory_override: cell("false"),
      read_only: cell("false"),
      read_only_override: cell("false"),
      reference_qual: cell(""),
      reference_qual_override: cell("false"),
    })

    expect(result.sets).toEqual({ default_value: "13" })
    expect(result.base_table).toBe("task")
    expect(result.unpaired).toBeUndefined()
  })

  test("an attribute whose flag is false or empty is left to the base dictionary row", () => {
    const result = readOverride("incident", {
      name: cell("incident"),
      mandatory: cell("true"),
      mandatory_override: cell("true"),
      default_value: cell("1"),
      default_value_override: cell("false"),
      read_only: cell("true"),
      read_only_override: cell(""),
    })

    expect(result.sets).toEqual({ mandatory: "true" })
  })

  test("an override flag with no matching column is reported, not dropped", () => {
    // display_override is the real one: sys_dictionary_override carries the flag but
    // has no `display` column beside it, so this is expected output on such a row.
    const result = readOverride("incident", {
      name: cell("incident"),
      display_override: cell("true"),
    })

    expect(result.sets).toBeUndefined()
    expect(result.unpaired).toEqual(["display"])
  })

  test("plain (non display_value) rows read the same way", () => {
    const result = readOverride("change_request", {
      name: "change_request",
      read_only_override: "true",
      read_only: "true",
    })

    expect(result.sets).toEqual({ read_only: "true" })
  })
})

describe("applyOverrides", () => {
  test("the override nearest the queried table wins over an ancestor's", () => {
    // Chain order: incident, task. Both override default_value; incident is nearer.
    const merged = applyOverrides(
      { column_label: "State", default_value: "", mandatory: "false" },
      [
        { table: "incident", sets: { default_value: "1" } },
        { table: "task", sets: { default_value: "-5", mandatory: "true" } },
      ],
    )

    expect(merged.default_value).toBe("1")
    // An attribute only the ancestor overrides still applies.
    expect(merged.mandatory).toBe("true")
    // Attributes nobody overrides keep the base dictionary value.
    expect(merged.column_label).toBe("State")
  })

  test("no overrides leaves the base dictionary attributes untouched", () => {
    expect(applyOverrides({ mandatory: "false" }, [])).toEqual({ mandatory: "false" })
  })
})

describe("toolDefinition", () => {
  test("is a read tool — it must never be gated as a write, and must never write", () => {
    expect(toolDefinition.name).toBe("snow_describe_field")
    expect(toolDefinition.permission).toBe("read")
    expect(toolDefinition.allowedRoles).toContain("stakeholder")
    expect(toolDefinition.inputSchema.required).toEqual(["table", "field"])
  })
})
