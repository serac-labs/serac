/**
 * Blast-radius Phase-2 discovery cache: cross-tenant isolation, end to end.
 *
 * Runs the real `searchDependents()` against the real process-global discovery
 * cache in `shared/deep-search.ts`, keyed exactly the way the tool keys it
 * (`discoveryCacheKey(context)`), with two tenants whose ServiceNow users see
 * different things. The only stand-in is the ServiceNow REST client, which
 * `searchDependents` takes as a parameter — it plays the instance, returning
 * the rows that tenant's credentials would be allowed to read.
 *
 * Both failure directions of the old `sessionId || instanceUrl || "default"`
 * key are covered:
 *   1. confidentiality — a tenant inheriting another tenant's custom schema
 *      and then querying those private table names;
 *   2. correctness — a tenant with a narrow view priming the cache and
 *      silently shrinking every other tenant's blast radius for the TTL.
 *
 * Each test uses its own instance URL: the cache is module state with a
 * 5-minute TTL, so tests must not reuse keys.
 */

import { describe, test, expect, afterAll } from "@jest/globals"
import { clearDiscoveryCache, searchDependents } from "../shared/deep-search"
import { discoveryCacheKey } from "../snow_blast_radius_dependents"
import { type ServiceNowContext } from "../../../shared/types"

interface DictionaryRow {
  name: string
  element: string
  internal_type: string
}

/** The (table, field) pairs tenant A's admin integration user can see. */
const ADMIN_VIEW: DictionaryRow[] = [
  { name: "u_acme_secret_engine", element: "script", internal_type: "script" },
  { name: "u_acme_payroll_hook", element: "script", internal_type: "script" },
]

/** Tenant B's integration user is restricted and sees no custom script tables. */
const RESTRICTED_VIEW: DictionaryRow[] = []

/**
 * Stands in for the ServiceNow instance. Answers the Phase-2 discovery query
 * with whatever this caller's credentials are allowed to see, and records
 * every table it was asked about so we can prove what leaked.
 */
const instanceFor = (visibleRows: DictionaryRow[]) => {
  const calls: string[] = []
  return {
    calls,
    get: async (url: string, config?: any) => {
      calls.push(url)
      const isDiscovery = config?.params?.sysparm_fields === "name,element,internal_type"
      return { data: { result: isDiscovery ? visibleRows : [] } }
    },
    queriedDictionary(): boolean {
      return calls.some((c) => c.includes("sys_dictionary"))
    },
    queriedTablesMatching(fragment: string): string[] {
      return calls.filter((c) => c.includes(fragment))
    },
  }
}

const contextFor = (tenantId: string, instanceUrl: string): ServiceNowContext => ({
  instanceUrl,
  clientId: `client-${tenantId}`,
  clientSecret: `secret-${tenantId}`,
  tenantId,
  origin: "http",
})

const searchOptions = { patterns: [{ like: "AcmeUtils" }], limit: 50, phase3Concurrency: 5 }

const scan = (instance: ReturnType<typeof instanceFor>, context: ServiceNowContext) =>
  searchDependents(instance, discoveryCacheKey(context), searchOptions)

describe("discovery cache — confidentiality", () => {
  test("a second tenant on the same instance does not inherit the first tenant's schema", async () => {
    const shared = "https://confidentiality.service-now.com"
    const admin = instanceFor(ADMIN_VIEW)
    const restricted = instanceFor(RESTRICTED_VIEW)

    const a = await scan(admin, contextFor("tenant-a", shared))
    const b = await scan(restricted, contextFor("tenant-b", shared))

    // Tenant A primes the cache with its own view.
    expect(a.stats.phase_2.cached).toBe(false)
    expect(a.stats.phase_2.discovered_pairs).toBe(ADMIN_VIEW.length)

    // Tenant B must do its own discovery, not read A's entry.
    expect(b.stats.phase_2.cached).toBe(false)
    expect(b.stats.phase_2.discovered_pairs).toBe(RESTRICTED_VIEW.length)
    expect(restricted.queriedDictionary()).toBe(true)

    // And must never have been handed A's private custom table names.
    expect(restricted.queriedTablesMatching("u_acme")).toEqual([])
    expect(b.stats.phase_3.tables).toBe(0)
  })
})

