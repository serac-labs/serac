/**
 * Tests for snow_scripted_rest_api_manage that need no instance.
 *
 * Two things are worth pinning down here. The URL candidate list is the part of
 * the tool that decides which address it reports back and probes — get it wrong
 * and the tool confidently hands out a URL that 404s, which is precisely the
 * failure the tool exists to avoid. And the update-set classification is a
 * metadata-only property that is easy to get wrong by choosing the wrong
 * category: sys_ws_definition and sys_ws_operation are configuration, so a
 * create has to be gated by the update-set guard rather than sliding into the
 * Default update set untracked.
 */

import { describe, expect, test } from "bun:test"
import {
  ACTIONS,
  aclWarnings,
  buildResourceUrlCandidates,
  execute,
  toolDefinition,
} from "../servicenow-mcp-unified/tools/integration/snow_scripted_rest_api_manage"
import { requiresUpdateSet } from "../servicenow-mcp-unified/shared/update-set-guard"

describe("buildResourceUrlCandidates", () => {
  test("puts the URI ServiceNow computed first", () => {
    const candidates = buildResourceUrlCandidates({
      operationUri: "/api/x_snc_shop/orders/list",
      baseUri: "/api/x_snc_shop/orders",
      namespace: "x_snc_shop",
      serviceId: "orders",
      relativePath: "/list",
    })
    expect(candidates[0]).toBe("/api/x_snc_shop/orders/list")
  })

  test("does not double the slash when base_uri ends in one", () => {
    const candidates = buildResourceUrlCandidates({
      baseUri: "/api/x_snc_shop/orders/",
      relativePath: "/list",
    })
    expect(candidates).toEqual(["/api/x_snc_shop/orders/list"])
  })

  test("accepts a relative path written without a leading slash", () => {
    const candidates = buildResourceUrlCandidates({
      baseUri: "/api/x_snc_shop/orders",
      relativePath: "list",
    })
    expect(candidates).toEqual(["/api/x_snc_shop/orders/list"])
  })

  test("keeps the namespaced and unnamespaced fallbacks apart", () => {
    expect(
      buildResourceUrlCandidates({
        namespace: "x_snc_shop",
        serviceId: "orders",
        relativePath: "/list",
      }),
    ).toEqual(["/api/x_snc_shop/orders/list", "/api/orders/list"])
  })

  test("collapses candidates that resolve to the same URL", () => {
    const candidates = buildResourceUrlCandidates({
      operationUri: "/api/x_snc_shop/orders/list",
      baseUri: "/api/x_snc_shop/orders",
      namespace: "x_snc_shop",
      serviceId: "orders",
      relativePath: "/list",
    })
    expect(new Set(candidates).size).toBe(candidates.length)
    expect(candidates).toEqual(["/api/x_snc_shop/orders/list", "/api/orders/list"])
  })

  test("a root resource keeps the API's own base as its URL", () => {
    expect(
      buildResourceUrlCandidates({
        baseUri: "/api/x_snc_shop/orders",
        relativePath: "/",
      }),
    ).toEqual(["/api/x_snc_shop/orders"])
  })

  test("returns nothing rather than a bare /api when it knows nothing", () => {
    expect(buildResourceUrlCandidates({})).toEqual([])
  })
})

/**
 * The security warning is the tool's only statement about who can call the
 * endpoint it just built, and it used to be computed from the caller's argument:
 * ask for requires_acl_authorization=true and the warning disappeared, whether or
 * not the instance stored anything. The column is one this repo has never proven
 * against a live instance (shared/scripted-exec.ts names it in a comment and
 * deliberately does not send it), so "the caller asked for it" is exactly the
 * evidence that must not count.
 */
describe("aclWarnings", () => {
  test("silence is only earned by the instance saying the flag is on", () => {
    expect(aclWarnings(true, true)).toEqual([])
    expect(aclWarnings(false, true)).toEqual([])
  })

  test("asking for enforcement the instance did not store still warns", () => {
    const warnings = aclWarnings(true, false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("any authenticated user")
  })

  test("a column the instance never returned is unconfirmed, not off", () => {
    const missing = aclWarnings(true, undefined)
    expect(missing).toHaveLength(1)
    expect(missing[0]).toContain("unconfirmed")
    // The distinction has to survive into the text: "off" is a claim about the
    // instance, "unconfirmed" is a claim about what we were told.
    expect(aclWarnings(false, false)[0]).not.toContain("unconfirmed")
  })
})

describe("snow_scripted_rest_api_manage classification", () => {
  test("writing a Scripted REST API is gated by the update-set guard", () => {
    expect(requiresUpdateSet(toolDefinition, { action: "create" })).toBe(true)
    expect(requiresUpdateSet(toolDefinition, { action: "add_operation" })).toBe(true)
  })

  test("the read-only actions are not gated", () => {
    expect(requiresUpdateSet(toolDefinition, { action: "get" })).toBe(false)
    expect(requiresUpdateSet(toolDefinition, { action: "list" })).toBe(false)
    // "verify" only calls the endpoint back; it writes no configuration.
    expect(requiresUpdateSet(toolDefinition, { action: "verify" })).toBe(false)
  })

  test("every action the schema advertises is one the executor dispatches", () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(
      [...(toolDefinition.inputSchema.properties.action.enum as string[])].sort(),
    )
  })

  test("no field an update action can write advertises a schema default", () => {
    // A model that echoes a schema default while meaning to change one other
    // field is normal behaviour, and on the update actions it is destructive:
    // http_method and relative_path move a live endpoint, and
    // requires_acl_authorization=false disarms it. The create-side defaults live
    // in the executor, where they cannot be read back as an instruction.
    const properties = toolDefinition.inputSchema.properties as Record<string, { default?: unknown }>
    for (const field of [
      "name",
      "short_description",
      "active",
      "operation_name",
      "http_method",
      "relative_path",
      "operation_script",
      "requires_authentication",
      "requires_acl_authorization",
    ]) {
      expect(properties[field]).toBeDefined()
      expect(properties[field].default).toBeUndefined()
    }
  })

  test("an unknown action is rejected before anything touches the instance", async () => {
    // Deliberately unreachable credentials: if the executor authenticated first,
    // this would fail with a connection error instead of the argument error.
    const result = await execute(
      { action: "creat" },
      { instanceUrl: "https://unreachable.invalid", clientId: "", clientSecret: "" },
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("Unknown action: creat")
    expect(result.error).toContain("add_operation")
  })
})
