/**
 * Tenant-scoping invariants for the blast-radius Phase-2 discovery cache key.
 *
 * `shared/deep-search.ts` holds the discovery cache in a process-global Map
 * that nothing else scopes, so the key built here is the entire isolation
 * boundary between tenants. These tests pin the property a future refactor is
 * most likely to break quietly: two tenants must never produce the same key,
 * and one tenant must keep producing the same key so the cache still works.
 *
 * The bug being pinned: the key used to be
 * `context.sessionId || context.instanceUrl || "default"`, which put every
 * tenant on a shared instance into one entry.
 */

import { describe, test, expect } from "@jest/globals"
import { discoveryCacheKey } from "../snow_blast_radius_dependents"
import { type ServiceNowContext } from "../../../shared/types"

const SHARED_INSTANCE = "https://shared.service-now.com"

const contextFor = (overrides: Partial<ServiceNowContext>): ServiceNowContext => ({
  instanceUrl: SHARED_INSTANCE,
  clientId: "oauth-client",
  clientSecret: "oauth-secret",
  ...overrides,
})

const tenantA = contextFor({ tenantId: "1042", origin: "http" })
const tenantB = contextFor({ tenantId: "2087", origin: "http" })

describe("discoveryCacheKey — tenant isolation", () => {
  test("two tenants on the same instance never share a key", () => {
    expect(discoveryCacheKey(tenantA)).not.toBe(discoveryCacheKey(tenantB))
  })

  test("the same tenant on the same instance always shares a key (the cache still caches)", () => {
    expect(discoveryCacheKey(tenantA)).toBe(discoveryCacheKey(contextFor({ tenantId: "1042", origin: "http" })))
  })

  test("one tenant across two instances gets two keys", () => {
    const otherInstance = contextFor({ tenantId: "1042", origin: "http", instanceUrl: "https://other.service-now.com" })
    expect(discoveryCacheKey(tenantA)).not.toBe(discoveryCacheKey(otherInstance))
  })

  test("the session is not part of the key — two chats in one tenant reuse the entry", () => {
    const chatOne = contextFor({ tenantId: "1042", origin: "http", sessionId: "user-42" })
    const chatTwo = contextFor({ tenantId: "1042", origin: "http", sessionId: "user-99" })
    expect(discoveryCacheKey(chatOne)).toBe(discoveryCacheKey(chatTwo))
    expect(discoveryCacheKey(chatOne)).toBe(discoveryCacheKey(tenantA))
  })

  test("regression: the key is never the bare instance URL and never the literal 'default'", () => {
    // Both were reachable before: `sessionId || instanceUrl || "default"`.
    for (const ctx of [tenantA, tenantB, contextFor({ origin: "stdio", tenantId: "stdio" })]) {
      expect(discoveryCacheKey(ctx)).not.toBe(SHARED_INSTANCE)
      expect(discoveryCacheKey(ctx)).not.toBe("default")
    }
  })

  test("every key carries its tenant in the first segment", () => {
    expect(discoveryCacheKey(tenantA).split("\x00")[0]).toBe("1042")
    expect(discoveryCacheKey(tenantB).split("\x00")[0]).toBe("2087")
  })
})

describe("discoveryCacheKey — separator spoofing", () => {
  test("a tenant id cannot smuggle the separator to land in another tenant's slot", () => {
    const honest = contextFor({ tenantId: "1042", origin: "http" })
    const spoofer = contextFor({ tenantId: `1042\x00${SHARED_INSTANCE}`, origin: "http", instanceUrl: "" })
    expect(discoveryCacheKey(spoofer)).not.toBe(discoveryCacheKey(honest))
  })

  test("tenant ids that differ only in separator characters stay distinct", () => {
    // A lossy `.replace(/[\x00:]/g, "_")` would map both of these to "1_2".
    const colon = contextFor({ tenantId: "1:2", origin: "http" })
    const nul = contextFor({ tenantId: "1\x002", origin: "http" })
    expect(discoveryCacheKey(colon)).not.toBe(discoveryCacheKey(nul))
  })

  test("the shift that naive concatenation cannot survive: NUL moved between the two halves", () => {
    // THIS is the shape that actually breaks a `${tenant}\x00${instance}` key.
    // Both of these flatten to the identical string "1042\x00X\x00Y" without
    // escaping, so tenant `1042\x00X` reads tenant `1042`'s entry. The two
    // spoofing tests above pass on the unescaped implementation as well
    // (their inputs differ in more than the separator's position), so without
    // this case the escaping is unpinned.
    const honest = contextFor({ tenantId: "1042", origin: "http", instanceUrl: "X\x00Y" })
    const spoofer = contextFor({ tenantId: "1042\x00X", origin: "http", instanceUrl: "Y" })
    expect(discoveryCacheKey(spoofer)).not.toBe(discoveryCacheKey(honest))
  })
})

