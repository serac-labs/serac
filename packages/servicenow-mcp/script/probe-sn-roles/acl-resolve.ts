/**
 * Resolve the minimum SN roles per (table, operation) by reading SN's actual
 * ACL definitions directly. This is more accurate than empirical probing
 * because we read SN's source of truth — the `sys_security_acl` table and its
 * `sys_security_acl_role` join — exactly the rules SN's auth engine evaluates.
 *
 * Resolution order per (table, op):
 *   1. Direct: ACLs where `name == <table>` and `operation == <op>`, active=true
 *   2. Inherited: walk up `sys_db_object.super_class` and re-resolve
 *   3. Wildcard: ACLs where `name == "*"` and matching op
 *   4. None: fall back to `["admin"]` (SN's implicit deny rule)
 *
 * Multiple ACLs are OR-combined: any role in any matching ACL grants access
 * (modulo conditions and scripts, which we don't evaluate — see `scriptAcls`).
 */

import { adminHeaders, snFetch, type Env } from "./sn.ts"

export interface Resolved {
  table: string
  operation: string
  roles: string[] // sorted, deduped, excludes empty strings
  source: "direct" | "inherited" | "wildcard" | "none"
  inheritedFrom?: string // when source === "inherited", the parent table that supplied the roles
  scriptAcls: number // count of script-bearing ACLs (extra gating beyond role check)
  totalAcls: number
}

const parentCache = new Map<string, string | null>()
const resolveCache = new Map<string, Resolved>()

async function getHeader(env: Env): Promise<string> {
  const h = await adminHeaders(env)
  return (h as Record<string, string>).Authorization
}

async function parentOf(env: Env, table: string): Promise<string | null> {
  if (parentCache.has(table)) return parentCache.get(table)!
  const hdr = await getHeader(env)
  const r = await snFetch<{ result: { super_class: { value: string } | string | null }[] }>(
    env,
    "GET",
    `/api/now/table/sys_db_object?sysparm_query=name=${encodeURIComponent(table)}&sysparm_fields=super_class&sysparm_display_value=all&sysparm_limit=1`,
    hdr,
  )
  const sup = r.data?.result?.[0]?.super_class
  const id = typeof sup === "object" && sup ? sup.value : typeof sup === "string" ? sup : null
  if (!id) {
    parentCache.set(table, null)
    return null
  }
  // super_class is itself a sys_id pointing back to sys_db_object — resolve to the table name
  const r2 = await snFetch<{ result: { name: string }[] }>(
    env,
    "GET",
    `/api/now/table/sys_db_object?sysparm_query=sys_id=${id}&sysparm_fields=name&sysparm_limit=1`,
    hdr,
  )
  const parent = r2.data?.result?.[0]?.name ?? null
  parentCache.set(table, parent)
  return parent
}

async function aclsFor(
  env: Env,
  table: string,
  op: string,
): Promise<{ roles: string[]; total: number; scripts: number }> {
  const hdr = await getHeader(env)
  const tableEnc = encodeURIComponent(table)
  // Two queries — kept simple, parallelised:
  const [aclResp, roleResp] = await Promise.all([
    snFetch<{ result: { sys_id: string; script: string }[] }>(
      env,
      "GET",
      `/api/now/table/sys_security_acl?sysparm_query=name=${tableEnc}^operation=${op}^active=true&sysparm_fields=sys_id,script&sysparm_limit=100`,
      hdr,
    ),
    snFetch<{ result: { sys_user_role: { display_value: string } | null }[] }>(
      env,
      "GET",
      `/api/now/table/sys_security_acl_role?sysparm_query=sys_security_acl.name=${tableEnc}^sys_security_acl.operation=${op}^sys_security_acl.active=true&sysparm_fields=sys_user_role&sysparm_display_value=all&sysparm_limit=200`,
      hdr,
    ),
  ])
  const acls = aclResp.data?.result ?? []
  const roles = [
    ...new Set((roleResp.data?.result ?? []).map((r) => r.sys_user_role?.display_value ?? "").filter(Boolean)),
  ]
  return {
    roles,
    total: acls.length,
    scripts: acls.filter((a) => a.script && a.script.trim()).length,
  }
}

export async function resolve(env: Env, table: string, op: string): Promise<Resolved> {
  const key = `${table}:${op}`
  if (resolveCache.has(key)) return resolveCache.get(key)!

  const direct = await aclsFor(env, table, op)
  if (direct.total > 0) {
    const out: Resolved = {
      table,
      operation: op,
      roles: direct.roles.sort(),
      source: "direct",
      scriptAcls: direct.scripts,
      totalAcls: direct.total,
    }
    resolveCache.set(key, out)
    return out
  }

  const parent = await parentOf(env, table)
  if (parent && parent !== table) {
    const inherited = await resolve(env, parent, op)
    if (inherited.source !== "none") {
      const out: Resolved = {
        ...inherited,
        table,
        source: "inherited",
        inheritedFrom: parent,
      }
      resolveCache.set(key, out)
      return out
    }
  }

  const wild = await aclsFor(env, "*", op)
  if (wild.total > 0) {
    const out: Resolved = {
      table,
      operation: op,
      roles: wild.roles.sort(),
      source: "wildcard",
      scriptAcls: wild.scripts,
      totalAcls: wild.total,
    }
    resolveCache.set(key, out)
    return out
  }

  const fallback: Resolved = { table, operation: op, roles: ["admin"], source: "none", scriptAcls: 0, totalAcls: 0 }
  resolveCache.set(key, fallback)
  return fallback
}
