/**
 * `tool_search` / `tool_execute`: session-enablement honesty and tenant scoping.
 *
 * Two properties are pinned here, both of which a refactor breaks silently:
 *
 *   1. The enabled-tools store is per (tenant, session). Two tenants that
 *      happen to share a session id — the portal derives it from the portal
 *      user id, so collisions across deployments are not exotic — must never
 *      see each other's enablement.
 *   2. `tool_search` only reports enabling what the next request will honour.
 *      On a server whose catalog is registered non-deferred (which is what
 *      `transports/http-entry.ts` does, deliberately) enabling changes
 *      nothing, so the tool must not say it enabled anything.
 *
 * Everything runs against the real `MemoryToolSessionStore` — the same
 * tenant-scoped store the HTTP transport installs — so the assertions are
 * about real stored state, not about what the code intended to store.
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll } from "@jest/globals"
import { tool_search_exec, tool_execute_exec } from "../index"
import { ToolSearch, setSessionStore } from "../../../shared/tool-search"
import { FileToolSessionStore, MemoryToolSessionStore } from "../../../shared/tool-session-store"
import { toolRegistry } from "../../../shared/tool-registry"
import { listTools } from "../../../handlers/list-tools"
import { MCPPromptManager } from "../../../../shared/mcp-prompt-manager"
import { type RequestContext, type ServiceNowContext } from "../../../shared/types"

const SESSION = "user-42"

/** Same session id in both tenants — the collision the store must survive. */
const tenantA: ServiceNowContext = {
  instanceUrl: "https://tenant-a.service-now.com",
  clientId: "a",
  clientSecret: "a",
  tenantId: "1042",
  origin: "http",
  sessionId: SESSION,
}

const tenantB: ServiceNowContext = { ...tenantA, instanceUrl: "https://tenant-b.service-now.com", tenantId: "2087" }

const stdioContext: ServiceNowContext = {
  instanceUrl: "https://dev12345.service-now.com",
  clientId: "a",
  clientSecret: "a",
  tenantId: "stdio",
  origin: "stdio",
  sessionId: "ses_local",
}

const INDEXED = [
  { id: "snow_query_incidents", description: "Query incidents", category: "itsm", keywords: ["incident"] },
  { id: "snow_create_incident", description: "Create an incident", category: "itsm", keywords: ["incident"] },
]

const registerIndex = (deferred: boolean): void => {
  ToolSearch.clearIndex()
  ToolSearch.registerTools(INDEXED.map((entry) => ({ ...entry, deferred })))
}

beforeEach(() => {
  // The tenant-scoped in-memory store the HTTP transport installs. Also keeps
  // the suite off the developer's ~/.local/share tool-enablement files.
  setSessionStore(new MemoryToolSessionStore())
})

afterAll(() => {
  // `ToolSearch.clearIndex()` / `registerTools()` / `setSessionStore()` all
  // mutate process globals. Put them back so a future suite that expects a
  // populated index or the default file-backed store is not silently
  // order-dependent on this one.
  ToolSearch.clearIndex()
  setSessionStore(new FileToolSessionStore())
})

describe("tool_search — a deferred catalog (stdio): enablement is real, so say so", () => {
  beforeEach(() => registerIndex(true))

  test("writes the hits to the session store and reports them", async () => {
    const result = await tool_search_exec({ query: "incident" }, stdioContext)

    expect(result.enabled).toBe(true)
    expect(result.enabled_tools).toEqual(["snow_query_incidents", "snow_create_incident"])
    expect(result.usage_hint).toContain("are now ENABLED for this session")
    expect(result.tools.map((t: any) => t.status)).toEqual(["[ENABLED]", "[ENABLED]"])

    const stored = await ToolSearch.getEnabledTools("ses_local", "stdio")
    expect(Array.from(stored).sort()).toEqual(["snow_create_incident", "snow_query_incidents"])
  })

  test("reported status matches what the rest of the server will compute", async () => {
    const result = await tool_search_exec({ query: "incident" }, stdioContext)
    for (const tool of result.tools) {
      expect(tool.status).toBe(await ToolSearch.getToolStatus("ses_local", tool.name, "stdio"))
    }
  })

  test("enable:false changes nothing and claims nothing", async () => {
    const result = await tool_search_exec({ query: "incident", enable: false }, stdioContext)

    expect(result.enabled).toBe(false)
    expect(result.usage_hint).not.toContain("ENABLED")
    expect(result.tools.map((t: any) => t.status)).toEqual(["[DEFERRED]", "[DEFERRED]"])
    expect((await ToolSearch.getEnabledTools("ses_local", "stdio")).size).toBe(0)
  })

  test("a later search reports tools an earlier search enabled", async () => {
    await tool_search_exec({ query: "query incidents", limit: 1 }, stdioContext)
    const second = await tool_search_exec({ query: "incident", enable: false }, stdioContext)

    const byName = Object.fromEntries(second.tools.map((t: any) => [t.name, t.status]))
    expect(byName["snow_query_incidents"]).toBe("[ENABLED]")
    expect(byName["snow_create_incident"]).toBe("[DEFERRED]")
  })
})