describe("discoveryCacheKey — transports", () => {
  // Components are percent-encoded before being joined, so the key is opaque —
  // assert the properties, and reconstruct rather than hand-writing the string.
  const expectedKey = (tenant: string, instance: string): string =>
    `${encodeURIComponent(tenant)}\x00${encodeURIComponent(instance)}`

  test("stdio is single-tenant: a stable key, so the cache works across requests", () => {
    const stdioOne = contextFor({ tenantId: "stdio", origin: "stdio" })
    const stdioTwo = contextFor({ tenantId: "stdio", origin: "stdio", sessionId: "ses_abc" })
    expect(discoveryCacheKey(stdioOne)).toBe(expectedKey("stdio", SHARED_INSTANCE))
    expect(discoveryCacheKey(stdioTwo)).toBe(discoveryCacheKey(stdioOne))
  })

  test("stdio without an explicit tenantId still resolves to the stdio sentinel", () => {
    expect(discoveryCacheKey(contextFor({ origin: "stdio" }))).toBe(expectedKey("stdio", SHARED_INSTANCE))
  })

  test("a tenant-less HTTP caller does not land in the stdio bucket", () => {
    const unscoped = contextFor({ origin: "http" })
    expect(discoveryCacheKey(unscoped)).not.toBe(discoveryCacheKey(contextFor({ origin: "stdio" })))
    expect(discoveryCacheKey(unscoped).startsWith("cred\x00")).toBe(true)
  })
})

describe("discoveryCacheKey — fail-closed fallback", () => {
  // Reached only by an embedder calling the executor directly: both handlers
  // refuse an HTTP request whose resolver left tenantId empty. It must still
  // not degrade into a shared key.
  const unscoped = (overrides: Partial<ServiceNowContext>): ServiceNowContext =>
    contextFor({ origin: undefined, tenantId: undefined, ...overrides })

  test("different credentials on the same instance get different keys", () => {
    const one = unscoped({ clientId: "client-one", refreshToken: "rt-one" })
    const two = unscoped({ clientId: "client-two", refreshToken: "rt-two" })
    expect(discoveryCacheKey(one)).not.toBe(discoveryCacheKey(two))
  })

  test("the same credentials get the same key — bounded, one entry per identity", () => {
    const one = unscoped({ refreshToken: "rt-one" })
    const two = unscoped({ refreshToken: "rt-one" })
    expect(discoveryCacheKey(one)).toBe(discoveryCacheKey(two))
  })

  test("a rotated refresh token is a different identity", () => {
    expect(discoveryCacheKey(unscoped({ refreshToken: "rt-old" }))).not.toBe(
      discoveryCacheKey(unscoped({ refreshToken: "rt-new" })),
    )
  })

  test("basic-auth users on one shared OAuth app are not merged", () => {
    const alice = unscoped({ username: "alice", password: "pw-alice" })
    const bob = unscoped({ username: "bob", password: "pw-bob" })
    expect(discoveryCacheKey(alice)).not.toBe(discoveryCacheKey(bob))
  })

  test("the fingerprint does not leak the secrets it is built from", () => {
    const key = discoveryCacheKey(unscoped({ clientSecret: "super-secret-value", password: "hunter2" }))
    expect(key).not.toContain("super-secret-value")
    expect(key).not.toContain("hunter2")
    expect(key).toMatch(/^cred\x00[0-9a-f]{64}$/)
  })

  test("two tenants sharing an instance's OAuth app are separated by their access token", () => {
    // This is the only shape that actually reaches this branch in production.
    // serac-platform's runOssBlastRadius() builds exactly this context — no
    // tenantId, no origin — and takes clientId/clientSecret off the *instance*
    // record, so two tenants pointed at one shared instance present identical
    // OAuth client credentials. The access token is their only distinguishing
    // secret; a fingerprint that omits it merges them into one cache entry and
    // hands tenant B tenant A's private table names.
    const platformContext = (accessToken: string): ServiceNowContext => ({
      instanceUrl: SHARED_INSTANCE,
      accessToken,
      clientId: "instance-wide-client",
      clientSecret: "instance-wide-secret",
      sessionId: "org-33-7",
    })
    expect(discoveryCacheKey(platformContext("token-tenant-a"))).not.toBe(
      discoveryCacheKey(platformContext("token-tenant-b")),
    )
  })
})
