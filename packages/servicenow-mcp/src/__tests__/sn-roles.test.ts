/**
 * The roles manifest as a published artifact.
 *
 * Three things have to stay true for `sn-roles.manifest.json` to be worth
 * anything to a consumer, and none of them are checked anywhere else:
 *
 *  1. It has to reach npm. It did not: `files` shipped only `dist` and
 *     `src/agent-fragments`, so no tarball published before #294 contained a
 *     byte of it.
 *  2. The types in `sn-roles.ts` have to keep describing it. They are
 *     hand-written over an unchecked `JSON.parse`, and the data is regenerated
 *     by a manual probe run against whatever ServiceNow release is current — a
 *     `loadSnRolesManifest()` whose return type lies is worse than no type.
 *  3. It has to describe the same tools as `tools.json`.
 *
 * (3) is the one that has already gone wrong in this repo, on the other
 * manifest: `tools.json` sat at 429 tools while the tree had 437, because
 * nothing compared them (issue #294).
 * The roles manifest is a step further out of reach — it cannot be regenerated
 * in CI at all (it reads `sys_security_acl` on a live instance), so it goes
 * stale by default. This makes the gap explicit and countable instead.
 */

import { describe, expect, test } from "@jest/globals"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { loadSnRolesManifest, snRolesManifestPath, type SnRolesOperation, type SnRolesSource } from "../sn-roles"

const PACKAGE_ROOT = resolve(__dirname, "..", "..")

/**
 * Tools that exist but have no roles entry yet, because they landed after the
 * last probe run (`testedAt` in the manifest) and re-probing needs OAuth
 * credentials for a live instance — a human with an instance, not CI.
 *
 * Adding a tool means adding it here; re-running `probe:sn-roles` means
 * emptying whatever it covered back out. Both directions fail below, so this
 * list cannot quietly drift out of date the way an unchecked manifest can.
 */
const AWAITING_PROBE = [
  "snow_blast_radius_sys_properties",
  "snow_diagnose_setup",
  "snow_fluent_build",
  "snow_fluent_dependencies",
  "snow_fluent_download",
  "snow_fluent_explain",
  "snow_fluent_init",
  "snow_fluent_install",
  "snow_fluent_status",
  "snow_fluent_transform",
]

const manifest = loadSnRolesManifest()
const probed = Object.keys(manifest.tools)

const toolsJson: { groups: { tools: { name: string }[] }[] } = JSON.parse(
  readFileSync(resolve(PACKAGE_ROOT, "tools.json"), "utf8"),
)
const published = toolsJson.groups.flatMap((group) => group.tools.map((tool) => tool.name))

describe("the manifest is published, not just committed", () => {
  test("package.json ships it in the tarball", () => {
    // Without this the file reaches only the services that fetch it from main
    // over raw.githubusercontent.com, and `npm install` users — the audience
    // for exports["./sn-roles"] — get a module that throws ENOENT on first call.
    const pkg: { files: string[] } = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8"))
    expect(pkg.files).toContain("sn-roles.manifest.json")
  })

  test("the entry point resolves the package-root copy", () => {
    // `sn-roles.ts` reads `../sn-roles.manifest.json`, which lands on the
    // package root from `src/` here and from `dist/` in the tarball only
    // because tsconfig.build.json sets rootDir to src. Move the module a
    // directory deeper and both layouts break. This pins the src half only:
    // nothing in CI calls loadSnRolesManifest() against a built tarball, since
    // the publish workflow's smoke gate imports the subpath and this module
    // does no I/O at import time. The dist half was checked by hand — untar the
    // pack and import dist/sn-roles.js under node.
    expect(snRolesManifestPath).toBe(resolve(PACKAGE_ROOT, "sn-roles.manifest.json"))
  })
})

describe("the declared types still describe the data", () => {
  test("every entry matches SnRolesResolvedTool or SnRolesUntestableTool", () => {
    // The unions as `sn-roles.ts` declares them. Neither is guaranteed by its
    // producer: `methodOp` in the probe emits "unknown" for an HTTP verb it does
    // not map, which SnRolesOperation deliberately does not cover, and "none" is
    // a source the probe can write but this data has no instance of. That is
    // what keeps loadSnRolesManifest()'s return type honest across probe runs.
    const operations: SnRolesOperation[] = ["read", "create", "write", "delete"]
    const sources: SnRolesSource[] = ["direct", "inherited", "wildcard", "none"]

    const violations = Object.entries(manifest.tools).flatMap(([name, tool]) => {
      // `in` rather than a truthiness or null check: this package compiles
      // without strictNullChecks, where neither of those narrows the union.
      if ("untestable" in tool) {
        if (tool.snRoles === null && typeof tool.reason === "string" && !("primitives" in tool)) return []
        return [`${name}: untestable entry is not shaped like SnRolesUntestableTool`]
      }
      // `anyOf` always contains admin: admin bypasses ACLs outright, so a
      // resolved tool without it means the probe's rollup, not ServiceNow,
      // changed underneath these types.
      const rollup = tool.snRoles.anyOf.includes("admin")
        ? []
        : [`${name}: anyOf ${JSON.stringify(tool.snRoles.anyOf)} does not include admin`]
      return [
        ...rollup,
        ...tool.primitives.flatMap((primitive) => {
          if (!operations.includes(primitive.operation)) return [`${name}: operation "${primitive.operation}"`]
          if (!sources.includes(primitive.source)) return [`${name}: source "${primitive.source}"`]
          // inheritedFrom is the ancestor table an inherited ACL came from, so
          // it is meaningless on a direct or wildcard match and required on an
          // inherited one.
          if ((primitive.inheritedFrom !== undefined) !== (primitive.source === "inherited"))
            return [`${name}: inheritedFrom does not agree with source "${primitive.source}"`]
          return []
        }),
      ]
    })

    expect(violations).toEqual([])
  })
})

describe("tools.json and the roles manifest agree on which tools exist", () => {
  test("every published tool has a roles entry, except those awaiting the next probe", () => {
    // Failures name the fix rather than printing a bare array diff: this fires
    // on whoever adds the next tool, in a test that has nothing to do with
    // their change, and AGENTS.md is the only other place that says so.
    expect(
      published
        .filter((name) => !Object.hasOwn(manifest.tools, name) && !AWAITING_PROBE.includes(name))
        .map((name) => `${name}: no roles entry — add it to AWAITING_PROBE in this file until the next probe run`),
    ).toEqual([])
  })

  test("AWAITING_PROBE holds nothing already covered, and nothing that is no longer a tool", () => {
    expect(
      AWAITING_PROBE.filter((name) => Object.hasOwn(manifest.tools, name) || !published.includes(name)).map((name) =>
        Object.hasOwn(manifest.tools, name)
          ? `${name}: the manifest covers it now — drop it from AWAITING_PROBE`
          : `${name}: no longer a tool — drop it from AWAITING_PROBE`,
      ),
    ).toEqual([])
  })

  test("the manifest names no tool that no longer exists", () => {
    // The other direction is a harder failure: a consumer joining the two
    // manifests renders a role requirement for a tool nobody can call.
    expect(probed.filter((name) => !published.includes(name))).toEqual([])
  })

  test("stats.untestable counts what the manifest actually flags", () => {
    // Both numbers are read straight off the artifact by the portal, so a
    // half-written manifest that still parses has to fail somewhere.
    expect(manifest.stats.untestable).toBe(probed.filter((name) => "untestable" in manifest.tools[name]).length)
  })
})