describe("tool_search — a non-deferred catalog (HTTP as shipped): claim nothing, store nothing", () => {
  beforeEach(() => registerIndex(false))

  test("does not touch session state", async () => {
    const result = await tool_search_exec({ query: "incident" }, tenantA)

    expect(result.enabled).toBe(false)
    expect(result.enabled_tools).toEqual([])
    expect((await ToolSearch.getEnabledTools(SESSION, "1042")).size).toBe(0)
  })

  test("does not tell the model it enabled anything", async () => {
    const result = await tool_search_exec({ query: "incident" }, tenantA)

    expect(result.usage_hint).not.toContain("ENABLED")
    expect(result.usage_hint).toContain("No session state was changed")
    expect(result.tools.map((t: any) => t.status)).toEqual(["[AVAILABLE]", "[AVAILABLE]"])
  })
})

describe("tool_search — tenant scoping", () => {
  beforeEach(() => registerIndex(true))

  test("two tenants sharing a session id do not share enabled tools", async () => {
    await tool_search_exec({ query: "incident" }, tenantA)

    expect((await ToolSearch.getEnabledTools(SESSION, "1042")).size).toBe(2)
    expect((await ToolSearch.getEnabledTools(SESSION, "2087")).size).toBe(0)

    const forB = await tool_search_exec({ query: "incident", enable: false }, tenantB)
    expect(forB.tools.map((t: any) => t.status)).toEqual(["[DEFERRED]", "[DEFERRED]"])
  })

  test("an HTTP request with no tenant refuses to enable rather than sharing a bucket", async () => {
    const unscoped: ServiceNowContext = { ...tenantA, tenantId: undefined }
    const result = await tool_search_exec({ query: "incident" }, unscoped)

    expect(result.enabled).toBe(false)
    expect(result.enabled_tools).toEqual([])
    expect(result.usage_hint).toContain("no tenant scope")
    expect(result.tools.map((t: any) => t.status)).toEqual(["[DEFERRED]", "[DEFERRED]"])
    // Nothing was parked in the stdio sentinel bucket either.
    expect((await ToolSearch.getEnabledTools(SESSION, "stdio")).size).toBe(0)
  })

  test("a request with no session id says the tools stayed deferred", async () => {
    const sessionless: ServiceNowContext = { ...tenantA, sessionId: undefined }
    const result = await tool_search_exec({ query: "incident" }, sessionless)

    expect(result.enabled).toBe(false)
    expect(result.usage_hint).toContain("no session id")
    expect(result.usage_hint).not.toContain("are now ENABLED")
    expect(result.tools.map((t: any) => t.status)).toEqual(["[DEFERRED]", "[DEFERRED]"])
  })

  test("stdio without an explicit tenant still gets its single-tenant bucket", async () => {
    const result = await tool_search_exec({ query: "incident" }, { ...stdioContext, tenantId: undefined })

    expect(result.enabled).toBe(true)
    expect((await ToolSearch.getEnabledTools("ses_local", "stdio")).size).toBe(2)
  })
})

