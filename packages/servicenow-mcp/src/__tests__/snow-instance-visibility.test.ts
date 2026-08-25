/**
 * snow_instance_visibility, driven end to end.
 *
 * Nothing is mocked. The verdicts are pinned against real payload shapes in
 * `shared/__tests__/setup-doctor.test.ts`, where the classifiers are pure; what
 * is left to prove is the part no pure test can see — that the tool reaches the
 * instance through the shared authenticated client, that a refusal on one table
 * does not take the call down, and that the numbers it reports are the ones the
 * instance sent. So the instance is a real HTTP server on loopback, the same
 * way the setup doctor's own end-to-end runs work, and the tool talks to it
 * over basic auth through `getAuthenticatedClient`.
 *
 * The interesting shape is deliberately mixed: one readable table, one 403, a
 * date canary that resolves, an instance that ignores an unknown column. A run
 * where everything works proves less than one where something does not.
 *
 * Four of the instances below are the failures the pure tests could not see,
 * because in every one of them the classifier was already right and the path
 * feeding it was wrong: a sleeping instance whose HTML page never reached
 * `htmlDiagnosis`, a refused held-role read that arrived as an empty list, a
 * dead credential that failed before any probe ran, and a bounded count that
 * came back 0 from a column the table does not have.
 */

import { describe, expect, test } from "@jest/globals"
import * as http from "http"

import {
  execute,
  toolDefinition,
  type Visibility,
} from "../servicenow-mcp-unified/tools/platform/snow_instance_visibility"
import { type ServiceNowContext } from "../servicenow-mcp-unified/shared/types"

const USER = `{"result":[{"sys_id":"6816f79cc0a8016401c5a33be04be441","user_name":"serac.integration","name":"Serac Integration","active":"true","sys_domain":"global","sys_domain.name":"TOP/Acme"}]}`
const ROLES = `{"result":[{"role.name":"itil"},{"role.name":"update_set_admin"},{"role.name":"snc_internal"}]}`
const PROPERTIES = `{"result":[{"name":"glide.buildname","value":"Zurich"},{"name":"glide.buildtag","value":"glide-zurich-06-25-2026__patch2.zip"},{"name":"glide.license.edition","value":"Enterprise"},{"name":"glide.product.description","value":"Service Management"}]}`
const INSUFFICIENT_RIGHTS = `{"error":{"message":"Insufficient rights to query records","detail":"Field(s) present in the query do not have permission to be read"},"status":"failure"}`
const UNAUTHORIZED = `{"error":{"message":"User Not Authenticated","detail":"Required to provide Auth information"},"status":"failure"}`
const ROW = `{"result":[{"sys_id":"46b66a40a9fe198101f243dfbc79033d"}]}`

/**
 * What a hibernating developer instance answers to every request, REST
 * included: HTTP 200, an HTML login page, no x-total-count.
 */
const HIBERNATING = `<!DOCTYPE html><html><head><title>Instance Hibernating page</title></head><body><h2>This instance is hibernating</h2><p>Please log in to wake it up.</p></body></html>`

/** How many rows sys_user holds. The canaries are read against this number. */
const USERS = 1247

interface Answer {
  status: number
  body: string
  total?: string
  contentType?: string
}

/**
 * An instance that can read sys_update_xml and refuses sys_update_set, applies
 * date functions, and ignores a condition on a column it does not have.
 */
const instance = (url: string): Answer => {
  const path = decodeURIComponent(url)
  if (path.includes("sys_user_has_role")) return { status: 200, body: ROLES, total: "3" }
  if (path.includes("sys_properties")) return { status: 200, body: PROPERTIES, total: "4" }
  if (path.includes("v_plugin"))
    return path.includes("com.glide.domain")
      ? { status: 200, body: ROW, total: "1" }
      : { status: 200, body: ROW, total: "412" }
  if (path.includes("sys_update_set")) return { status: 403, body: INSUFFICIENT_RIGHTS }
  if (path.includes("sys_update_xml")) return { status: 200, body: ROW, total: "8123" }
  if (path.includes("sys_user")) {
    // The self-contradictory clause matches nothing, which is what a working
    // date function does. The unknown column is ignored and the condition
    // falls away, so that read answers for the whole table.
    if (path.includes("daysAgoStart")) return { status: 200, body: `{"result":[]}`, total: "0" }
    return { status: 200, body: USER, total: String(USERS) }
  }
  return { status: 404, body: `{"error":{"message":"No such table"}}` }
}

