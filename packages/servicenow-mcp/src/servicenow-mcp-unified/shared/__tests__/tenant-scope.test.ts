/**
 * The tenancy primitives every cache in this package now keys on.
 *
 * `shared/auth.ts` (OAuth tokens + authenticated Axios clients),
 * `shared/scripted-exec.ts`, `shared/update-set-guard.ts` and the blast-radius
 * discovery cache all compose their keys here, so a defect in these ~10 lines
 * is a cross-tenant defect in all four at once. Those call sites are covered
 * through their own behaviour elsewhere; this file pins the two properties they
 * all rely on, directly.
 */

import { describe, test, expect } from "@jest/globals"
import { STDIO_TENANT, resolveTenantScope, tenantScopedKey } from "../tenant-scope"

describe("resolveTenantScope — who is this request", () => {
  test("an explicit tenant id is returned verbatim", () => {
    // Verbatim matters: both readers of the enabled-tools store call this same
    // function, and any transform applied here but not there (an earlier
    // revision percent-encoded) puts writer and readers in different
    // namespaces. The portal emits colon-bearing ids, so a transform that only
    // shows up on exotic input would still fire in production.
    expect(resolveTenantScope({ tenantId: "c:1042", origin: "http" })).toBe("c:1042")
    expect(resolveTenantScope({ tenantId: "1042", origin: "http" })).toBe("1042")
  })

  test("stdio without a tenant id resolves to the single-tenant sentinel", () => {
    expect(resolveTenantScope({ origin: "stdio" })).toBe(STDIO_TENANT)
  })

  test("HTTP without a tenant id fails closed — never the sentinel", () => {
    expect(resolveTenantScope({ origin: "http" })).toBeUndefined()
  })

  test("no origin at all is unprovable, so also fails closed", () => {
    // An embedder calling a tool executor directly. We cannot show it is
    // single-tenant, so it gets no shared state.
    expect(resolveTenantScope({})).toBeUndefined()
  })

  test("an explicit tenant id wins over the transport", () => {
    expect(resolveTenantScope({ tenantId: "1042", origin: "stdio" })).toBe("1042")
  })
})

describe("tenantScopedKey — where does this go", () => {
  test("is injective: distinct component tuples never collide", () => {
    // The property that matters. `.replace(/[\x00:]/g, "_")`, which these call
    // sites used to do, fails it — "c:1042" and "c_1042" both became "c_1042",
    // and behind that key in auth.ts sits an OAuth token.
    const tuples: Array<[string, string]> = [
      ["c:1042", "inst"],
      ["c_1042", "inst"],
      ["c%3A1042", "inst"],
      ["1042", "X\x00Y"],
      ["1042\x00X", "Y"],
      ["1042", ""],
      ["", "1042"],
    ]
    const keys = tuples.map(([scope, part]) => tenantScopedKey(scope, part))
    expect(new Set(keys).size).toBe(tuples.length)
  })

  test("the separator survives no component: a segment can never shift", () => {
    expect(tenantScopedKey("1042\x00X", "Y")).not.toBe(tenantScopedKey("1042", "X\x00Y"))
    expect(tenantScopedKey("1042", "X").split("\x00").length).toBe(2)
    expect(tenantScopedKey("a\x00b\x00c", "d").split("\x00").length).toBe(2)
  })

  test("is stable — the same components always give the same key, or nothing caches", () => {
    expect(tenantScopedKey("1042", "https://x.service-now.com")).toBe(
      tenantScopedKey("1042", "https://x.service-now.com"),
    )
  })

  test("an absent component is not the string 'undefined'", () => {
    expect(tenantScopedKey("1042", undefined)).not.toBe(tenantScopedKey("1042", "undefined"))
    expect(tenantScopedKey("1042", undefined)).toBe(tenantScopedKey("1042", ""))
  })

  test("takes any number of components", () => {
    expect(tenantScopedKey("1042").split("\x00").length).toBe(1)
    expect(tenantScopedKey("1042", "session", "instance").split("\x00").length).toBe(3)
  })
})