describe("tool_execute — the enablement gate is tenant-scoped too", () => {
  beforeAll(async () => {
    await toolRegistry.initialize()
  })

  beforeEach(() => {
    ToolSearch.clearIndex()
    ToolSearch.registerTools([
      {
        id: "snow_query_table",
        description: "Query any table",
        category: "operations",
        keywords: ["query", "table"],
        deferred: true,
      },
    ])
  })

  test("a tool enabled by one tenant is not executable by another with the same session", async () => {
    await tool_search_exec({ query: "snow_query_table" }, tenantA)
    expect(await ToolSearch.getToolStatus(SESSION, "snow_query_table", "1042")).toBe("[ENABLED]")

    const result = await tool_execute_exec({ tool: "snow_query_table", args: { table: "incident" } }, tenantB)

    expect(result.success).toBe(false)
    expect(result.error).toContain("must be enabled first")
    expect(result.status).toBe("[DEFERRED]")
  })

  test("a tenant-less HTTP request cannot execute a deferred tool at all", async () => {
    await tool_search_exec({ query: "snow_query_table" }, tenantA)

    const result = await tool_execute_exec(
      { tool: "snow_query_table", args: { table: "incident" } },
      { ...tenantA, tenantId: undefined },
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain("must be enabled first")
  })

  test("a tenant-less request does not INHERIT the stdio bucket that a real stdio session filled", async () => {
    // The test above passes even without the fail-closed rule, because the
    // bucket a non-failing version falls back into ("stdio") happens to be
    // empty there — it refuses for the wrong reason. Fill that bucket under
    // the SAME session id first, and only a genuinely fail-closed
    // implementation still refuses.
    await tool_search_exec({ query: "snow_query_table" }, { ...stdioContext, sessionId: SESSION })
    expect(await ToolSearch.getToolStatus(SESSION, "snow_query_table", "stdio")).toBe("[ENABLED]")

    const result = await tool_execute_exec(
      { tool: "snow_query_table", args: { table: "incident" } },
      { ...tenantA, tenantId: undefined },
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain("must be enabled first")
  })
})

describe("tool_search — the registry-fallback branch", () => {
  // `searchResults.length === 0` sends tool_search to a direct registry scan.
  // Hits there usually have NO index entry, and both list-tools.ts and
  // canExecuteTool() treat an unknown tool as deferred — so they DO need
  // enabling. Nothing exercised this branch, which left the `?? true` default
  // in enablementIsHonoured() free to become `?? false` with a green suite.
  beforeAll(async () => {
    await toolRegistry.initialize()
  })

  beforeEach(() => {
    // A populated index that cannot match the query below, so the search falls
    // through to the registry while `indexStats.total > 0` stays true.
    //
    // It has to share no WORD with "snow_query_table", not merely fail a
    // substring test: this used to hold snow_query_incidents, which the old
    // substring ranker could not match against the whole query string but the
    // token-level one matches on "query" — a real hit, and the fallback branch
    // then never ran.
    ToolSearch.clearIndex()
    ToolSearch.registerTools([
      {
        id: "snow_sp_widget_clone",
        description: "Clone a Service Portal widget",
        category: "service-portal",
        keywords: [],
        deferred: true,
      },
    ])
  })

  test("enables registry hits that have no index entry, and says so", async () => {
    const result = await tool_search_exec({ query: "snow_query_table" }, stdioContext)

    expect(ToolSearch.getToolFromIndex("snow_query_table")).toBeUndefined()
    expect(result.enabled).toBe(true)
    expect(result.enabled_tools).toContain("snow_query_table")
    expect(result.usage_hint).toContain("are now ENABLED for this session")

    const stored = await ToolSearch.getEnabledTools("ses_local", "stdio")
    expect(stored.has("snow_query_table")).toBe(true)
  })

  test("what it enabled there is executable — the two paths agree on 'unknown means deferred'", async () => {
    const before = await tool_execute_exec({ tool: "snow_query_table", args: {} }, stdioContext)
    expect(before.success).toBe(false)
    expect(before.error).toContain("must be enabled first")

    await tool_search_exec({ query: "snow_query_table" }, stdioContext)

    // Past the gate now. The executor itself fails on credentials (no live
    // instance), which is a different failure and the one we want to see.
    const after = await tool_execute_exec({ tool: "snow_query_table", args: {} }, stdioContext)
    expect(after.error ?? "").not.toContain("must be enabled first")
  })
})

describe("tool_search writes the scope that tools/list reads", () => {
  // The regression this pins: the writer resolved its scope with
  // `encodeURIComponent(tenantId)` while both readers used the raw id, so on a
  // tenant id containing a character encodeURIComponent touches, tool_search
  // reported [ENABLED] and the very next tools/list omitted the tool. The
  // portal's deriveTenantId() emits `c:<customerId>` / `o:<organizationId>`,
  // and ":" is exactly such a character — so this was production-shaped, not
  // theoretical. Driving the real listTools handler is the point: asserting
  // against ToolSearch directly would just re-run the writer's own arithmetic.
  const COLON_TENANT = "c:1042"

  const contextWithTenant = (tenantId: string): RequestContext => ({
    sessionId: SESSION,
    origin: "http",
    serviceNow: {
      instanceUrl: "https://tenant-a.service-now.com",
      clientId: "a",
      clientSecret: "a",
      tenantId,
      origin: "http",
      sessionId: SESSION,
    },
  })

  const listFor = async (tenantId: string): Promise<string[]> => {
    const handler = listTools({
      resolveContext: async () => contextWithTenant(tenantId),
      promptManager: new MCPPromptManager("test"),
    })
    const response = await handler({})
    return response.tools.map((tool: any) => tool.name)
  }

  beforeAll(async () => {
    await toolRegistry.initialize()
  })

  beforeEach(() => {
    ToolSearch.clearIndex()
    ToolSearch.registerTools([
      { id: "snow_query_table", description: "Query any table", category: "operations", keywords: [], deferred: true },
    ])
  })

  test("a tool enabled for a colon-bearing tenant actually appears in that tenant's tools/list", async () => {
    expect(await listFor(COLON_TENANT)).not.toContain("snow_query_table")

    const search = await tool_search_exec({ query: "snow_query_table" }, contextWithTenant(COLON_TENANT).serviceNow)
    expect(search.enabled_tools).toContain("snow_query_table")
    expect(search.tools.map((t: any) => t.status)).toContain("[ENABLED]")

    expect(await listFor(COLON_TENANT)).toContain("snow_query_table")
  })

  test("and it does not appear for a different tenant sharing the session id", async () => {
    await tool_search_exec({ query: "snow_query_table" }, contextWithTenant(COLON_TENANT).serviceNow)
    expect(await listFor("c:2087")).not.toContain("snow_query_table")
  })
})