/** The same instance, except that reading sys_user_has_role is refused. */
const rolesRefused = (url: string): Answer =>
  decodeURIComponent(url).includes("sys_user_has_role") ? { status: 403, body: INSUFFICIENT_RIGHTS } : instance(url)

/** A hibernating instance: one HTML page, 200, for everything that is asked. */
const hibernating = (): Answer => ({ status: 200, body: HIBERNATING, contentType: "text/html" })

/** A credential the instance no longer accepts anywhere. */
const dead = (): Answer => ({ status: 401, body: UNAUTHORIZED })

/**
 * An instance in the `returns_no_rows` regime, holding a view with no
 * `sys_created_on`: the bounded count answers 0 for a table with 412 rows in
 * it. Neither invalid-query regime answers 400, so nothing about the response
 * says the clause was never applied.
 */
const noDateColumn = (url: string): Answer => {
  const path = decodeURIComponent(url)
  if (path.includes("u_genuinely_empty")) return { status: 200, body: `{"result":[]}`, total: "0" }
  if (path.includes("v_plugin") && path.includes("daysAgoStart")) return { status: 200, body: `{"result":[]}`, total: "0" }
  return instance(url)
}

const start = async (answer: (url: string) => Answer) => {
  const hits: string[] = []
  const sockets = new Set<import("net").Socket>()
  const server = http.createServer((req, res) => {
    hits.push(decodeURIComponent(req.url ?? ""))
    const reply = answer(req.url ?? "")
    res.writeHead(reply.status, {
      "content-type": reply.contentType ?? "application/json",
      ...(reply.total === undefined ? {} : { "x-total-count": reply.total }),
    })
    res.end(reply.body)
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
  const address = server.address()

  return {
    url: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`,
    hits,
    stop: () =>
      new Promise<void>((done) => {
        sockets.forEach((socket) => socket.destroy())
        server.close(() => done())
      }),
  }
}

const credentials = (url: string): ServiceNowContext => ({
  instanceUrl: url,
  clientId: "",
  clientSecret: "",
  username: "serac.integration",
  password: "not-a-real-password",
})

describe("snow_instance_visibility against an instance", () => {
  test("reports reach, roles, per-table access, both canaries and identity in one call", async () => {
    const server = await start(instance)

    const result = await execute(
      { tables: ["sys_update_xml", "sys_update_set"], lifetime_days: 365 },
      credentials(server.url),
    )
    const data = result.data as Visibility

    // A 403 on one table is an answer, not a failed call.
    expect(result.success).toBe(true)
    expect(data.reach.code).toBe("api-ok")

    expect(data.roles?.held).toEqual(["itil", "snc_internal", "update_set_admin"])
    expect(data.roles?.heldTruncated).toBe(false)
    expect(data.roles?.heldReadable).toBe(true)
    expect(data.roles?.coverage?.resolved).toBeGreaterThan(100)
    expect(data.roles?.manifest.validatedOn).toContain("glide-")

    expect(data.tables[0]).toMatchObject({
      table: "sys_update_xml",
      readable: true,
      lifetime: 8123,
      lifetimeWindowDays: 365,
      // The held update_set_admin covers this one, and a readable table is
      // never advised about roles anyway.
      missingRoles: [],
    })
    expect(data.tables[1]).toMatchObject({ table: "sys_update_set", readable: false, httpStatus: 403 })
    expect(data.tables[1]?.error).toContain("Insufficient rights")
    // The 403 is role-shaped and the held list came back complete, so a
    // subtraction is allowed here. It comes out empty because the account
    // already holds update_set_admin — the refusal is about something else.
    expect(data.tables[1]?.missingRoles).toEqual([])

    expect(data.dateFunctions).toMatchObject({ verdict: "resolved", canary: 0, total: USERS })
    expect(data.invalidQuery).toMatchObject({ verdict: "ignores", matched: USERS, total: USERS })

    expect(data.identity).toMatchObject({
      release: "Zurich",
      productDescription: "Service Management",
      edition: "Enterprise",
      pluginCount: 412,
      domainSeparated: "separated",
      integrationUserDomain: "TOP/Acme",
    })

    // The summary is what a person reads; the diagnosis must be in it rather
    // than only in the payload.
    expect(result.summary).toContain("sys_update_xml")
    expect(result.summary).toContain("Insufficient rights")
    expect(result.summary).toContain("Zurich")

    await server.stop()
  }, 30000)

  test("it never asks for the integration account's name, and never reports one", async () => {
    // Pinned on the REQUEST as well as the response, because the field list is
    // the control: this output is stored and rendered rather than read once by
    // the person who owns the credential, so the login and the human name
    // behind it must not be collected at all. The fixture below sends both
    // anyway — an instance answers what it likes — which is exactly why the
    // response is checked too.
    const server = await start(instance)

    const result = await execute({ tables: [] }, credentials(server.url))
    const reach = server.hits.find((hit) => hit.includes("gs.getUserID()"))
    const fields = new URL(`http://instance${reach}`).searchParams.get("sysparm_fields")

    // `active` stays: it is not personal, and it carries "that account is
    // marked inactive", which is a real cause of an instance answering nothing.
    expect(fields?.split(",")).toEqual(["active", "sys_domain", "sys_domain.name"])
    expect(JSON.stringify(result)).not.toContain("Serac Integration")
    expect(JSON.stringify(result)).not.toContain("serac.integration")
    // The fact, not the person. classifyApiResponse still names the account for
    // the stdio doctor, which prints it to whoever owns that credential.
    expect((result.data as Visibility).reach.title).toBe("The REST API accepted this credential.")

    await server.stop()
  }, 30000)

  test("a refused held-role read is reported as unknown, never as an account with no roles", async () => {
    // Reading sys_user_has_role needs a role of its own. Before this, a 403
    // there produced held: [], heldTruncated: false and a coverage block —
    // byte-identical to an account that genuinely holds nothing, with a
    // blocked count computed from a refusal and a missing-role sentence naming
    // roles the account may already hold.
    const server = await start(rolesRefused)

    const result = await execute({ tables: ["sys_update_set"] }, credentials(server.url))
    const data = result.data as Visibility

    expect(result.success).toBe(true)
    expect(data.roles).toMatchObject({ held: [], heldTruncated: false, heldReadable: false, heldHttpStatus: 403 })
    expect(data.roles?.coverage).toBeUndefined()
    // The manifest would name update_set_admin here, which this account holds.
    expect(data.tables[0]?.missingRoles).toEqual([])

    expect(result.summary).toContain("not an account that holds nothing")
    expect(result.summary).not.toContain("resolvable tools in reach")
    expect(result.summary).not.toContain("ask an admin for one of")

    await server.stop()
  }, 30000)

  test("a hibernating instance is diagnosed as hibernating, not as a broken network", async () => {
    // 13 of 14 production instances are developer PDIs, which hibernate. They
    // answer 200 with an HTML login page, and the shared client used to throw
    // a TypeError assigning `result` onto that string body — a synthetic error
    // with no `.response`, so every probe filed it as a transport failure and
    // htmlDiagnosis, exported for exactly this page, never ran.
    const server = await start(hibernating)

    const result = await execute({ tables: ["sys_update_xml"] }, credentials(server.url))
    const data = result.data as Visibility

    expect(result.success).toBe(true)
    expect(data.reach.code).toBe("instance-hibernating")
    expect(data.reach.title).toBe("The instance is hibernating.")
    expect(JSON.stringify(result)).not.toContain("TypeError")

    // A 200 that is not a read is the one row a consumer cannot classify from
    // the status, so the html code rides along with it.
    expect(data.tables[0]).toMatchObject({
      table: "sys_update_xml",
      readable: false,
      httpStatus: 200,
      code: "instance-hibernating",
      lifetime: null,
    })
    // Same page, same reasoning: parsing it yields no rows, which is not an
    // account that holds no roles.
    expect(data.roles?.heldReadable).toBe(false)
    expect(data.roles?.coverage).toBeUndefined()

    expect(result.summary).toContain("hibernating")

    await server.stop()
  }, 30000)

  test("a table that failed because the instance is asleep is not a missing-role problem", async () => {
    // include_role_coverage is off, so the held list is not the thing
    // withholding the advice — the shape of the failure is. Sending someone to
    // an admin for update_set_previewer because their PDI is asleep is the
    // wrong request to the wrong person.
    const server = await start(hibernating)

    const result = await execute(
      { tables: ["sys_update_xml"], include_role_coverage: false },
      credentials(server.url),
    )
    const data = result.data as Visibility

    expect(data.roles).toBeUndefined()
    expect(data.tables[0]?.missingRoles).toEqual([])
    expect(result.summary).not.toContain("ask an admin for one of")

    await server.stop()
  }, 30000)

  test("a 403 with the held list turned off still names the roles that could read the table", async () => {
    // The other edge of the same rule, and the one over-suppression would
    // silently take away: with include_role_coverage off there is no list to
    // subtract from, and the schema says what happens then — every role that
    // could read it, rather than none.
    const server = await start(instance)

    const result = await execute(
      { tables: ["sys_update_set"], include_role_coverage: false },
      credentials(server.url),
    )
    const data = result.data as Visibility

    expect(data.tables[0]?.missingRoles).toContain("update_set_admin")
    expect(result.summary).toContain("ask an admin for one of")

    await server.stop()
  }, 30000)

  test("a dead credential carries its status in the metadata, not only in a sentence", async () => {
    // Every endpoint answers 401, so the client is never built and no probe
    // runs. The platform has to separate "the credential is dead" from "the
    // instance could not be reached" — one is a re-auth, the other is a
    // network — and regexing an error message is not a way to do that.
    const server = await start(dead)

    const result = await execute({ tables: ["sys_user"] }, credentials(server.url))

    expect(result.success).toBe(false)
    expect(result.metadata?.http_status).toBe(401)
    expect(result.error).toContain("No authenticated client")
    // One request: the credential test. Nothing below it was attempted.
    expect(server.hits.length).toBe(1)

    await server.stop()
  }, 30000)

  test("an unreachable instance has no status to report, and does not invent one", async () => {
    // The other side of the test above: without a response there is no
    // http_status at all, which is how a caller tells the two apart.
    const result = await execute({ tables: [] }, credentials("http://127.0.0.1:1"))

    expect(result.success).toBe(false)
    expect(result.metadata?.http_status).toBeUndefined()
  }, 30000)

  test("a bounded count of zero is re-read unbounded before it is believed", async () => {
    // sys_created_on>=javascript:gs.daysAgoStart(N) on a table that has no
    // sys_created_on: under `ignores` the clause is dropped and the whole-table
    // count comes back wearing the window's label, under `returns_no_rows` it
    // comes back 0 on a full table. Neither answers 400, which was the only
    // trigger for the unbounded re-read — so a view reported
    // {readable: true, lifetime: 0, lifetimeWindowDays: 365} in the same
    // payload whose identity block counted 412 active plugins.
    const server = await start(noDateColumn)

    const result = await execute(
      { tables: ["v_plugin", "u_genuinely_empty"], lifetime_days: 365 },
      credentials(server.url),
    )
    const data = result.data as Visibility

    expect(data.tables[0]).toMatchObject({
      table: "v_plugin",
      readable: true,
      lifetime: 412,
      // Null, not 365: after a zero nothing here can show the window was ever
      // applied, and a number under a window it did not apply is the bug.
      lifetimeWindowDays: null,
    })
    expect(data.identity?.pluginCount).toBe(412)

    // The re-read must not turn every zero into a number. A table that is
    // empty unbounded too is still empty, and says so.
    expect(data.tables[1]).toMatchObject({ table: "u_genuinely_empty", readable: true, lifetime: 0 })

    await server.stop()
  }, 30000)

  test("the canaries are counted against the whole table, not the bounded window", async () => {
    // A total already narrowed to lifetime_days describes a different
    // population than the clause under test, and "the clause matched
    // everything" is only a statement when both sides cover the same rows.
    const server = await start(instance)

    await execute({ tables: [], lifetime_days: 90 }, credentials(server.url))
    const canaryReads = server.hits.filter((hit) => hit.includes("sys_user?") || hit.includes("sys_user&"))

    expect(canaryReads.some((hit) => hit.includes("daysAgoStart(90)"))).toBe(false)
    expect(canaryReads.some((hit) => hit.includes("serac_canary_no_such_field=1"))).toBe(true)

    await server.stop()
  }, 30000)

  test("more tables than the cap is refused before a single call goes out", async () => {
    // Each entry is a sequential GET. Truncating the list silently would
    // answer a question the caller did not ask.
    const result = await execute(
      { tables: Array.from({ length: 21 }, (_, index) => `u_table_${index}`) },
      credentials("http://127.0.0.1:1"),
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain("cap is 20")
  })

  test("it declares itself read-only and reachable from the read-only persona", () => {
    expect(toolDefinition.permission).toBe("read")
    expect(toolDefinition.allowedRoles).toContain("stakeholder")
    // No transport allowlist: it reads the instance, never the machine the
    // server runs on. transport-parity.test.ts pins the other direction.
    expect(toolDefinition.transports).toBeUndefined()
  })
})
