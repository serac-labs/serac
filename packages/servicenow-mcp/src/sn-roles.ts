/**
 * Typed access to `sn-roles.manifest.json` — which ServiceNow roles each `snow_*`
 * tool actually requires.
 *
 * The manifest is empirical, not documentation-derived: `script/probe-sn-roles`
 * resolves every (table, operation) pair a tool touches against a live
 * instance's `sys_security_acl`, which is the same data ServiceNow's own auth
 * engine consults at request time. That is also why it cannot be regenerated in
 * CI, and why `validatedOn` / `testedAt` are part of the payload — they are the
 * only staleness signal a consumer gets. See README.md, "The roles manifest".
 *
 * This module sits at the top of `src/` rather than under `shared/` because the
 * manifest sits at the package root — live services fetch it from `main` at a
 * literal raw.githubusercontent.com URL, so it cannot move. `../` from here
 * resolves to that root both from `src/` and from the published `dist/`.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** The four operations the probe maps HTTP verbs onto: GET, POST, PATCH/PUT, DELETE. */
export type SnRolesOperation = "read" | "create" | "write" | "delete"

/**
 * How the ACL that answered for a primitive was found:
 * `direct` on the table itself, `inherited` from a `sys_db_object.super_class`
 * ancestor, or `wildcard` from the `*` ACL.
 */
export type SnRolesSource = "direct" | "inherited" | "wildcard"

/** One (table, operation) pair a tool performs, with the roles the instance's ACLs accept for it. */
export interface SnRolesPrimitive {
  table: string
  operation: SnRolesOperation
  /** Roles OR-combined across every matching ACL: holding any one of them satisfies this primitive. */
  roles: string[]
  source: SnRolesSource
  /** Only present when `source` is `inherited`: the ancestor table the ACL came from. */
  inheritedFrom?: string
  /**
   * How many of the matching ACLs carry a condition or advanced script. Those
   * run per record and the probe cannot evaluate them, so `scriptAcls > 0` means
   * the role list is necessary but may not be sufficient at runtime.
   */
  scriptAcls: number
}

/** The two role rollups, both computed from the tool's `primitives`. */
export interface SnRolesRequirement {
  /**
   * Single roles that ALONE suffice for the whole tool — the intersection of every
   * primitive's role list, plus `admin`, which bypasses ACLs entirely. `["admin"]`
   * on its own means no single non-admin role covers the tool.
   */
  anyOf: string[]
  /**
   * Smallest set of roles a user needs TOGETHER to cover every primitive (greedy
   * set-cover). `[]` means the tool needs no authenticated role at all; `["admin"]`
   * means some primitive is admin-only. `admin` remains an implicit alternative
   * whatever this says.
   */
  minimumBundle: string[]
}

/** A tool whose ServiceNow table calls were found and resolved against the instance's ACLs. */
export interface SnRolesResolvedTool {
  snRoles: SnRolesRequirement
  primitives: SnRolesPrimitive[]
}

/**
 * A tool the probe could not place: static analysis found no
 * `/api/now/table/<table>` call in its source, so there is no ACL to resolve.
 * That covers tools that only call scripted/other REST APIs, tools that are pure
 * local computation, and tools whose table is assembled at runtime — so
 * "untestable" means "not measurable by this method", NOT "needs no role".
 */
export interface SnRolesUntestableTool {
  snRoles: null
  untestable: true
  reason: string
}

/**
 * Narrow with `"untestable" in tool`, which works whether or not the consumer
 * compiles with `strictNullChecks` — `tool.snRoles === null` only narrows with
 * it on, and this package itself compiles with it off.
 */
export type SnRolesTool = SnRolesResolvedTool | SnRolesUntestableTool

export interface SnRolesStats {
  /** Tools in `tools`, including the untestable ones. */
  tools: number
  untestable: number
  /** Distinct (table, operation) pairs across all tools. */
  primitivesTotal: number
  /** How many of those the probe got an ACL answer for. Below `primitivesTotal` means a partial run. */
  primitivesResolved: number
  /**
   * Counted per primitive OCCURRENCE, so it sums to more than `primitivesTotal`:
   * a table read by twenty tools is counted twenty times.
   */
  sourceDistribution: Record<string, number>
  /**
   * Most frequently required roles. `tools` is a misnomer inherited from the
   * probe: it counts distinct PRIMITIVES whose ACLs accept the role, not tools.
   */
  topRoles: { role: string; tools: number }[]
}

export interface SnRolesManifest {
  /** Schema version of this file. Bumped when the shape changes, not when the data is re-probed. */
  version: number
  /**
   * The ServiceNow release the data was read from, as the instance reports it
   * (`glide-<family>-<build dates>.zip`). Roles move between releases, so this —
   * not `testedAt` — is what tells a reader whether the data still applies to
   * their instance.
   */
  validatedOn: string
  /** When the probe ran, ISO-8601. */
  testedAt: string
  stats: SnRolesStats
  /** Keyed by tool name (`snow_*`). A tool absent here has not been probed yet. */
  tools: Record<string, SnRolesTool>
}

/**
 * Absolute path to the manifest inside the installed package, for consumers that
 * want to stream, hash or serve the file rather than parse it.
 */
export const snRolesManifestPath = fileURLToPath(new URL("../sn-roles.manifest.json", import.meta.url))

/**
 * Read and parse the manifest that shipped with this package.
 *
 * Re-reads and re-parses ~420 kB on every call — hold the result rather than
 * calling it per tool. Throws if the manifest is not in the installed package;
 * `files` in package.json ships it, and the tarball gate in
 * `.github/workflows/publish-mcp.yml` is what keeps that true.
 */
export const loadSnRolesManifest = (): SnRolesManifest => JSON.parse(readFileSync(snRolesManifestPath, "utf8"))
