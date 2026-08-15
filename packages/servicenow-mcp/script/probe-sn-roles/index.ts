#!/usr/bin/env bun
/**
 * sn-role-probe orchestrator.
 *
 * For every MCP tool, resolves the minimum SN role(s) required to invoke it by
 * reading the live instance's ACL definitions (`sys_security_acl` +
 * `sys_security_acl_role`). Emits `packages/servicenow-mcp/sn-roles.manifest.json`,
 * which is fetched from main at runtime by the Serac Portal's tool-permissions
 * proxy and by docs.serac.build.
 *
 * Unlike tools.json this cannot be regenerated in CI: it needs OAuth
 * credentials for a live ServiceNow instance, so it is a deliberate manual run
 * against a known release. Re-run and diff after a ServiceNow family upgrade.
 *
 *   bun run --cwd packages/servicenow-mcp probe:sn-roles
 *
 * See ./README.md for env setup.
 */

import { join, dirname, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { extract, type Extraction } from "./extract.ts"
import { resolve, type Resolved } from "./acl-resolve.ts"
import { loadEnv, adminToken, detectRelease, type Env } from "./sn.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = join(HERE, "..", "..", "sn-roles.manifest.json")

const BATCH = 8 // parallel ACL queries per batch

interface ManifestTool {
  snRoles: {
    /** Single roles that alone suffice for the entire tool. Always includes `admin`. */
    anyOf: string[]
    /** Smallest role-bundle that together grants access to every primitive. User
     *  needs ALL roles in this array. Computed via greedy set-cover.
     *  `admin` is implicitly always a working alternative, regardless of bundle. */
    minimumBundle: string[]
  } | null
  untestable?: boolean
  reason?: string
  primitives?: {
    table: string
    operation: string
    roles: string[]
    source: Resolved["source"]
    inheritedFrom?: string
    scriptAcls: number
  }[]
}

interface Manifest {
  version: number
  validatedOn: string
  testedAt: string
  stats: {
    tools: number
    untestable: number
    primitivesTotal: number
    primitivesResolved: number
    sourceDistribution: Record<string, number>
    topRoles: { role: string; tools: number }[]
  }
  tools: Record<string, ManifestTool>
}

function chunks<T>(arr: T[], n: number): T[][] {
  return Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))
}

/**
 * Greedy set-cover: smallest list of roles such that for every input role-set,
 * the chosen list contains at least one of its roles. Deterministic via
 * alphabetical tie-breaking.
 */
function greedyCover(roleSets: string[][]): string[] {
  const remaining = new Set(roleSets.map((_, i) => i).filter((i) => roleSets[i].length > 0))
  const picked: string[] = []
  while (remaining.size > 0) {
    const count = new Map<string, number>()
    for (const i of remaining) {
      for (const r of roleSets[i]) count.set(r, (count.get(r) ?? 0) + 1)
    }
    if (count.size === 0) break
    const best = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    picked.push(best)
    for (const i of [...remaining]) {
      if (roleSets[i].includes(best)) remaining.delete(i)
    }
  }
  return picked.sort()
}

/**
 * Compute the lowest-privilege role bundle that grants access to all primitives.
 *
 * Two ACL-side roles get special treatment:
 *  - `public` is SN's "no auth required" marker, not a role users hold. A primitive
 *    with `public` in its role list is satisfied by any caller (including
 *    unauthenticated), so we drop those primitives from the cover problem.
 *  - `admin` bypasses every ACL implicitly. Listing it explicitly in a bundle is
 *    redundant unless a primitive's ACL has admin-only — in that case we can't
 *    avoid admin and return `["admin"]` alone.
 *
 * Returns `[]` when the entire tool is publicly accessible.
 */
function minimumBundle(roleSets: string[][]): string[] {
  if (roleSets.length === 0) return ["admin"]
  const needsAuth = roleSets.filter((rs) => !rs.includes("public"))
  if (needsAuth.length === 0) return []
  const nonAdmin = needsAuth.map((rs) => rs.filter((r) => r !== "admin"))
  if (nonAdmin.some((rs) => rs.length === 0)) return ["admin"]
  const cover = greedyCover(nonAdmin)
  return cover.length > 0 ? cover : ["admin"]
}

