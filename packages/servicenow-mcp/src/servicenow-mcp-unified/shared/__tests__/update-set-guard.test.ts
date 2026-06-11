/**
 * Update-set guard tests.
 *
 * Covers the two halves of shared/update-set-guard.ts: the conservative
 * config-write classification (requiresUpdateSet) and the session-scoped
 * state machine the call-tool handler drives (guardKey / updateSetActive /
 * recordUpdateSetSkip / observeUpdateSetTool).
 */

import { describe, test, expect, beforeEach } from "@jest/globals"
import {
  guardKey,
  observeUpdateSetTool,
  recordUpdateSetSkip,
  requiresUpdateSet,
  resetUpdateSetState,
  updateSetActive,
} from "../update-set-guard"
import { MCPToolDefinition } from "../types"

function definition(overrides: Partial<MCPToolDefinition>): MCPToolDefinition {
  return {
    name: "snow_test_tool",
    description: "test tool",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  }
}

describe("requiresUpdateSet — classification", () => {
  test("a config-category write tool is gated", () => {
    const def = definition({ name: "snow_flow_manage", category: "development", permission: "write" })
    expect(requiresUpdateSet(def, { action: "update" })).toBe(true)
  })

  test("permission defaults to write when omitted", () => {
    const def = definition({ name: "snow_create_widget", category: "ui-frameworks" })
    expect(requiresUpdateSet(def, {})).toBe(true)
  })

  test("read tools are never gated", () => {
    const def = definition({ name: "snow_query_table", category: "development", permission: "read" })
    expect(requiresUpdateSet(def, {})).toBe(false)
  })

  test("data-category writes are exempt (itsm, cmdb, ...)", () => {
    expect(requiresUpdateSet(definition({ name: "snow_incident_manage", category: "itsm", permission: "write" }), {})).toBe(false)
    expect(requiresUpdateSet(definition({ name: "snow_ci_manage", category: "cmdb", permission: "write" }), {})).toBe(false)
  })

  test("data-shaped subcategories inside config categories are exempt", () => {
    const def = definition({
      name: "snow_import_rows",
      category: "integration",
      subcategory: "import-export",
      permission: "write",
    })
    expect(requiresUpdateSet(def, {})).toBe(false)
  })

  test("the update-set tools themselves are never gated", () => {
    const def = definition({ name: "snow_ensure_active_update_set", category: "development", permission: "write" })
    expect(requiresUpdateSet(def, {})).toBe(false)
  })

  test("local-only sync tools are exempt", () => {
    const def = definition({ name: "snow_pull_artifact", category: "development", permission: "write" })
    expect(requiresUpdateSet(def, {})).toBe(false)
  })

  test("read-shaped actions on a write tool are exempt", () => {
    const def = definition({ name: "snow_flow_manage", category: "development", permission: "write" })
    expect(requiresUpdateSet(def, { action: "list" })).toBe(false)
    expect(requiresUpdateSet(def, { action: "get" })).toBe(false)
  })

  test("updateSet overrides beat the category defaults in both directions", () => {
    const forced = definition({ name: "snow_data_thing", category: "itsm", permission: "write", updateSet: "required" })
    expect(requiresUpdateSet(forced, {})).toBe(true)

    const released = definition({ name: "snow_config_thing", category: "development", permission: "write", updateSet: "exempt" })
    expect(requiresUpdateSet(released, {})).toBe(false)
  })

  test("missing definition is not gated", () => {
    expect(requiresUpdateSet(undefined, {})).toBe(false)
  })
})

describe("guard state — session lifecycle", () => {
  const key = guardKey("42", "session-a", "https://dev1.service-now.com")

  beforeEach(() => {
    resetUpdateSetState()
  })

  test("a fresh session has no active update set", () => {
    expect(updateSetActive(key)).toBe(false)
  })

  test("a successful ensure lifts the guard; complete re-arms it", () => {
    observeUpdateSetTool(
      "snow_ensure_active_update_set",
      { name: "Feature: approval step" },
      { success: true, data: { sys_id: "abc123", name: "Feature: approval step" } },
      key,
    )
    expect(updateSetActive(key)).toBe(true)

    observeUpdateSetTool(
      "snow_update_set_manage",
      { action: "complete", update_set_id: "abc123" },
      { success: true, data: { sys_id: "abc123", state: "complete" } },
      key,
    )
    expect(updateSetActive(key)).toBe(false)
  })

  test("create and switch lift the guard", () => {
    observeUpdateSetTool(
      "snow_update_set_manage",
      { action: "create", name: "Feature: x" },
      { success: true, data: { sys_id: "u1", name: "Feature: x" } },
      key,
    )
    expect(updateSetActive(key)).toBe(true)

    resetUpdateSetState()
    observeUpdateSetTool(
      "snow_update_set_manage",
      { action: "switch", update_set_id: "u2" },
      { success: true, data: { sys_id: "u2", name: "Feature: y" } },
      key,
    )
    expect(updateSetActive(key)).toBe(true)
  })

  test("a create that does not switch tracking does not lift the guard", () => {
    observeUpdateSetTool(
      "snow_update_set_manage",
      { action: "create", name: "Feature: x", auto_switch: false },
      { success: true, data: { sys_id: "u1", name: "Feature: x" } },
      key,
    )
    expect(updateSetActive(key)).toBe(false)
  })

  test("an ensure without user sync does not lift the guard", () => {
    observeUpdateSetTool(
      "snow_ensure_active_update_set",
      { name: "Feature: x", sync_with_user: false },
      { success: true, data: { sys_id: "u1", name: "Feature: x" } },
      key,
    )
    expect(updateSetActive(key)).toBe(false)
  })

  test("failed tool results never lift the guard", () => {
    observeUpdateSetTool(
      "snow_ensure_active_update_set",
      { name: "Feature: x" },
      { success: false, error: "boom" },
      key,
    )
    expect(updateSetActive(key)).toBe(false)
  })

  test("verifying a current non-Default set lifts the guard; Default does not", () => {
    observeUpdateSetTool(
      "snow_update_set_query",
      { action: "current" },
      { success: true, data: { sys_id: "d1", name: "Default" } },
      key,
    )
    expect(updateSetActive(key)).toBe(false)

    observeUpdateSetTool(
      "snow_update_set_query",
      { action: "current" },
      { success: true, data: { sys_id: "u9", name: "Sprint 12 fixes" } },
      key,
    )
    expect(updateSetActive(key)).toBe(true)
  })

  test("an explicit user decline is remembered for the session", () => {
    recordUpdateSetSkip(key)
    expect(updateSetActive(key)).toBe(true)
  })

  test("state never crosses sessions, tenants, or instances", () => {
    recordUpdateSetSkip(key)
    expect(updateSetActive(guardKey("42", "session-b", "https://dev1.service-now.com"))).toBe(false)
    expect(updateSetActive(guardKey("43", "session-a", "https://dev1.service-now.com"))).toBe(false)
    expect(updateSetActive(guardKey("42", "session-a", "https://dev2.service-now.com"))).toBe(false)
  })

  test("non-update-set tools never touch the state", () => {
    observeUpdateSetTool(
      "snow_flow_manage",
      { action: "update" },
      { success: true, data: { sys_id: "f1", name: "Some flow" } },
      key,
    )
    expect(updateSetActive(key)).toBe(false)
  })
})
