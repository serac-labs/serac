/**
 * `createHttpResolver` — contract with the MCP SDK.
 *
 * The SDK's web-standard streamable HTTP transport copies HTTP headers onto
 * `extra.requestInfo.headers`, not onto the JSON-RPC `request` object. The
 * resolver used to read from `request.headers` and ended up forwarding an
 * empty `authorization` to the upstream endpoint — portal then returned 400
 * "missing authorization in body" and the client silently fell back to the
 * direct catalog, so the HTTP transport looked "up" while actually being
 * bypassed entirely. These tests guard against that regression.
 *
 * We spin up a real HTTP echo server (Bun or Node) instead of mocking `fetch`
 * so we exercise the actual network path end-to-end.
 */

import { describe, test, expect } from "@jest/globals"
import * as http from "http"
import { AddressInfo } from "net"
import { createHttpResolver } from "../http-resolver.js"

type EchoedBody = { authorization: string }

const startEchoServer = async (): Promise<{
  url: string
  calls: EchoedBody[]
  internalAuthHeaders: string[]
  stop: () => Promise<void>
}> => {
  const calls: EchoedBody[] = []
  const internalAuthHeaders: string[] = []
  const server = http.createServer((req, res) => {
    internalAuthHeaders.push(String(req.headers["x-internal-auth"] ?? ""))
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(Buffer.from(c)))
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"))
      calls.push(body)
      // Echo the authorization back wrapped as a minimal RequestContext so the
      // resolver's downstream assertion (json parsing) doesn't break.
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          origin: "http",
          sessionId: "test",
          jwtPayload: null,
          serviceNow: { tenantId: "c:1", instanceUrl: "https://x", clientId: "", clientSecret: "" },
          echoed: body.authorization,
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/resolve`,
    calls,
    internalAuthHeaders,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

describe("createHttpResolver", () => {
  test("forwards authorization from extra.requestInfo.headers", async () => {
    const srv = await startEchoServer()
    try {
      const resolve = createHttpResolver({ url: srv.url, internalToken: "shh" })
      const result = await resolve(
        {},
        { requestInfo: { headers: { authorization: "Bearer abc.def.ghi" } } },
      )

      expect(srv.calls).toHaveLength(1)
      expect(srv.calls[0]!.authorization).toBe("Bearer abc.def.ghi")
      expect(srv.internalAuthHeaders[0]).toBe("shh")
      expect((result as any).echoed).toBe("Bearer abc.def.ghi")
    } finally {
      await srv.stop()
    }
  })

  test("falls back to request.headers for legacy callers", async () => {
    const srv = await startEchoServer()
    try {
      const resolve = createHttpResolver({ url: srv.url, internalToken: "shh" })
      await resolve({ headers: { authorization: "Bearer legacy" } })

      expect(srv.calls).toHaveLength(1)
      expect(srv.calls[0]!.authorization).toBe("Bearer legacy")
    } finally {
      await srv.stop()
    }
  })

  test("forwards empty string when neither source has authorization", async () => {
    const srv = await startEchoServer()
    try {
      const resolve = createHttpResolver({ url: srv.url, internalToken: "shh" })
      // The resolver forwards the empty token; it's the downstream endpoint
      // (the portal's /api/internal/mcp-resolve) that returns 400. We only
      // care here that we do not crash and do not silently synthesize a token.
      await resolve({}, { requestInfo: { headers: {} } })
      expect(srv.calls[0]!.authorization).toBe("")
    } finally {
      await srv.stop()
    }
  })

  test("tolerates Authorization header with uppercase A", async () => {
    const srv = await startEchoServer()
    try {
      const resolve = createHttpResolver({ url: srv.url, internalToken: "shh" })
      // The MCP SDK lowercases, but hand-built callers (tests, alternative
      // harnesses) may still pass the canonical-case form.
      await resolve({}, { requestInfo: { headers: { Authorization: "Bearer upper" } } })
      expect(srv.calls[0]!.authorization).toBe("Bearer upper")
    } finally {
      await srv.stop()
    }
  })

  test("throws when endpoint returns non-2xx", async () => {
    // A server that always responds 400 — we expect the resolver to surface it.
    const server = http.createServer((_req, res) => {
      res.statusCode = 400
      res.end("missing authorization in body")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const resolve = createHttpResolver({
        url: `http://127.0.0.1:${port}/resolve`,
        internalToken: "shh",
      })
      await expect(
        resolve({}, { requestInfo: { headers: { authorization: "Bearer x" } } }),
      ).rejects.toThrow(/mcp-resolver endpoint returned 400/)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
