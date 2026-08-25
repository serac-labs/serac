/**
 * Setup doctor — behaviour tests.
 *
 * Nothing here is mocked. The classifiers are pure functions from an observed
 * response to a diagnosis, so they are fed the payload shapes ServiceNow really
 * answers with; the end-to-end runs drive the real `runSetupDoctor()` against a
 * real HTTP server standing in for an instance, the same way the telemetry
 * tests stand in for the portal. The role coverage is computed against the
 * committed `sn-roles.manifest.json`, not a fixture of it.
 *
 * On the payloads: the classifiers key off structure (HTML vs JSON) and the
 * RFC 6749 `error` code, never off ServiceNow's prose, because that prose moves
 * between releases. The bodies below carry the markers that matter — a
 * hibernation page saying "hibernating", an OAuth body with `error:
 * invalid_client` — and the prose is quoted back to the user rather than
 * matched on.
 */

import { describe, expect, test } from "@jest/globals"
import * as http from "http"
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  classifyApiResponse,
  classifyDateCanary,
  classifyInvalidQuery,
  classifyReachability,
  classifyTableRead,
  classifyTokenResponse,
  classifyTransportFailure,
  heldRoles,
  inspectInstanceUrl,
  loadRolesManifest,
  manifestStamp,
  mapProperties,
  renderReport,
  runSetupDoctor,
  summarizeRoleCoverage,
  summarizeTableAccess,
  type Observed,
} from "../setup-doctor.js"

// ---------------------------------------------------------------------------
// Payloads a ServiceNow instance really answers with
// ---------------------------------------------------------------------------

/** A hibernating developer instance answers every request — REST included — with this page. */
const HIBERNATING_PAGE = `<!DOCTYPE html>
<html><head><title>Instance Hibernating page</title></head>
<body><h2>This instance is hibernating</h2>
<p>To wake your instance, sign in to developer.servicenow.com and select Wake instance.</p></body></html>`

/** The plain login page: same shape, no mention of hibernation. */
const LOGIN_PAGE = `<!DOCTYPE html><html><head><title>Sign In | ServiceNow</title></head>
<body><form action="/login.do" method="post"><input name="user_name"><input type="password" name="user_password"></form></body></html>`

const observed = (status: number, body: string, contentType = "application/json"): Observed => ({
  status,
  body,
  contentType,
})

const UNAUTHENTICATED = `{"error":{"message":"User Not Authenticated","detail":"Required to provide Auth information"},"status":"failure"}`
const INSUFFICIENT_RIGHTS = `{"error":{"message":"Insufficient rights to query records","detail":"Field(s) present in the query do not have permission to be read"},"status":"failure"}`
const TOKEN_OK = `{"access_token":"9lS8sSJqR1uH","refresh_token":"F4RJc0Ns","scope":"useraccount","token_type":"Bearer","expires_in":1799}`

