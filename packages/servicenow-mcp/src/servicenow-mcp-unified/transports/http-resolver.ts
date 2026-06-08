/**
 * Generic HTTP-callback context resolver.
 *
 * Called by the mcp-http container for every inbound MCP request. Instead
 * of resolving the tenant + credentials locally (which would require the
 * OS image to know about the portal DB schema + KMS), this helper forwards
 * the inbound Bearer JWT to a caller-configured endpoint that performs the
 * real resolution. The endpoint is expected to return a JSON body shaped
 * exactly like `RequestContext`.
 *
 * Design intent
 * -------------
 * The OS repo ships the MCP infrastructure but knows nothing about how
 * tenants are identified or where their ServiceNow credentials live. A
 * downstream deployment (e.g. snow-flow-enterprise) runs this image as the
 * `mcp-http` container, points `MCP_RESOLVER_URL` at its own HTTP endpoint,
 * and hands out a shared-secret token so only the mcp-http container can
 * call that endpoint.
 *
 * Env vars consumed by `createHttpResolver()`:
 *   MCP_RESOLVER_URL      — full URL of the downstream resolver endpoint
 *   MCP_INTERNAL_TOKEN    — shared secret the endpoint verifies on the
 *                           `X-Internal-Auth` header. Keeps the endpoint
 *                           closed to anyone else on the docker network.
 */

import { ContextResolver } from "../handlers/types.js"

export interface HttpResolverOptions {
  /**
   * Full URL of the resolver endpoint. Example:
   *   http://portal:3000/api/internal/mcp-resolve
   */
  url: string

  /**
   * Shared secret set in `X-Internal-Auth` on every call. Must match the
   * value configured on the resolver endpoint side.
   */
  internalToken: string

  /**
   * Per-call timeout in ms. Defaults to 5000.
   */
  timeoutMs?: number
}

/**
 * Build a `ContextResolver` that forwards each inbound request to
 * `opts.url`. The returned function is the exact type `createHttpApp`
 * expects for its `resolveContext` dependency.
 *
 * HTTP headers live on `extra.requestInfo.headers` — the MCP SDK's
 * web-standard streamable HTTP transport copies them off the Fetch API
 * Request there before invoking the handler. The JSON-RPC `request`
 * param carries only the protocol message body and never HTTP metadata,
 * so we have to consult `extra` (and only fall back to `request.headers`
 * to stay compatible with older call sites that pass headers inline).
 */
export const createHttpResolver = (opts: HttpResolverOptions): ContextResolver => {
  const timeoutMs = opts.timeoutMs ?? 5000

  return async (request: any, extra?: any) => {
    // Headers are always lowercased by the SDK (Fetch API Headers iterator),
    // but keep the Authorization/AUTHORIZATION fallbacks to tolerate callers
    // that build `extra` by hand in tests.
    const headers = extra?.requestInfo?.headers ?? (request as any)?.headers ?? {}
    // Forward the caller's Bearer token verbatim — the resolver endpoint
    // is the thing that knows how to verify it.
    const authorization =
      headers.authorization ?? headers.Authorization ?? headers.AUTHORIZATION ?? ""

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(opts.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth": opts.internalToken,
        },
        body: JSON.stringify({ authorization }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(
          `mcp-resolver endpoint returned ${response.status}: ${body.slice(0, 200)}`,
        )
      }

      return (await response.json()) as Awaited<ReturnType<ContextResolver>>
    } finally {
      clearTimeout(timer)
    }
  }
}