describe("discovery cache — correctness", () => {
  test("a narrow tenant priming the cache does not shrink another tenant's blast radius", async () => {
    const shared = "https://correctness.service-now.com"
    const restricted = instanceFor(RESTRICTED_VIEW)
    const admin = instanceFor(ADMIN_VIEW)

    const b = await scan(restricted, contextFor("tenant-b", shared))
    const a = await scan(admin, contextFor("tenant-a", shared))

    expect(b.stats.phase_2.discovered_pairs).toBe(0)

    // The admin tenant still discovers and scans its own long tail. Under the
    // old shared key this was 0 pairs / 0 tables for five minutes, and the
    // result still looked like a complete answer.
    expect(admin.queriedDictionary()).toBe(true)
    expect(a.stats.phase_2.cached).toBe(false)
    expect(a.stats.phase_2.discovered_pairs).toBe(ADMIN_VIEW.length)
    expect(a.stats.phase_3.tables).toBe(ADMIN_VIEW.length)
    expect(admin.queriedTablesMatching("u_acme_secret_engine").length).toBe(1)
  })
})

describe("discovery cache — the cache still caches", () => {
  test("the same tenant reuses its entry on a second scan", async () => {
    const instanceUrl = "https://reuse.service-now.com"
    const first = instanceFor(ADMIN_VIEW)
    const second = instanceFor(ADMIN_VIEW)
    const context = contextFor("tenant-a", instanceUrl)

    const one = await scan(first, context)
    const two = await scan(second, context)

    expect(one.stats.phase_2.cached).toBe(false)
    expect(two.stats.phase_2.cached).toBe(true)
    expect(second.queriedDictionary()).toBe(false)
    expect(two.stats.phase_2.discovered_pairs).toBe(ADMIN_VIEW.length)
  })

  test("two chats in one tenant share the entry — the key ignores the session", async () => {
    const instanceUrl = "https://sessions.service-now.com"
    const chatOne = instanceFor(ADMIN_VIEW)
    const chatTwo = instanceFor(ADMIN_VIEW)
    const base = contextFor("tenant-a", instanceUrl)

    const one = await scan(chatOne, { ...base, sessionId: "user-42" })
    const two = await scan(chatTwo, { ...base, sessionId: "user-99" })

    expect(one.stats.phase_2.cached).toBe(false)
    expect(two.stats.phase_2.cached).toBe(true)
    expect(chatTwo.queriedDictionary()).toBe(false)
  })
})

describe("discovery cache — bounded growth", () => {
  // The TTL only gates freshness on READ: before pruning, an entry whose
  // tenant never came back was never deleted, only ever overwritten. Each
  // entry holds up to 5000 dictionary rows, and the credential-fingerprint
  // fallback mints a new key on every OAuth token rotation, so "one entry per
  // (tenant, instance)" was not a bound in the one long-lived process this
  // matters in — the multi-tenant HTTP server.
  afterAll(() => clearDiscoveryCache())

  test("distinct tenants past the ceiling evict the oldest, not the newest", async () => {
    clearDiscoveryCache()
    const shared = "https://bounded.service-now.com"
    const scanAs = (tenant: string) => scan(instanceFor(RESTRICTED_VIEW), contextFor(tenant, shared))

    const first = "tenant-0000"
    await scanAs(first)
    expect((await scanAs(first)).stats.phase_2.cached).toBe(true)

    // MAX_DISCOVERY_ENTRIES is 500; go past it with live (unexpired) entries
    // so the age-out branch cannot do the work and only the ceiling can.
    for (let i = 1; i <= 600; i++) await scanAs(`tenant-${String(i).padStart(4, "0")}`)

    // The oldest is gone — a cache that never evicts would still hit here.
    expect((await scanAs(first)).stats.phase_2.cached).toBe(false)
    // The most recent is still there, so the eviction is oldest-first and the
    // cache has not simply been emptied.
    expect((await scanAs("tenant-0600")).stats.phase_2.cached).toBe(true)
  })
})