describe("classifying what the instance answered", () => {
  test("a hibernating instance is named, not reported as a parse error", () => {
    const check = classifyReachability(observed(200, HIBERNATING_PAGE, "text/html;charset=UTF-8"))

    expect(check.code).toBe("instance-hibernating")
    expect(check.status).toBe("fail")
    expect(check.fix.join(" ")).toContain("developer.servicenow.com")
    // The whole point: the user is told this is the HTML page, not a bug in a tool.
    expect(check.fix.join(" ")).toContain("parse error")
  })

  test("an HTML login page is still called out as HTML, and still leads with hibernation", () => {
    const check = classifyReachability(observed(200, LOGIN_PAGE, "text/html"))

    expect(check.code).toBe("html-instead-of-json")
    expect(check.status).toBe("fail")
    expect(check.fix[0]).toContain("hibernating")
  })

  test("HTML is detected by content when the content-type does not say so", () => {
    // Some fronting proxies answer text/plain. Sniffing the body is what keeps
    // the hibernation case from falling through to "unrecognisable response".
    expect(classifyReachability({ status: 200, body: HIBERNATING_PAGE, contentType: undefined }).code).toBe(
      "instance-hibernating",
    )
  })

  test("a 401 from the unauthenticated probe means the instance is awake", () => {
    const check = classifyReachability(observed(401, UNAUTHENTICATED))

    expect(check.status).toBe("ok")
    expect(check.code).toBe("instance-awake")
  })

  test("a bad client id or secret is not confused with a bad grant", () => {
    const rejected = classifyTokenResponse(
      observed(401, `{"error":"invalid_client","error_description":"Invalid client_id or client_secret."}`),
    )
    const grant = classifyTokenResponse(
      observed(401, `{"error":"invalid_grant","error_description":"access_denied: no OAuth application user set"}`),
    )

    expect(rejected.code).toBe("oauth-client-rejected")
    expect(grant.code).toBe("oauth-grant-rejected")
    // What ServiceNow actually said survives into the report, verbatim.
    expect(rejected.detail.join(" ")).toContain("Invalid client_id or client_secret.")
    expect(grant.detail.join(" ")).toContain("no OAuth application user set")
    expect(grant.fix.join(" ")).toContain("OAuth application user")
  })

  test("a grant the OAuth entry does not allow is its own diagnosis", () => {
    expect(classifyTokenResponse(observed(400, `{"error":"unsupported_grant_type"}`)).code).toBe(
      "oauth-grant-not-allowed",
    )
  })

  test("a token response is only ok when it carries a token", () => {
    expect(classifyTokenResponse(observed(200, TOKEN_OK)).status).toBe("ok")
    expect(classifyTokenResponse(observed(200, `{"result":[]}`)).code).toBe("token-response-unrecognised")
  })

  test("the token endpoint answering HTML is the hibernation case again, not an OAuth misconfiguration", () => {
    // Worth pinning: this is the one that sends people to regenerate a client
    // secret that was never wrong.
    expect(classifyTokenResponse(observed(200, HIBERNATING_PAGE, "text/html")).code).toBe("instance-hibernating")
  })

  test("403 on the API is reported as roles, not as broken credentials", () => {
    const check = classifyApiResponse(observed(403, INSUFFICIENT_RIGHTS))

    expect(check.code).toBe("api-forbidden")
    expect(check.title).toContain("Authenticated")
    expect(check.detail.join(" ")).toContain("Insufficient rights to query records")
  })

  test("a 200 identifies the account the OAuth entry is acting as", () => {
    const check = classifyApiResponse(
      observed(200, `{"result":[{"user_name":"integration.user","name":"Integration User","active":"true"}]}`),
    )

    expect(check.status).toBe("ok")
    expect(check.title).toContain("integration.user")
  })

  test("unreachable is one finding with the reason named", () => {
    expect(
      classifyTransportFailure({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND dev12345.service-now.com" }).code,
    ).toBe("instance-dns")
    expect(classifyTransportFailure({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:443" }).code).toBe(
      "instance-refused",
    )
    expect(
      classifyTransportFailure({ code: "TimeoutError", message: "The operation was aborted due to timeout" }).code,
    ).toBe("instance-timeout")
    expect(classifyTransportFailure({ code: "CERT_HAS_EXPIRED", message: "certificate has expired" }).code).toBe(
      "instance-tls",
    )
  })
})

describe("instance URL", () => {
  test.each([
    ["dev12345", "https://dev12345.service-now.com", "instance-url-normalized"],
    ["dev12345.service-now.com", "https://dev12345.service-now.com", "instance-url-normalized"],
    ["https://dev12345.service-now.com", "https://dev12345.service-now.com", "instance-url-ok"],
    ["https://dev12345.service-now.com/", "https://dev12345.service-now.com", "instance-url-normalized"],
    [
      "https://dev12345.service-now.com/nav_to.do?uri=incident.do%3Fsys_id%3D9d385017c611228701d22104cc95c371",
      "https://dev12345.service-now.com",
      "instance-url-normalized",
    ],
  ])("%s resolves to %s", (raw, baseUrl, code) => {
    const inspection = inspectInstanceUrl(raw)

    expect(inspection.baseUrl).toBe(baseUrl)
    expect(inspection.check.code).toBe(code)
  })

  test("a missing or placeholder URL fails with nothing to probe", () => {
    expect(inspectInstanceUrl(undefined).check.code).toBe("instance-url-missing")
    expect(inspectInstanceUrl("").baseUrl).toBeUndefined()
    expect(inspectInstanceUrl("https://your-instance.service-now.com").check.code).toBe("instance-url-placeholder")
    expect(inspectInstanceUrl("https://your-instance.service-now.com").baseUrl).toBeUndefined()
  })

  test("a single-label host with a port is left alone — that is on-prem DNS, not a PDI name", () => {
    // The ".service-now.com" completion exists for a pasted PDI name. If it
    // also fired here the doctor would probe, and POST the client secret to,
    // a host the user never configured — and then report the working config
    // as a DNS typo.
    expect(inspectInstanceUrl("https://snprod:8443").baseUrl).toBe("https://snprod:8443")
    expect(inspectInstanceUrl("http://localhost:1080").baseUrl).toBe("http://localhost:1080")
    expect(inspectInstanceUrl("https://snprod:8443").check.fix).toEqual([])
  })

  test("a pasted record URL keeps the origin and says the rest was dropped", () => {
    const inspection = inspectInstanceUrl(
      "https://dev12345.service-now.com/now/nav/ui/classic/params/target/incident.do",
    )

    expect(inspection.check.detail.join(" ")).toContain("this looks like a page URL")
    expect(inspection.check.fix[0]).toContain("https://dev12345.service-now.com")
  })
})

describe("role coverage, against the committed sn-roles.manifest.json", () => {
  const manifest = loadRolesManifest()

  test("the manifest resolves from the package root", () => {
    // Only proves the relative path is right — this reads the committed file,
    // so it is blind to `files` in package.json. What the tarball actually
    // ships is gated in publish-mcp.yml, which is the only place that can see
    // it.
    expect(manifest).toBeDefined()
  })

  test("holding no roles leaves most of the catalog out of reach", () => {
    const none = summarizeRoleCoverage(manifest, [])

    expect(none.resolved).toBeGreaterThan(100)
    expect(none.blocked).toBeGreaterThan(0)
    expect(none.unlocked + none.blocked).toBe(none.resolved)
    // Public tools (empty minimumBundle) still count as reachable.
    expect(none.unlocked).toBeGreaterThan(0)
    expect(none.openers[0]?.tools).toBeGreaterThan(0)
  })

  test("admin unlocks everything the probe could resolve", () => {
    expect(summarizeRoleCoverage(manifest, ["admin"]).blocked).toBe(0)
  })

  test("more roles never unlock fewer tools", () => {
    const none = summarizeRoleCoverage(manifest, [])
    const itil = summarizeRoleCoverage(manifest, ["itil"])
    const both = summarizeRoleCoverage(manifest, ["itil", "snc_internal"])

    expect(itil.unlocked).toBeGreaterThan(none.unlocked)
    expect(both.unlocked).toBeGreaterThanOrEqual(itil.unlocked)
    expect(both.unlocked).toBeLessThan(summarizeRoleCoverage(manifest, ["admin"]).unlocked)
  })

  test("anyOf is a single role that suffices; minimumBundle is roles needed together", () => {
    const handBuilt = {
      tools: {
        alone: { snRoles: { anyOf: ["admin", "itil"], minimumBundle: ["itil"] } },
        together: { snRoles: { anyOf: ["admin"], minimumBundle: ["catalog_admin", "catalog_editor"] } },
        open: { snRoles: { anyOf: ["admin", "public"], minimumBundle: [] } },
        unresolved: { snRoles: null, untestable: true },
      },
    }

    expect(summarizeRoleCoverage(handBuilt, ["itil"]).unlocked).toBe(2) // "alone" + the public one
    expect(summarizeRoleCoverage(handBuilt, ["catalog_admin"]).blocked).toBe(2) // half a bundle unlocks nothing
    expect(summarizeRoleCoverage(handBuilt, ["catalog_admin", "catalog_editor"]).blocked).toBe(1)
    expect(summarizeRoleCoverage(handBuilt, []).unresolved).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The instance probes: what the caller's own credential can see
// ---------------------------------------------------------------------------

/** One row and a count header — what a bounded read of a populated table answers. */
const ONE_ROW = `{"result":[{"sys_id":"46b66a40a9fe198101f243dfbc79033d"}]}`

/** The four identity properties, as sys_properties returns them. */
const PROPERTIES = `{"result":[{"name":"glide.buildname","value":"Zurich"},{"name":"glide.buildtag","value":"glide-zurich-06-25-2026__patch2-08-01-2026_08-14-2026_1417.zip"},{"name":"glide.license.edition","value":"Enterprise"},{"name":"glide.product.description","value":"Service Management"}]}`

const answered = (status: number, body: string, totalCount?: string, contentType = "application/json") => ({
  observed: { status, body, contentType, totalCount },
})

describe("one table read, classified", () => {
  test("a 200 with a count is readable, and the count is the count", () => {
    expect(classifyTableRead("sys_update_xml", 365, answered(200, ONE_ROW, "8123"))).toMatchObject({
      table: "sys_update_xml",
      readable: true,
      httpStatus: 200,
      lifetime: 8123,
      lifetimeWindowDays: 365,
    })
  })

  test("a 200 with no count header is readable with no number, never readable with zero", () => {
    // A 0 here lands in the "this table holds nothing" branch on the other
    // side, which is a diagnosis about the customer's instance made out of a
    // missing header.
    expect(classifyTableRead("sys_update_xml", 365, answered(200, ONE_ROW)).lifetime).toBeNull()
  })

  test("an unbounded read says so, rather than claiming a window it did not apply", () => {
    expect(classifyTableRead("sys_update_set", null, answered(200, ONE_ROW, "12")).lifetimeWindowDays).toBeNull()
  })

  test("a 403 keeps its status and quotes what ServiceNow said", () => {
    // The status is the difference between "ask for a role", "authenticate
    // again" and "fix the query", and it must survive as a number rather than
    // inside prose a caller has to regex.
    const read = classifyTableRead("sys_user_has_role", 365, answered(403, INSUFFICIENT_RIGHTS))

    expect(read.readable).toBe(false)
    expect(read.httpStatus).toBe(403)
    expect(read.error).toContain("HTTP 403")
    expect(read.error).toContain("Insufficient rights to query records")
  })

  test("a hibernation page is not a readable empty table", () => {
    // HTTP 200, HTML body, no count header: without the html check every table
    // on a sleeping instance comes back readable and holding nothing.
    const read = classifyTableRead("sys_user", 365, answered(200, HIBERNATING_PAGE, undefined, "text/html"))

    expect(read.readable).toBe(false)
    expect(read.error).toContain("hibernating")
  })

  test("a request that never arrived has no status to report", () => {
    const read = classifyTableRead("sys_user", 365, {
      failure: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND dev12345.service-now.com" },
    })

    expect(read.readable).toBe(false)
    expect(read.httpStatus).toBeUndefined()
    expect(read.error).toContain("ENOTFOUND")
  })
})

describe("do javascript: date functions resolve on this instance", () => {
  test("a clause that cannot match matching nothing means the function resolved", () => {
    expect(classifyDateCanary(0, 8123)).toBe("resolved")
  })

  test("a clause that cannot match matching the whole table means it was dropped", () => {
    expect(classifyDateCanary(8123, 8123)).toBe("evaporated")
  })

  test("an empty table proves nothing either way", () => {
    // Both regimes answer 0 on a table with no rows, so "resolved" here would
    // hand a downgrade to every withheld figure on the instance on the
    // strength of a measurement that measured nothing.
    expect(classifyDateCanary(0, 0)).toBe("inconclusive")
  })

  test("a count that could not be made never becomes a verdict", () => {
    expect(classifyDateCanary(null, 8123)).toBe("inconclusive")
    expect(classifyDateCanary(0, null)).toBe("inconclusive")
  })

  test("a partial match is neither, and is not silently rounded to one of them", () => {
    expect(classifyDateCanary(3, 8123)).toBe("inconclusive")
  })
})

describe("which invalid-query regime the instance is in", () => {
  test("a condition on a column that does not exist answering for the whole table is the ignore regime", () => {
    expect(classifyInvalidQuery(8123, 8123)).toBe("ignores")
  })

  test("the same condition answering zero is glide.invalid_query.returns_no_rows", () => {
    // The inverse signature, and the reason it is worth a call: under this
    // regime a dropped clause reads as a confident 0 rather than a confident
    // total, and nothing else in the response distinguishes the two.
    expect(classifyInvalidQuery(0, 8123)).toBe("returns_no_rows")
  })

  test("an instance that refuses the query outright is neither", () => {
    expect(classifyInvalidQuery(null, 8123)).toBe("unknown")
  })

  test("an empty table cannot separate the two", () => {
    expect(classifyInvalidQuery(0, 0)).toBe("unknown")
    expect(classifyInvalidQuery(0, null)).toBe("unknown")
  })
})

describe("the held-role list is a floor, not an inventory", () => {
  const page = (rows: number) =>
    JSON.stringify({ result: Array.from({ length: rows }, (_, index) => ({ "role.name": `role_${index}` })) })

  test("a short page is the whole list, sorted and deduplicated", () => {
    const roles = heldRoles({ status: 200, body: `{"result":[{"role.name":"itil"},{"role.name":"admin"},{"role.name":"itil"}]}` })

    expect(roles.held).toEqual(["admin", "itil"])
    expect(roles.truncated).toBe(false)
    expect(roles.readable).toBe(true)
  })

  test("a full page is flagged, because that is the case that matters", () => {
    // The query asks for 500 rows with no ORDERBY, and it is admins who
    // overflow it. Deciding "this account cannot read that table" from a cut
    // off list is wrong in exactly the direction that hurts.
    expect(heldRoles({ status: 200, body: page(500) }).truncated).toBe(true)
    expect(heldRoles({ status: 200, body: page(499) }).truncated).toBe(false)
  })

  test("a refused read is not an account that holds no roles", () => {
    // Reading sys_user_has_role needs a role of its own, so a 403 here says
    // nothing at all about what the account holds.
    const roles = heldRoles({ status: 403, body: INSUFFICIENT_RIGHTS })

    expect(roles.readable).toBe(false)
    expect(roles.held).toEqual([])
    expect(roles.truncated).toBe(false)
  })

  test("neither is a hibernation page that happens to arrive with a 200", () => {
    // The status alone said "readable" here, and the page parses to zero rows,
    // so a sleeping instance reported an account with no roles — and every
    // coverage number downstream was then computed from a login page. Same
    // fabrication as the 403, through a different door.
    const roles = heldRoles({ status: 200, body: HIBERNATING_PAGE, contentType: "text/html" })

    expect(roles.readable).toBe(false)
    expect(roles.httpStatus).toBe(200)
    expect(roles.held).toEqual([])
  })
})

describe("what the package publishes as /setup-doctor", () => {
  // The module holds two halves: everything above the line reads THE MACHINE
  // (`runSetupDoctor` walks environment variables and every auth.json on disk),
  // everything below reads THE INSTANCE through the caller's own credential.
  // That line is why snow_diagnose_setup is stdio-only. A subpath exporting the
  // whole module hands the machine-reading half to every npm consumer including
  // a multi-tenant backend, which is the same thing the stdio annotation
  // refuses, arriving through the library door.
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "package.json"), "utf-8"))

  test("the subpath resolves to the instance half, not to setup-doctor.ts", () => {
    expect(manifest.exports["./setup-doctor"]).toBe("./src/servicenow-mcp-unified/shared/instance-diagnostics.ts")
  })

  test("the probes and classifiers are published", async () => {
    const published = await import("../instance-diagnostics.js")

    expect(Object.keys(published)).toEqual(
      expect.arrayContaining(["probeReach", "probeHeldRoles", "probeTableRead", "classifyTableRead", "heldRoles"]),
    )
  })

  test("runSetupDoctor and renderReport are not", async () => {
    const published = await import("../instance-diagnostics.js")

    expect(Object.keys(published)).not.toContain("runSetupDoctor")
    expect(Object.keys(published)).not.toContain("renderReport")
  })
})

describe("which instance answered", () => {
  test("release is the build name, and the product description is kept apart from it", () => {
    // The portal mapped its `version` column from glide.product.description
    // with buildname only as a fallback, so every instance it discovered reads
    // "Service Management" under a heading that says Release.
    const identity = mapProperties({ status: 200, body: PROPERTIES })

    expect(identity.release).toBe("Zurich")
    expect(identity.buildName).toBe("Zurich")
    expect(identity.productDescription).toBe("Service Management")
    expect(identity.buildTag).toContain("glide-zurich")
    expect(identity.edition).toBe("Enterprise")
  })

  test("a refused read names no field at all, rather than naming them empty", () => {
    expect(Object.values(mapProperties({ status: 403, body: INSUFFICIENT_RIGHTS })).filter(Boolean)).toEqual([])
  })

  test("a property the instance does not carry is absent, not blank", () => {
    const identity = mapProperties({ status: 200, body: `{"result":[{"name":"glide.buildname","value":""}]}` })

    expect(identity.release).toBeUndefined()
    expect(identity.edition).toBeUndefined()
  })
})

describe("the manifest advises about a table, and never outranks the probe", () => {
  const manifest = loadRolesManifest()

  test("a table the manifest knows lists the roles that can read it", () => {
    const advice = summarizeTableAccess(manifest, "sys_update_xml", [])

    expect(advice.missingRoles).toEqual(["teamdev_user", "update_set_admin", "update_set_previewer", "upgrade_admin"])
    expect(advice.scriptAcls).toBe(0)
  })

  test("held admin satisfies every table, including the ones no ACL names it on", () => {
    // admin bypasses ACLs outright, so it appears in almost no ACL row —
    // neither sys_update_set's nor sys_user_has_role's. A naive intersection
    // calls an admin connection blocked on both, which is the modal connection
    // and the two tables an operations pass exists to read.
    expect(summarizeTableAccess(manifest, "sys_update_set", ["admin"]).missingRoles).toEqual([])
    expect(summarizeTableAccess(manifest, "sys_user_has_role", ["admin"]).missingRoles).toEqual([])
  })

  test("one role off the list is enough, because the list is an OR", () => {
    expect(summarizeTableAccess(manifest, "sys_update_xml", ["update_set_admin"]).missingRoles).toEqual([])
    expect(summarizeTableAccess(manifest, "sys_update_xml", ["itil"]).missingRoles.length).toBeGreaterThan(0)
  })

  test("public is never offered as a role to ask for, and a table that names it needs none", () => {
    // sys_user read folds to {public, snc_internal} on all nineteen of its
    // primitives. Rendering "ask for snc_internal" would tell every connection
    // on earth it cannot read a user record.
    expect(summarizeTableAccess(manifest, "sys_user", []).missingRoles).toEqual([])
  })

  test("a table the manifest has never seen produces no advice rather than a guess", () => {
    expect(summarizeTableAccess(manifest, "u_no_such_table", [])).toEqual({ missingRoles: [], scriptAcls: 0 })
  })

  test("scriptAcls comes back even where the role list is satisfied", () => {
    // It is reported on every table, not only where it is non-zero: the count
    // comes from the ACL `script` column alone, so 0 means "no scripted ACL
    // was seen", never "no row filter applies".
    expect(summarizeTableAccess(manifest, "sys_properties", ["snc_internal"]).scriptAcls).toBe(1)
  })

  test("the manifest's own age is passed through, because the advice expires", () => {
    expect(manifestStamp(manifest).validatedOn).toContain("glide-")
    expect(manifestStamp(manifest).testedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(manifestStamp(undefined)).toEqual({ validatedOn: undefined, testedAt: undefined })
  })
})

// ---------------------------------------------------------------------------
// End to end, against a real HTTP server standing in for an instance
// ---------------------------------------------------------------------------

interface Answer {
  status: number
  body: string
  contentType?: string
}

interface FakeInstance {
  url: string
  /** Paths the doctor asked for, in order. */
  hits: string[]
  stop: () => Promise<void>
}

const startInstance = async (answer: (path: string) => Answer): Promise<FakeInstance> => {
  const hits: string[] = []
  const sockets = new Set<import("net").Socket>()
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "")
    const reply = answer(req.url ?? "")
    res.writeHead(reply.status, { "content-type": reply.contentType ?? "application/json" })
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

const healthy = (path: string): Answer => {
  if (path.startsWith("/oauth_token.do")) return { status: 200, body: TOKEN_OK }
  if (path.startsWith("/api/now/table/sys_user_has_role"))
    return { status: 200, body: `{"result":[{"role.name":"itil"},{"role.name":"snc_internal"}]}` }
  if (path.startsWith("/api/now/table/sys_user"))
    return {
      status: 200,
      body: `{"result":[{"user_name":"integration.user","name":"Integration User","active":"true"}]}`,
    }
  return { status: 401, body: UNAUTHENTICATED }
}

const credentials = (instanceUrl: string) => ({
  instanceUrl,
  clientId: "3b7f2c1e9a4d4f6b8c0e1a2b3c4d5e6f",
  clientSecret: "not-a-real-secret",
})

const codes = (report: Awaited<ReturnType<typeof runSetupDoctor>>) => report.checks.map((check) => check.code)

describe("running the whole diagnosis against an instance", () => {
  test("a hibernating instance stops the walk at reachability instead of blaming OAuth", async () => {
    const instance = await startInstance(() => ({
      status: 200,
      body: HIBERNATING_PAGE,
      contentType: "text/html;charset=UTF-8",
    }))

    const report = await runSetupDoctor({ context: credentials(instance.url) })

    expect(report.ok).toBe(false)
    expect(codes(report)).toContain("instance-hibernating")
    // Nothing downstream ran: no token was exchanged, so nobody is told to
    // regenerate a client secret that was fine all along.
    expect(instance.hits.some((path) => path.startsWith("/oauth_token.do"))).toBe(false)
    expect(renderReport(report)).toContain("developer.servicenow.com")
    await instance.stop()
  })

  test("a healthy instance reports the account and its role coverage", async () => {
    const instance = await startInstance(healthy)

    const report = await runSetupDoctor({ context: credentials(instance.url) })
    const rendered = renderReport(report)

    expect(report.ok).toBe(true)
    expect(codes(report)).toContain("token-ok")
    expect(codes(report)).toContain("api-ok")
    expect(rendered).toContain("integration.user")
    // Two roles held, and the manifest says what that does and does not cover.
    expect(rendered).toContain("itil, snc_internal")
    expect(rendered).toMatch(/\d+ of \d+ tools with a known role requirement/)
    await instance.stop()
  })

  test("a rejected client stops before the API call and quotes ServiceNow", async () => {
    const instance = await startInstance((path) =>
      path.startsWith("/oauth_token.do")
        ? { status: 401, body: `{"error":"invalid_client","error_description":"Invalid client_id or client_secret."}` }
        : { status: 401, body: UNAUTHENTICATED },
    )

    const report = await runSetupDoctor({ context: credentials(instance.url) })

    expect(codes(report)).toContain("oauth-client-rejected")
    expect(codes(report)).toContain("api-skipped")
    expect(instance.hits.filter((path) => path.startsWith("/api/now/table/sys_user")).length).toBe(0)
    expect(renderReport(report)).toContain("Invalid client_id or client_secret.")
    await instance.stop()
  })

  test("an authenticated account with no roles is a warning, not a failure", async () => {
    const instance = await startInstance((path) =>
      path.startsWith("/api/now/table/sys_user_has_role") ? { status: 200, body: `{"result":[]}` } : healthy(path),
    )

    const report = await runSetupDoctor({ context: credentials(instance.url) })

    expect(report.ok).toBe(true)
    expect(codes(report)).toContain("roles-none")
    expect(renderReport(report)).toContain("holds no roles")
    await instance.stop()
  })

  test("an account with hundreds of roles is read, not truncated into nothing", async () => {
    // An admin's sys_user_has_role answer is tens of kilobytes. A response body
    // clipped for quoting parses as nothing, which would report "no roles" for
    // precisely the accounts that hold the most.
    const many = Array.from({ length: 300 }, (_, index) => ({ "role.name": `role_number_${index}` }))
    const instance = await startInstance((path) =>
      path.startsWith("/api/now/table/sys_user_has_role")
        ? { status: 200, body: JSON.stringify({ result: many }) }
        : healthy(path),
    )

    const report = await runSetupDoctor({ context: credentials(instance.url) })
    const roles = report.checks.find((check) => check.step === "roles")

    expect(roles?.title).toContain("300 roles")
    // Listed, but not all 300 of them dumped into one line.
    expect(roles?.title).toContain("and 288 more")
    await instance.stop()
  })

  test("a full page of roles is reported as cut off rather than counted as the whole list", async () => {
    // The query asks for one page. An account that fills it holds an unknown
    // number more, so the coverage numbers are a floor — saying "N tools are
    // out of reach" here would be wrong about the most privileged account on
    // the instance.
    const full = Array.from({ length: 500 }, (_, index) => ({ "role.name": `role_number_${index}` }))
    const instance = await startInstance((path) =>
      path.startsWith("/api/now/table/sys_user_has_role")
        ? { status: 200, body: JSON.stringify({ result: full }) }
        : healthy(path),
    )

    const roles = (await runSetupDoctor({ context: credentials(instance.url) })).checks.find(
      (check) => check.step === "roles",
    )

    expect(roles?.detail[0]).toContain("cut off")
    expect(roles?.detail[0]).toContain("floor")
    await instance.stop()
  })

  test("a refused connection is diagnosed as unreachable, with no credentials sent anywhere", async () => {
    // Port 1 on loopback: nothing listens there, and no DNS is involved.
    const report = await runSetupDoctor({ context: credentials("http://127.0.0.1:1") })

    expect(report.ok).toBe(false)
    expect(codes(report)).toContain("instance-refused")
    expect(codes(report)).toContain("token-skipped")
  }, 20000)

  test("the report never prints the client secret", async () => {
    const instance = await startInstance(healthy)

    const rendered = renderReport(await runSetupDoctor({ context: credentials(instance.url) }))

    expect(rendered).not.toContain("not-a-real-secret")
    expect(rendered).toContain("client secret set")
    await instance.stop()
  })
})

// ---------------------------------------------------------------------------
// The bin flag
// ---------------------------------------------------------------------------

describe("servicenow-mcp-stdio --doctor", () => {
  test("reports the auth.json that supplied the credentials, and exits non-zero", async () => {
    const instance = await startInstance(() => ({ status: 200, body: HIBERNATING_PAGE, contentType: "text/html" }))
    // A home directory with one stale auth.json in it. os.homedir() under Bun
    // reads HOME at process start, which is why this is a spawn and not an
    // in-process test.
    const home = mkdtempSync(join(tmpdir(), "serac-doctor-"))
    mkdirSync(join(home, ".serac"))
    const authJson = join(home, ".serac", "auth.json")
    writeFileSync(
      authJson,
      JSON.stringify({
        servicenow: { instance: instance.url, clientId: "abc", clientSecret: "def", type: "servicenow-oauth" },
      }),
    )

    const entry = new URL("../../index.ts", import.meta.url).pathname
    const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, [entry, "--doctor"], {
        cwd: home,
        env: { PATH: process.env.PATH ?? "", HOME: home, DO_NOT_TRACK: "1" },
      })
      const chunks = { stdout: "", stderr: "" }
      child.stdout.on("data", (data) => (chunks.stdout += data))
      child.stderr.on("data", (data) => (chunks.stderr += data))
      child.on("exit", (code) => done({ code, ...chunks }))
    })

    expect(run.stdout).toContain(authJson)
    expect(run.stdout).toContain("hibernating")
    // Non-zero so a setup script can gate on it.
    expect(run.code).toBe(1)
    await instance.stop()
  }, 60000)
})