async function resolveAll(
  env: Env,
  primitives: { table: string; operation: string }[],
): Promise<Map<string, Resolved>> {
  const out = new Map<string, Resolved>()
  const total = primitives.length
  const progress = { done: 0 }
  for (const batch of chunks(primitives, BATCH)) {
    const results = await Promise.all(batch.map((p) => resolve(env, p.table, p.operation)))
    batch.forEach((p, i) => {
      out.set(`${p.table}:${p.operation}`, results[i])
      progress.done += 1
    })
    if (progress.done % 40 === 0 || progress.done === total) {
      console.log(`  resolved ${progress.done} / ${total}`)
    }
  }
  return out
}

function topRoles(resolved: Map<string, Resolved>, n: number): { role: string; tools: number }[] {
  const counts = new Map<string, number>()
  for (const r of resolved.values()) {
    for (const role of r.roles) counts.set(role, (counts.get(role) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([role, tools]) => ({ role, tools }))
}

function buildManifest(extraction: Extraction, resolved: Map<string, Resolved>, release: string): Manifest {
  const tools: Record<string, ManifestTool> = {}
  const sourceDist: Record<string, number> = {}

  for (const [name, tool] of Object.entries(extraction.tools)) {
    const tableCalls = tool.calls.filter((c) => c.table)
    if (tableCalls.length === 0) {
      tools[name] = {
        snRoles: null,
        untestable: true,
        reason: "no /api/now/table/<table> calls detected in static analysis",
      }
      continue
    }
    const perPrim = tableCalls
      .map((c) => {
        const r = resolved.get(`${c.table}:${methodOp(c.method)}`)
        if (!r) return null
        sourceDist[r.source] = (sourceDist[r.source] ?? 0) + 1
        return {
          table: c.table!,
          operation: methodOp(c.method),
          roles: r.roles,
          source: r.source,
          inheritedFrom: r.inheritedFrom,
          scriptAcls: r.scriptAcls,
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)

    // `anyOf` — single roles that alone suffice for the WHOLE tool. This is the
    // intersection across all primitive role sets, plus `admin` (which bypasses
    // ACLs and therefore always works regardless of per-ACL role lists).
    const sets = perPrim.map((p) => new Set(p.roles))
    const intersection = sets.length === 0 ? [] : [...sets[0]].filter((r) => sets.every((s) => s.has(r)))
    const anyOf = [...new Set([...intersection, "admin"])].sort()

    // `minimumBundle` — smallest set of roles that together cover every primitive.
    // Useful for tools where no single non-admin role suffices, e.g. multi-table
    // tools that need ITIL + a write role on a separate table. Admin bypasses
    // ACLs so it's always an implicit alternative regardless of bundle.
    tools[name] = {
      snRoles: { anyOf, minimumBundle: minimumBundle(perPrim.map((p) => p.roles)) },
      primitives: perPrim,
    }
  }

  const stats = {
    tools: Object.keys(extraction.tools).length,
    untestable: extraction.untestable.length,
    primitivesTotal: Object.keys(extraction.primitives).length,
    primitivesResolved: resolved.size,
    sourceDistribution: sourceDist,
    topRoles: topRoles(resolved, 15),
  }

  return {
    version: 1,
    validatedOn: release,
    testedAt: new Date().toISOString(),
    stats,
    tools,
  }
}

function methodOp(method: string): string {
  if (method === "GET") return "read"
  if (method === "POST") return "create"
  if (method === "PATCH" || method === "PUT") return "write"
  if (method === "DELETE") return "delete"
  return "unknown"
}

async function main() {
  console.log("=== sn-role-probe (ACL-based) ===")
  const env = await loadEnv()
  console.log(`instance: ${env.url}`)

  await adminToken(env)
  console.log("admin auth: ok")

  const release = await detectRelease(env)
  console.log(`release:   ${release}`)

  console.log("extracting primitives from tool sources…")
  const extraction = await extract()
  const primitives = Object.values(extraction.primitives)
  console.log(`  tools:      ${Object.keys(extraction.tools).length}`)
  console.log(`  primitives: ${primitives.length}`)
  console.log(`  untestable: ${extraction.untestable.length}`)
  console.log("")

  console.log("resolving ACLs…")
  const resolved = await resolveAll(env, primitives)
  console.log(`  ${resolved.size} primitives resolved`)
  console.log("")

  const manifest = buildManifest(extraction, resolved, release)
  const contents = JSON.stringify(manifest, null, 2) + "\n"
  await Bun.write(MANIFEST_PATH, contents)
  console.log(`manifest:  ${relative(process.cwd(), MANIFEST_PATH)}`)
  console.log(`           the portal and docs.serac.build fetch this from main — commit it.`)
  console.log("")
  console.log("stats:")
  console.log(JSON.stringify(manifest.stats, null, 2))
}

await main()
