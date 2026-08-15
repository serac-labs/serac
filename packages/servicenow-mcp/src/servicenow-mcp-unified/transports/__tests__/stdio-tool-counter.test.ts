/**
 * The stdio tool-call counter.
 *
 * `startStdio({ onToolCall })` calls this on every `tools/call` it resolves.
 * These tests feed it the JSON-RPC request shapes the MCP SDK actually hands
 * to the resolver, and run the result through the real telemetry session, to
 * show that (a) lazy-mode `tool_execute` traffic is attributed to ServiceNow
 * rather than to meta plumbing, and (b) only counts survive the trip.
 */

import { describe, test, expect } from "@jest/globals"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"
import { AddressInfo } from "net"

import { invokedToolName } from "../stdio.js"
import { createSession, type TelemetryPayload } from "../../../telemetry/anonymous-telemetry.js"

describe("invokedToolName", () => {
  test("returns the tool for a direct call", () => {
    expect(invokedToolName({ method: "tools/call", params: { name: "snow_query_table", arguments: { table: "incident" } } })).toBe(
      "snow_query_table",
    )
  })

  test("unwraps the lazy-mode tool_execute envelope", () => {
    const request = {
      method: "tools/call",
      params: {
        name: "tool_execute",
        arguments: { tool: "snow_create_incident", args: { short_description: "printer on fire" } },
      },
    }
    expect(invokedToolName(request)).toBe("snow_create_incident")
  })

  test("falls back to the wrapper when the envelope has no usable target", () => {
    expect(invokedToolName({ method: "tools/call", params: { name: "tool_execute", arguments: {} } })).toBe("tool_execute")
    expect(invokedToolName({ method: "tools/call", params: { name: "tool_execute", arguments: { tool: 42 } } })).toBe(
      "tool_execute",
    )
  })

  test("ignores everything that is not a tool call", () => {
    expect(invokedToolName({ method: "tools/list" })).toBeUndefined()
    expect(invokedToolName({ method: "prompts/get", params: { name: "whatever" } })).toBeUndefined()
    expect(invokedToolName(undefined)).toBeUndefined()
    expect(invokedToolName({ method: "tools/call", params: {} })).toBeUndefined()
  })
})

describe("counter feeds telemetry as counts only", () => {
  test("a realistic request stream becomes per-category totals", async () => {
    const pings: TelemetryPayload[] = []
    const bodies: string[] = []
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(Buffer.from(c)))
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8")
        bodies.push(raw)
        pings.push(JSON.parse(raw) as TelemetryPayload)
        res.statusCode = 200
        res.end(JSON.stringify({ success: true }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const stateDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "serac-stdio-counter-")), "state")

    try {
      const session = createSession({
        env: { DO_NOT_TRACK: "", CI: "", SERAC_TELEMETRY_DISABLED: "" },
        stateDir,
        portalUrl: url,
      })
      const onToolCall = session.recordToolCall

      // Exactly what the resolver sees during one working session.
      const requests = [
        { method: "tools/list" },
        { method: "tools/call", params: { name: "tool_search", arguments: { query: "create incident" } } },
        {
          method: "tools/call",
          params: { name: "tool_execute", arguments: { tool: "snow_create_incident", args: { short_description: "vpn down" } } },
        },
        {
          method: "tools/call",
          params: { name: "tool_execute", arguments: { tool: "snow_query_table", args: { table: "incident", query: "active=true" } } },
        },
        { method: "tools/call", params: { name: "snow_update_set_create", arguments: { name: "STORY-42" } } },
      ]

      session.start()
      for (const request of requests) {
        const invoked = invokedToolName(request)
        if (invoked) onToolCall(invoked)
      }
      session.finish("normal")
      await session.inFlight()

      const end = pings.find((p) => p.type === "end")!
      // 3 snow_* (two of them unwrapped from tool_execute) + 1 tool_search.
      expect(end.toolCounts).toEqual({ servicenow: 3, mcp: 1 })

      const body = bodies.join("\n")
      for (const needle of ["snow_create_incident", "snow_query_table", "snow_update_set_create", "tool_search", "vpn down", "STORY-42", "active=true"]) {
        expect(body).not.toContain(needle)
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(path.dirname(stateDir), { recursive: true, force: true })
    }
  })
})
