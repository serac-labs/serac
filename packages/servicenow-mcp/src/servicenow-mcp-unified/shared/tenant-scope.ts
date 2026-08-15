/**
 * The tenancy rule for every piece of cross-request state in this package,
 * in one place.
 *
 *   stdio — single-tenant by construction: one process, one user, one set of
 *           ServiceNow credentials. The `"stdio"` sentinel is a real tenant
 *           boundary there, so in-process state may be shared across requests.
 *   http  — multi-tenant by design: one process serves every customer. A
 *           missing tenantId is therefore never a licence to fall back to a
 *           shared literal — two customers would land in the same bucket,
 *           which is a cross-tenant leak, not a cache miss.
 *
 * Two functions, and the split between them is the point:
 *
 *   resolveTenantScope() — WHO is this request? Returns the raw tenant id,
 *     the stdio sentinel, or `undefined` for "cannot be placed in a tenant".
 *     It returns the id verbatim so that every reader and writer of the same
 *     store computes the same string. (An earlier revision percent-encoded
 *     here; `handlers/list-tools.ts` and `handlers/call-tool.ts` read the same
 *     store with the raw id, so the encoding put the writer and the readers in
 *     different namespaces — `tool_search` reported `[ENABLED]` for tools the
 *     next `tools/list` did not return.)
 *
 *   tenantScopedKey()   — WHERE does this go? Composes a flat cache key out of
 *     a scope plus whatever else the cache is keyed on. Escaping belongs here,
 *     at the composition site, because composition is the only place a
 *     separator can be spoofed.
 *
 * This module has no imports and no module-level state on purpose: everything
 * that keys state on a tenant can depend on it without a cycle.
 */

/**
 * Sentinel tenant ID used for the single-user stdio transport. Never valid as
 * a fallback in HTTP context.
 */
export const STDIO_TENANT = "stdio"

/**
 * Returns the scope to key state on, or `undefined` when the caller cannot be
 * placed in a tenant. `undefined` means fail closed: refuse the operation, or
 * skip the shared state and do the work uncached. Never substitute a constant.
 *
 * A context with no `origin` at all (an embedder calling a tool executor
 * directly) counts as unprovable — we cannot show it is single-tenant.
 */
export function resolveTenantScope(context: { tenantId?: string; origin?: "stdio" | "http" }): string | undefined {
  if (context.tenantId) return context.tenantId
  if (context.origin === "stdio") return STDIO_TENANT
  return undefined
}

/**
 * Compose a flat cache key from a tenant scope and any further components.
 *
 * Every component is percent-encoded before being joined with a NUL, so:
 *
 *   - the separator cannot appear inside a component, and no component can
 *     therefore address another component's slot. The shape that matters is
 *     not the obvious one: tenant `1042` + instance `X\x00Y` and tenant
 *     `1042\x00X` + instance `Y` both flatten to `1042\x00X\x00Y` under naive
 *     concatenation — one tenant reading another tenant's entry;
 *   - the mapping is injective, unlike the `.replace(/[\x00:]/g, "_")` these
 *     call sites used to do. That replacement mapped `c:1042` and `c_1042`
 *     onto one key — and in `shared/auth.ts` the value behind that key is an
 *     OAuth token and an authenticated Axios client, so the collision it was
 *     written to prevent was the collision it caused. `encodeURIComponent`
 *     escapes `%` itself, so distinct inputs stay distinct.
 *
 * `undefined` components normalise to the empty string rather than the string
 * "undefined", so a caller with no instance URL cannot collide with one whose
 * instance URL is literally "undefined".
 */
export function tenantScopedKey(scope: string, ...parts: Array<string | undefined>): string {
  return [scope, ...parts].map((part) => encodeURIComponent(part ?? "")).join("\x00")
}
