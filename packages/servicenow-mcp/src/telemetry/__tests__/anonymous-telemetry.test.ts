/**
 * Anonymous telemetry — behaviour tests.
 *
 * Everything here runs the real module against real inputs: a real HTTP
 * server receives the pings, real temp directories hold the state, real
 * `fs` decides whether an install id survives. Nothing is mocked, so a test
 * that passes proves the bytes that would leave a user's machine.
 */

import { describe, test, expect, afterEach } from "@jest/globals"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"
import { AddressInfo } from "net"

import {
  AnonymousTelemetry,
  EXIT_REASONS,
  INSTALL_METHODS,
  PAYLOAD_KEYS,
  TOOL_CATEGORIES,
  categorizeTool,
  createSession,
  detectInstallMethod,
  installIdPath,
  isTelemetryDisabled,
  pendingEndPingPath,
  readPackageIdentity,
  resolveInstallId,
  sanitizePayload,
  sendPing,
  telemetryStateDir,
  type InstallProbe,
  type TelemetryPayload,
} from "../anonymous-telemetry.js"

// ---------------------------------------------------------------------------
// Harness: a real portal stand-in
// ---------------------------------------------------------------------------

interface Portal {
  url: string
  pings: TelemetryPayload[]
  bodies: string[]
  /** Set to a status the next requests should answer with (default 200). */
  respondWith: (status: number) => void
  /**
   * Accept and record the request, then never answer it — a portal that is
   * reachable but slow past any deadline the client is willing to wait.
   */
  stall: (on: boolean) => void
  stop: () => Promise<void>
}

