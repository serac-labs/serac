/**
 * Tenant-scoped cache.
 *
 * Wraps a two-level Map<tenantId, Map<key, value>> so that cached entries
 * from different tenants can never collide or be looked up cross-tenant —
 * even if two tenants happen to produce the same sub-key (e.g. same
 * ServiceNow instance URL).
 *
 * Use this anywhere in `shared/` that previously held a flat
 * `Map<string, V>` keyed only by instance URL, session ID, or similar
 * non-tenant-scoped identifier. The nested Map layout deliberately avoids
 * composed string keys (`${tenantId}:${key}`) so there are no escape bugs
 * if a tenant ID or sub-key happens to contain a colon.
 *
 * Stdio callers can pass a fixed sentinel like `"stdio"` as tenantId.
 */
export class TenantScopedCache<V> {
  private readonly inner = new Map<string, Map<string, V>>()

  get(tenantId: string, key: string): V | undefined {
    return this.inner.get(tenantId)?.get(key)
  }

  set(tenantId: string, key: string, value: V): void {
    let tenant = this.inner.get(tenantId)
    if (!tenant) {
      tenant = new Map<string, V>()
      this.inner.set(tenantId, tenant)
    }
    tenant.set(key, value)
  }

  has(tenantId: string, key: string): boolean {
    return this.inner.get(tenantId)?.has(key) ?? false
  }

  delete(tenantId: string, key: string): boolean {
    return this.inner.get(tenantId)?.delete(key) ?? false
  }

  /**
   * Remove every entry belonging to the given tenant.
   * Returns true if the tenant had any entries, false otherwise.
   */
  invalidateTenant(tenantId: string): boolean {
    return this.inner.delete(tenantId)
  }

  clear(): void {
    this.inner.clear()
  }

  get size(): number {
    let total = 0
    for (const tenant of this.inner.values()) {
      total += tenant.size
    }
    return total
  }

  /**
   * Iterate a single tenant's entries. Useful for tests and debug logging.
   * Returns an empty iterator when the tenant has no entries.
   */
  entriesFor(tenantId: string): IterableIterator<[string, V]> {
    const tenant = this.inner.get(tenantId)
    return tenant ? tenant.entries() : new Map<string, V>().entries()
  }
}