const startPortal = async (): Promise<Portal> => {
  const pings: TelemetryPayload[] = []
  const bodies: string[] = []
  const state = { status: 200, stalling: false }
  const sockets = new Set<import("net").Socket>()

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(Buffer.from(c)))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8")
      // Only record what the real route accepts, so a stray request to any
      // other path shows up as a failure rather than passing silently.
      if (req.url === "/api/telemetry/ping" && req.method === "POST") {
        bodies.push(raw)
        pings.push(JSON.parse(raw) as TelemetryPayload)
      }
      if (state.stalling) return
      res.statusCode = state.status
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ success: state.status < 400 }))
    })
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`,
    pings,
    bodies,
    respondWith: (status: number) => {
      state.status = status
    },
    stall: (on: boolean) => {
      state.stalling = on
    },
    stop: () =>
      new Promise<void>((resolve) => {
        // A stalled response holds its socket open, so close() alone would hang.
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

const tempDirs: string[] = []
const tempStateDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serac-telemetry-"))
  tempDirs.push(dir)
  return path.join(dir, "state")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** An env with every opt-out signal explicitly cleared. */
const trackingEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  DO_NOT_TRACK: "",
  CI: "",
  SERAC_TELEMETRY_DISABLED: "",
  ...extra,
})

// ---------------------------------------------------------------------------
// Opt-out
// ---------------------------------------------------------------------------

describe("opt-out", () => {
  test("each of DO_NOT_TRACK, CI and SERAC_TELEMETRY_DISABLED disables on its own", () => {
    for (const key of ["DO_NOT_TRACK", "CI", "SERAC_TELEMETRY_DISABLED"]) {
      for (const value of ["1", "true", "TRUE", "yes", "on"]) {
        expect(isTelemetryDisabled({ [key]: value })).toBe(true)
      }
    }
  })

  test("absent, empty, 0 and false do not disable", () => {
    expect(isTelemetryDisabled({})).toBe(false)
    for (const key of ["DO_NOT_TRACK", "CI", "SERAC_TELEMETRY_DISABLED"]) {
      for (const value of ["", "  ", "0", "false", "FALSE"]) {
        expect(isTelemetryDisabled({ [key]: value })).toBe(false)
      }
    }
  })

  test.each(["DO_NOT_TRACK", "CI", "SERAC_TELEMETRY_DISABLED"])(
    "%s=1 sends nothing and writes nothing to disk",
    async (key) => {
      const portal = await startPortal()
      const stateDir = tempStateDir()
      try {
        const session = createSession({
          env: trackingEnv({ [key]: "1" }),
          stateDir,
          portalUrl: portal.url,
        })
        expect(session.enabled).toBe(false)

        session.start()
        session.recordToolCall("snow_query_table")
        session.finish("normal")
        await session.inFlight()

        expect(portal.pings).toEqual([])
        // Not merely "no install-id file": the directory itself is never created.
        expect(fs.existsSync(stateDir)).toBe(false)
      } finally {
        await portal.stop()
      }
    },
  )

  test("an opted-out singleton attaches no process listeners", () => {
    const before = process.listenerCount("exit") + process.listenerCount("uncaughtExceptionMonitor")
    AnonymousTelemetry.start({
      env: trackingEnv({ DO_NOT_TRACK: "1" }),
      stateDir: tempStateDir(),
      portalUrl: "http://127.0.0.1:1",
    })
    const after = process.listenerCount("exit") + process.listenerCount("uncaughtExceptionMonitor")
    expect(after).toBe(before)
    // These are no-ops rather than crashes when the session is disabled.
    AnonymousTelemetry.recordToolCall("snow_query_table")
    AnonymousTelemetry.finish("normal")
  })
})

// ---------------------------------------------------------------------------
// Install id
// ---------------------------------------------------------------------------

describe("install id", () => {
  test("is stable across calls and regenerates once the state dir is removed", () => {
    const stateDir = tempStateDir()

    const first = resolveInstallId(stateDir)
    const second = resolveInstallId(stateDir)
    expect(first).toBeDefined()
    expect(second).toBe(first!)
    // A third read after a fresh module-free call still returns the same value.
    expect(resolveInstallId(stateDir)).toBe(first!)
    expect(fs.readFileSync(installIdPath(stateDir), "utf-8").trim()).toBe(first!)

    fs.rmSync(stateDir, { recursive: true, force: true })

    const regenerated = resolveInstallId(stateDir)
    expect(regenerated).toBeDefined()
    expect(regenerated).not.toBe(first!)
  })

  test("is a random UUID, not derived from the machine", () => {
    const a = resolveInstallId(tempStateDir())!
    const b = resolveInstallId(tempStateDir())!
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // Two installations on this one machine must not share an identifier.
    expect(a).not.toBe(b)
  })

  test("survives the receiving route's machineId validation", () => {
    const id = resolveInstallId(tempStateDir())!
    expect(id.length).toBeLessThanOrEqual(64)
    expect(/^[a-zA-Z0-9._-]+$/.test(id)).toBe(true)
  })

  test("two sessions on one install share the install id but not the session id", async () => {
    const portal = await startPortal()
    const stateDir = tempStateDir()
    try {
      const deps = { env: trackingEnv(), stateDir, portalUrl: portal.url }
      const one = createSession(deps)
      const two = createSession(deps)
      one.start()
      two.start()
      await Promise.all([one.inFlight(), two.inFlight()])

      expect(portal.pings).toHaveLength(2)
      expect(portal.pings[0]!.machineId).toBe(portal.pings[1]!.machineId)
      expect(portal.pings[0]!.sessionId).not.toBe(portal.pings[1]!.sessionId)
    } finally {
      await portal.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// State directory
// ---------------------------------------------------------------------------

describe("state directory", () => {
  test("follows XDG_STATE_HOME when it is absolute", () => {
    expect(telemetryStateDir({ XDG_STATE_HOME: "/var/tmp/xdg" })).toBe(path.join("/var/tmp/xdg", "serac", "telemetry"))
  })

  test("falls back to ~/.local/state and ignores a relative XDG_STATE_HOME", () => {
    const expected = path.join("/home/tester", ".local", "state", "serac", "telemetry")
    expect(telemetryStateDir({ HOME: "/home/tester" })).toBe(expected)
    expect(telemetryStateDir({ HOME: "/home/tester", XDG_STATE_HOME: "relative/state" })).toBe(expected)
  })

  test("never lands inside ~/.serac, where credentials live", () => {
    expect(telemetryStateDir({ HOME: "/home/tester" })).not.toContain(path.join("/home/tester", ".serac"))
  })
})

// ---------------------------------------------------------------------------
// Version + channel
// ---------------------------------------------------------------------------

describe("version and channel", () => {
  test("reads this package's own version", () => {
    const identity = readPackageIdentity()
    const declared = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "package.json"), "utf-8"),
    ) as { version: string }
    expect(identity.version).toBe(declared.version)
    expect(identity.channel).toBe("latest")
  })

  test("derives the channel from a prerelease tag and strips build metadata", () => {
    const dir = tempStateDir()
    fs.mkdirSync(dir, { recursive: true })
    const write = (version: string): string => {
      const file = path.join(dir, `pkg-${encodeURIComponent(version)}.json`)
      fs.writeFileSync(file, JSON.stringify({ version }), "utf-8")
      return file
    }

    expect(readPackageIdentity(write("0.3.0-beta.1"))).toEqual({ version: "0.3.0-beta.1", channel: "beta" })
    expect(readPackageIdentity(write("1.0.0+build.7"))).toEqual({ version: "1.0.0", channel: "latest" })
  })

  test("a missing package.json degrades instead of throwing", () => {
    expect(readPackageIdentity(path.join(tempStateDir(), "nope.json"))).toEqual({ version: "0.0.0", channel: "local" })
  })

  test("the version always survives the receiving route's validation", () => {
    const { version, channel } = readPackageIdentity()
    for (const value of [version, channel]) {
      expect(value.length).toBeGreaterThan(0)
      expect(value.length).toBeLessThanOrEqual(20)
      expect(/^[a-zA-Z0-9._-]+$/.test(value)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Install method
// ---------------------------------------------------------------------------

describe("install method", () => {
  const probe = (over: Partial<InstallProbe>): InstallProbe => ({
    execPath: "/usr/local/bin/node",
    modulePath: "/home/tester/project/src/telemetry/anonymous-telemetry.ts",
    hasBunRuntime: false,
    inContainer: false,
    ...over,
  })

  const cases: { name: string; probe: InstallProbe; expected: string }[] = [
    {
      name: "npx",
      probe: probe({
        userAgent: "npm/10.8.2 node/v22.5.1 darwin arm64 workspaces/false",
        modulePath: "/Users/t/.npm/_npx/abc/node_modules/@serac-labs/servicenow-mcp/dist/telemetry/anonymous-telemetry.js",
      }),
      expected: "npm",
    },
    {
      name: "bunx",
      probe: probe({ userAgent: "bun/1.1.30 npm/? node/v22.6.0 darwin arm64", hasBunRuntime: true }),
      expected: "bun",
    },
    {
      name: "global npm install spawned directly by an MCP client",
      probe: probe({
        modulePath: `${path.sep}usr${path.sep}local${path.sep}lib${path.sep}node_modules${path.sep}@serac-labs${path.sep}servicenow-mcp${path.sep}dist${path.sep}telemetry${path.sep}anonymous-telemetry.js`,
      }),
      expected: "npm",
    },
    {
      name: "homebrew node",
      probe: probe({ execPath: "/opt/homebrew/Cellar/node/22.5.1/bin/node" }),
      expected: "brew",
    },
    {
      name: "compiled single-file executable",
      probe: probe({ execPath: "/usr/local/bin/servicenow-mcp", hasBunRuntime: true }),
      expected: "binary",
    },
    {
      name: "docker run -i",
      probe: probe({ inContainer: true, userAgent: "npm/10.8.2 node/v22.5.1 linux x64" }),
      expected: "other",
    },
    {
      name: "pnpm dlx",
      probe: probe({ userAgent: "pnpm/9.7.0 npm/? node/v22.5.1 linux x64" }),
      expected: "other",
    },
    { name: "bun run from a checkout", probe: probe({ execPath: "/usr/local/bin/bun", hasBunRuntime: true }), expected: "bun" },
    { name: "node from a source checkout", probe: probe({}), expected: "other" },
  ]

  test.each(cases)("$name → $expected", ({ probe: input, expected }) => {
    expect(detectInstallMethod(input)).toBe(expected)
  })

  test("every case resolves to a value the receiving route accepts", () => {
    // Includes deliberately hostile inputs: the function must never invent a
    // value outside the allowlist, because the route drops those to null.
    const hostile: InstallProbe[] = [
      probe({ execPath: "", modulePath: "" }),
      probe({ userAgent: "   " }),
      probe({ userAgent: "deno/1.46.0" }),
      probe({ execPath: "C:\\Program Files\\nodejs\\node.exe" }),
      probe({ execPath: "/weird/path/with spaces/thing" }),
    ]
    for (const input of [...cases.map((c) => c.probe), ...hostile]) {
      expect(INSTALL_METHODS).toContain(detectInstallMethod(input))
    }
  })
})

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

describe("payload", () => {
  test("a start ping carries only the declared fields and the route's required ones", async () => {
    const portal = await startPortal()
    try {
      const session = createSession({ env: trackingEnv(), stateDir: tempStateDir(), portalUrl: portal.url })
      session.start()
      await session.inFlight()

      expect(portal.pings).toHaveLength(1)
      const ping = portal.pings[0]!
      expect(Object.keys(ping).sort()).toEqual(
        ["arch", "channel", "installMethod", "machineId", "os", "sessionDurationSec", "sessionId", "timestamp", "type", "version"].sort(),
      )
      for (const key of Object.keys(ping)) expect(PAYLOAD_KEYS).toContain(key)
      // machineId, version, os and arch are required — a missing one is a 400.
      for (const key of ["machineId", "version", "os", "arch"] as const) {
        expect(typeof ping[key]).toBe("string")
        expect(ping[key].length).toBeGreaterThan(0)
      }
      expect(ping.type).toBe("start")
      expect(ping.sessionDurationSec).toBe(0)
      expect(INSTALL_METHODS).toContain(ping.installMethod)
    } finally {
      await portal.stop()
    }
  })

  test("carries nothing derived from what the user was doing", async () => {
    const portal = await startPortal()
    try {
      // Everything a real stdio session has lying around in its environment.
      const secrets = {
        SNOW_INSTANCE: "https://dev380262.service-now.com",
        SERVICENOW_CLIENT_SECRET: "s3cr3t-client-secret",
        SNOW_SESSION_ID: "session-of-a-real-user",
      }
      const session = createSession({
        env: trackingEnv({ ...secrets }),
        stateDir: tempStateDir(),
        portalUrl: portal.url,
      })
      session.start()
      // Tool traffic that names an instance, a table and a sys_id.
      session.recordToolCall("snow_query_table")
      session.recordToolCall("snow_update_set_create")
      session.recordToolCall("tool_search")
      session.finish("normal")
      await session.inFlight()

      const body = portal.bodies.join("\n")
      const forbidden = [
        ...Object.values(secrets),
        "service-now.com",
        "snow_query_table",
        "snow_update_set_create",
        "tool_search",
        "incident",
        "sys_id",
        os.hostname(),
        os.userInfo().username,
        os.homedir(),
        process.cwd(),
      ]
      for (const needle of forbidden) {
        expect(body.toLowerCase()).not.toContain(needle.toLowerCase())
      }

      // And structurally: no key outside the declared set, on any ping.
      for (const ping of portal.pings) {
        for (const key of Object.keys(ping)) expect(PAYLOAD_KEYS).toContain(key)
      }
    } finally {
      await portal.stop()
    }
  })

  test("an end ping reports duration, exit reason and per-category tool counts", async () => {
    const portal = await startPortal()
    try {
      const clock = { value: 1_000_000 }
      const session = createSession({
        env: trackingEnv(),
        stateDir: tempStateDir(),
        portalUrl: portal.url,
        now: () => clock.value,
      })
      session.start()
      session.recordToolCall("snow_query_table")
      session.recordToolCall("snow_create_incident")
      session.recordToolCall("tool_execute")
      clock.value += 42_000
      session.finish("normal")
      await session.inFlight()

      const end = portal.pings.find((p) => p.type === "end")!
      expect(end.sessionDurationSec).toBe(42)
      expect(EXIT_REASONS).toContain(end.exitReason!)
      expect(end.exitReason).toBe("normal")
      expect(end.toolCounts).toEqual({ servicenow: 2, mcp: 1 })
      for (const category of Object.keys(end.toolCounts!)) expect(TOOL_CATEGORIES).toContain(category)
      // The start ping never carries counts.
      expect(portal.pings.find((p) => p.type === "start")!.toolCounts).toBeUndefined()
    } finally {
      await portal.stop()
    }
  })

  test("tool categorisation keeps ServiceNow work apart from meta traffic", () => {
    expect(categorizeTool("snow_query_table")).toBe("servicenow")
    expect(categorizeTool("tool_search")).toBe("mcp")
    expect(categorizeTool("tool_execute")).toBe("mcp")
    for (const name of ["snow_x", "tool_search", "anything_else", ""]) {
      expect(TOOL_CATEGORIES).toContain(categorizeTool(name))
    }
  })

  test("an error exit reports the error class, never the message", async () => {
    const portal = await startPortal()
    try {
      const session = createSession({ env: trackingEnv(), stateDir: tempStateDir(), portalUrl: portal.url })
      session.start()
      const error = new TypeError(
        "failed to update incident sys_id=9d385017c611228701d22104cc95c371 on https://dev380262.service-now.com",
      )
      session.finish("error", error)
      await session.inFlight()

      const end = portal.pings.find((p) => p.type === "end")!
      expect(end.exitReason).toBe("error")
      expect(end.exitErrorMessage).toBe("TypeError")
      const body = portal.bodies.join("\n")
      expect(body).not.toContain("sys_id")
      expect(body).not.toContain("service-now.com")
      expect(body).not.toContain("incident")
    } finally {
      await portal.stop()
    }
  })

  test("an unrecognisable error name is dropped rather than forwarded", async () => {
    const portal = await startPortal()
    try {
      const session = createSession({ env: trackingEnv(), stateDir: tempStateDir(), portalUrl: portal.url })
      session.start()
      session.finish("error", "https://dev380262.service-now.com exploded")
      await session.inFlight()

      const end = portal.pings.find((p) => p.type === "end")!
      expect(end.exitErrorMessage).toBeUndefined()
      expect(portal.bodies.join("\n")).not.toContain("service-now.com")
    } finally {
      await portal.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// Wire sanitisation
// ---------------------------------------------------------------------------

describe("wire sanitisation", () => {
  const valid: TelemetryPayload = {
    machineId: "03c94b30-d66e-4149-85a7-bfb66056bf46",
    sessionId: "32a90c30-c092-4291-a5c5-43bf80e28754",
    version: "0.2.1",
    channel: "latest",
    os: "darwin",
    arch: "arm64",
    installMethod: "npm",
    type: "end",
    sessionDurationSec: 12,
    timestamp: 1786807579568,
    exitReason: "error",
    exitErrorMessage: "TypeError",
    toolCounts: { servicenow: 2 },
  }

  test("a payload this module built passes through unchanged", () => {
    // Both directions of the wire contract: this fixture uses every declared
    // key, and every one of them survives.
    expect(Object.keys(valid).sort()).toEqual([...PAYLOAD_KEYS].sort())
    expect(sanitizePayload(valid)).toEqual(valid)
  })

  test("an unusable timestamp is omitted so the route stamps arrival time", () => {
    // Sending 0 would store a 1970 row; the route defaults a missing timestamp.
    for (const timestamp of [-1, Number.NaN, "yesterday", null, undefined]) {
      expect(sanitizePayload({ ...valid, timestamp })!.timestamp).toBeUndefined()
    }
    expect(sanitizePayload({ ...valid, sessionDurationSec: -5 })!.sessionDurationSec).toBe(0)
  })

  test("only declared keys survive", () => {
    const sanitized = sanitizePayload({
      ...valid,
      instanceUrl: "https://acme-secret-prod.service-now.com",
      orgId: "org-9999",
      cwd: "/Users/niels/projects/acme",
    })!
    for (const key of Object.keys(sanitized)) expect(PAYLOAD_KEYS).toContain(key)
    expect(JSON.stringify(sanitized)).not.toContain("service-now.com")
    expect(JSON.stringify(sanitized)).not.toContain("org-9999")
    expect(JSON.stringify(sanitized)).not.toContain("Users")
  })

  test("free-form text in a declared field is dropped, not forwarded", () => {
    const sanitized = sanitizePayload({
      ...valid,
      exitErrorMessage: "connect ECONNREFUSED https://acme-secret-prod.service-now.com /Users/niels/secret/path",
    })!
    expect(sanitized.exitErrorMessage).toBeUndefined()
    // The rest of the ping still goes: one bad field is not a reason to lose a session.
    expect(sanitized.exitReason).toBe("error")
  })

  test.each([
    ["a hostname as the version", { version: "dev380262.service-now.com" }],
    ["a path as the os", { os: "/Users/niels/projects" }],
    ["a hostname as the install id", { machineId: "acme-laptop-01.corp.example" }],
    ["a missing install id", { machineId: undefined }],
    ["an unknown ping type", { type: "heartbeat" }],
  ])("%s fails the whole ping", (_name, override) => {
    expect(sanitizePayload({ ...valid, ...override })).toBeUndefined()
  })

  test.each([
    ["null", null],
    ["a string", "https://acme.service-now.com"],
    ["an array", [{ ...valid }]],
    ["an object with no prototype", Object.assign(Object.create(null), valid)],
    ["nothing at all", undefined],
  ])("%s is not a payload", (_name, input) => {
    // The null-prototype case is the interesting one: it has every right field,
    // so it must be judged on its fields, not on `instanceof Object`.
    const sanitized = sanitizePayload(input)
    if (_name === "an object with no prototype") expect(sanitized).toEqual(valid)
    else expect(sanitized).toBeUndefined()
  })

  test("optional fields outside their allowlist are dropped rather than passed on", () => {
    const sanitized = sanitizePayload({
      ...valid,
      sessionId: "not-a-uuid",
      // The route defaults a missing channel to "latest", so an unusable one
      // is dropped rather than costing the whole ping.
      channel: "niels.vanderwerf@acme.example",
      installMethod: "curl",
      exitReason: "killed",
      toolCounts: { servicenow: 1, filesystem: 99, mcp: -3, builtin: Number.NaN },
    })!
    expect(sanitized.sessionId).toBeUndefined()
    expect(sanitized.channel).toBeUndefined()
    expect(sanitized.installMethod).toBeUndefined()
    expect(sanitized.exitReason).toBeUndefined()
    // An exit reason that was dropped cannot drag an error name along with it.
    expect(sanitized.exitErrorMessage).toBeUndefined()
    expect(sanitized.toolCounts).toEqual({ servicenow: 1 })
  })

  test("a start ping cannot carry end-only fields", () => {
    const sanitized = sanitizePayload({ ...valid, type: "start" })!
    expect(sanitized.type).toBe("start")
    expect(sanitized.exitReason).toBeUndefined()
    expect(sanitized.exitErrorMessage).toBeUndefined()
    expect(sanitized.toolCounts).toBeUndefined()
  })

  test("sendPing refuses a payload that fails validation", async () => {
    const portal = await startPortal()
    try {
      const sent = await sendPing(portal.url, { ...valid, machineId: "acme-laptop" } as TelemetryPayload)
      expect(sent).toBe(false)
      expect(portal.pings).toEqual([])
    } finally {
      await portal.stop()
    }
  })

  test("a hand-written pending file is sanitised before it is retried", async () => {
    // The pending file is a 0644 JSON file in a predictable directory: any
    // process running as this user can write one, and a future version of this
    // package could leave a differently-shaped one behind. Before this was
    // sanitised, the flush POSTed it verbatim — a live run put an instance
    // hostname, an org id and a path-bearing error message on the wire, and the
    // receiving route stores exitErrorMessage free-form.
    const portal = await startPortal()
    const stateDir = tempStateDir()
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(
        pendingEndPingPath(stateDir),
        JSON.stringify({
          machineId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          version: "0.2.1",
          channel: "latest",
          os: "darwin",
          arch: "arm64",
          type: "end",
          sessionDurationSec: 30,
          timestamp: Date.now(),
          exitReason: "error",
          exitErrorMessage: "INJECTED Error: connect ECONNREFUSED https://acme-secret-prod.service-now.com /Users/niels/secret",
          instanceUrl: "https://acme-secret-prod.service-now.com",
          orgId: "org-9999",
        }),
        "utf-8",
      )

      const session = createSession({ env: trackingEnv(), stateDir, portalUrl: portal.url })
      session.start()
      await session.inFlight()

      const flushed = portal.pings.find((p) => p.type === "end")!
      expect(flushed.machineId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      expect(flushed.exitErrorMessage).toBeUndefined()
      for (const key of Object.keys(flushed)) expect(PAYLOAD_KEYS).toContain(key)
      const body = portal.bodies.join("\n")
      for (const needle of ["service-now.com", "org-9999", "INJECTED", "/Users/niels"]) {
        expect(body).not.toContain(needle)
      }
      // Delivered, so nothing is left to retry.
      expect(fs.existsSync(pendingEndPingPath(stateDir))).toBe(false)
    } finally {
      await portal.stop()
    }
  })

  test.each([
    ["unparseable", "{ this is not json"],
    ["a bare string", JSON.stringify("https://acme-secret-prod.service-now.com")],
    ["missing the required fields", JSON.stringify({ exitReason: "error", exitErrorMessage: "whatever" })],
    ["a start ping", JSON.stringify({ machineId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", version: "0.2.1", os: "darwin", arch: "arm64", type: "start" })],
  ])("a pending file that is %s is deleted, never sent", async (_name, contents) => {
    const portal = await startPortal()
    const stateDir = tempStateDir()
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(pendingEndPingPath(stateDir), contents, "utf-8")

      const session = createSession({ env: trackingEnv(), stateDir, portalUrl: portal.url })
      session.start()
      await session.inFlight()

      expect(portal.pings.map((p) => p.type)).toEqual(["start"])
      expect(portal.bodies.join("\n")).not.toContain("service-now.com")
      // Deleted rather than kept, so it cannot be retried on every launch forever.
      expect(fs.existsSync(pendingEndPingPath(stateDir))).toBe(false)
    } finally {
      await portal.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

describe("delivery", () => {
  test("an end ping that fails is persisted and flushed by the next session", async () => {
    const portal = await startPortal()
    const stateDir = tempStateDir()
    try {
      portal.respondWith(500)
      const first = createSession({ env: trackingEnv(), stateDir, portalUrl: portal.url })
      first.start()
      first.recordToolCall("snow_query_table")
      first.finish("interrupt")
      await first.inFlight()

      const pendingFile = pendingEndPingPath(stateDir)
      expect(fs.existsSync(pendingFile)).toBe(true)
      const persisted = JSON.parse(fs.readFileSync(pendingFile, "utf-8")) as TelemetryPayload
      expect(persisted.type).toBe("end")
      expect(persisted.exitReason).toBe("interrupt")

      portal.pings.length = 0
      portal.respondWith(200)

      const second = createSession({ env: trackingEnv(), stateDir, portalUrl: portal.url })
      second.start()
      await second.inFlight()

      // The retried end ping arrives alongside the new session's start ping,
      // and carries the *first* session's id — not the new one.
      const retried = portal.pings.find((p) => p.type === "end")!
      expect(retried.sessionId).toBe(persisted.sessionId)
      expect(retried.toolCounts).toEqual({ servicenow: 1 })
      expect(fs.existsSync(pendingFile)).toBe(false)
    } finally {
      await portal.stop()
    }
  })

  test("a delivered end ping leaves nothing behind to retry", async () => {
    const portal = await startPortal()
    const stateDir = tempStateDir()
    try {
      const session = createSession({ env: trackingEnv(), stateDir, portalUrl: portal.url })
      session.start()
      session.finish("normal")
      await session.inFlight()
      expect(fs.existsSync(pendingEndPingPath(stateDir))).toBe(false)
    } finally {
      await portal.stop()
    }
  })

  test("a delivered session is never counted twice by the next launch", async () => {
    // Regression: a live run showed the end ping arriving with HTTP 200 while
    // `process.exit` killed the response handler before it could delete the
    // file — so the following launch re-sent it and the portal recorded the
    // session twice. Whatever the exit path, one delivery must mean one row.
    const portal = await startPortal()
    const stateDir = tempStateDir()
    try {
      const first = createSession({ env: trackingEnv(), stateDir, portalUrl: portal.url })
      first.start()
      first.recordToolCall("snow_query_table")
      first.finish("interrupt")
      await first.inFlight()
      const firstSessionId = portal.pings[0]!.sessionId

      portal.pings.length = 0
      const second = createSession({ env: trackingEnv(), stateDir, portalUrl: portal.url })
      second.start()
      await second.inFlight()

      expect(portal.pings.map((p) => p.type)).toEqual(["start"])
      expect(portal.pings.some((p) => p.sessionId === firstSessionId)).toBe(false)
    } finally {
      await portal.stop()
    }
  })

  test("a slow portal does not produce a second end row on the next launch", async () => {
    // Regression: settle capped the wait at 1s while the ping's own timeout was
    // 3s, so a portal answering in between had already *stored* the ping when
    // process.exit killed the response handler — and the next launch re-sent
    // it. Measured at a 1.2s round trip: 7 end rows for 4 real sessions, which
    // double-counts tool calls and pushes session completion over 100%.
    const portal = await startPortal()
    const stateDir = tempStateDir()
    try {
      portal.stall(true)
      const first = createSession({ env: trackingEnv(), stateDir, portalUrl: portal.url })
      first.start()
      first.recordToolCall("snow_query_table")
      first.finish("interrupt")
      await first.settle(150)

      // The portal has the ping; we simply never got to read the answer.
      expect(portal.pings.filter((p) => p.type === "end")).toHaveLength(1)
      expect(fs.existsSync(pendingEndPingPath(stateDir))).toBe(false)

      // And the hung request is released rather than left holding the process
      // open for the rest of its 3s send timeout.
      const releasedAt = Date.now()
      await first.inFlight()
      expect(Date.now() - releasedAt).toBeLessThan(500)

      portal.stall(false)
      portal.pings.length = 0
      const second = createSession({ env: trackingEnv(), stateDir, portalUrl: portal.url })
      second.start()
      await second.inFlight()
      expect(portal.pings.map((p) => p.type)).toEqual(["start"])
    } finally {
      await portal.stop()
    }
  })

  test("a portal that refuses the connection still leaves the ping to retry", async () => {
    // The other side of the trade above: "unconfirmed" only means the request
    // outlived the cap. An offline user's fetch fails in milliseconds, well
    // inside it, so their end ping is kept and delivered on the next launch.
    const stateDir = tempStateDir()
    const session = createSession({ env: trackingEnv(), stateDir, portalUrl: "http://127.0.0.1:1" })
    session.start()
    session.finish("interrupt")
    const started = Date.now()
    await session.settle(1_000)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(fs.existsSync(pendingEndPingPath(stateDir))).toBe(true)
  })

  test("settle waits for nothing when the session never sent anything", async () => {
    const session = createSession({ env: trackingEnv(), stateDir: tempStateDir(), portalUrl: "http://127.0.0.1:1" })
    const started = Date.now()
    await session.settle(5_000)
    expect(Date.now() - started).toBeLessThan(500)
  })

  test("a crash records the error class without a network call it cannot finish", async () => {
    // The uncaughtExceptionMonitor path persists and leaves delivery to the
    // next launch: the process is already dying, so a fetch there can be
    // stored by the portal and still never be confirmed — one crash, two rows.
    const portal = await startPortal()
    const stateDir = tempStateDir()
    try {
      const crashed = createSession({ env: trackingEnv(), stateDir, portalUrl: portal.url })
      crashed.start()
      crashed.recordToolCall("snow_query_table")
      crashed.persistPendingEnd("error", new TypeError("cannot read properties of undefined (reading 'sys_id')"))
      await crashed.inFlight()

      expect(portal.pings.map((p) => p.type)).toEqual(["start"])
      const persisted = JSON.parse(fs.readFileSync(pendingEndPingPath(stateDir), "utf-8")) as TelemetryPayload
      expect(persisted.exitReason).toBe("error")
      expect(persisted.exitErrorMessage).toBe("TypeError")
      expect(persisted.toolCounts).toEqual({ servicenow: 1 })

      portal.pings.length = 0
      const next = createSession({ env: trackingEnv(), stateDir, portalUrl: portal.url })
      next.start()
      await next.inFlight()

      const delivered = portal.pings.find((p) => p.type === "end")!
      expect(delivered.exitErrorMessage).toBe("TypeError")
      expect(portal.bodies.join("\n")).not.toContain("sys_id")
      expect(fs.existsSync(pendingEndPingPath(stateDir))).toBe(false)
    } finally {
      await portal.stop()
    }
  })

  test("an error object that fights back is still non-fatal", async () => {
    // `finish()` reads err.name, which runs user code. A throwing getter used
    // to take the whole call down — inside the fatal-error handler and the
    // crash monitor, the two places that must never throw.
    const portal = await startPortal()
    try {
      const hostile = new Error("boom")
      Object.defineProperty(hostile, "name", {
        get: () => {
          throw new Error("thrown from the name getter")
        },
      })

      const session = createSession({ env: trackingEnv(), stateDir: tempStateDir(), portalUrl: portal.url })
      session.start()
      expect(() => session.finish("error", hostile)).not.toThrow()
      await session.inFlight()

      const end = portal.pings.find((p) => p.type === "end")!
      expect(end.exitReason).toBe("error")
      expect(end.exitErrorMessage).toBeUndefined()
    } finally {
      await portal.stop()
    }
  })

  test("settle resolves immediately when there is no session to wait for", async () => {
    // The singleton is opted out in this process, so settle must be a no-op
    // rather than a one-second stall on every shutdown.
    const started = Date.now()
    await AnonymousTelemetry.settle(5_000)
    expect(Date.now() - started).toBeLessThan(500)
  })

  test("finish is idempotent — a session ends exactly once", async () => {
    const portal = await startPortal()
    try {
      const session = createSession({ env: trackingEnv(), stateDir: tempStateDir(), portalUrl: portal.url })
      session.start()
      session.start()
      session.finish("normal")
      session.finish("error", new Error("later"))
      session.persistPendingEnd("normal")
      await session.inFlight()

      expect(portal.pings.filter((p) => p.type === "start")).toHaveLength(1)
      expect(portal.pings.filter((p) => p.type === "end")).toHaveLength(1)
      expect(portal.pings.find((p) => p.type === "end")!.exitReason).toBe("normal")
    } finally {
      await portal.stop()
    }
  })

  test("persistPendingEnd writes synchronously, as a process 'exit' handler must", () => {
    const stateDir = tempStateDir()
    const session = createSession({
      env: trackingEnv(),
      stateDir,
      // Nothing listens here; the point is that no network is involved.
      portalUrl: "http://127.0.0.1:1",
    })
    session.persistPendingEnd("normal")
    // Asserted immediately, with no await anywhere in between.
    const persisted = JSON.parse(fs.readFileSync(pendingEndPingPath(stateDir), "utf-8")) as TelemetryPayload
    expect(persisted.type).toBe("end")
    expect(persisted.exitReason).toBe("normal")
  })

  test("an unreachable portal is silent and non-fatal", async () => {
    const stateDir = tempStateDir()
    const session = createSession({ env: trackingEnv(), stateDir, portalUrl: "http://127.0.0.1:1" })
    expect(() => {
      session.start()
      session.recordToolCall("snow_query_table")
      session.finish("normal")
    }).not.toThrow()
    await session.inFlight()
    // The end ping is still on disk, waiting for a run that can deliver it.
    expect(fs.existsSync(pendingEndPingPath(stateDir))).toBe(true)
  })

  test("an unwritable state dir disables the session instead of failing", async () => {
    const portal = await startPortal()
    try {
      // A path whose parent is a regular file: mkdir cannot succeed here.
      const blocked = path.join(tempStateDir(), "wedged")
      fs.mkdirSync(path.dirname(blocked), { recursive: true })
      fs.writeFileSync(blocked, "not a directory", "utf-8")

      const session = createSession({
        env: trackingEnv(),
        stateDir: path.join(blocked, "telemetry"),
        portalUrl: portal.url,
      })
      expect(session.enabled).toBe(false)
      expect(() => {
        session.start()
        session.finish("normal")
      }).not.toThrow()
      await session.inFlight()
      expect(portal.pings).toEqual([])
    } finally {
      await portal.stop()
    }
  })
})
