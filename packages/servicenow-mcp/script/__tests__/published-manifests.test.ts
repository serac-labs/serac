/**
 * Presence and shape guard for the two manifests that are published BY BEING
 * COMMITTED.
 *
 * `tools.json` and `sn-roles.manifest.json` reach production a way no build gate
 * sees: live services fetch them from `main` over raw.githubusercontent.com. See
 * README.md, "Published manifests". (`sn-roles.manifest.json` is in the npm
 * tarball as well — `files` ships it for the `/sn-roles` subpath — but that is a
 * second audience, not the one below.)
 *
 * That makes them the one part of this package where deleting a file is a
 * production incident rather than a failing build, and where the failure is
 * invisible here:
 *
 *   - `tools.json`             docs.serac.build's Complete Tool Reference.
 *                              Hard failure, immediate, every visitor.
 *   - `sn-roles.manifest.json` the Portal's tool-permissions API. Cached 30
 *                              min and served stale on a bad fetch, so it
 *                              breaks at the next cold start — days later,
 *                              looking like an unrelated deploy regression.
 *
 * Both files were moved here out of the deleted `packages/opencode`. During
 * that move they existed only as UNTRACKED files: every build gate passed, and
 * a `git commit -am` would have shipped the deletion of the old path with no
 * new path to replace it. Nothing in the test suite noticed, because nothing
 * imports these files.
 *
 * This test is what notices. It fails if either manifest is missing, is not
 * valid JSON, or has lost the top-level shape its consumers destructure. It
 * deliberately asserts nothing about freshness — drift is
 * `generate:tools-json:check`'s job, which CI runs separately — so this stays
 * a fast structural check that cannot be skipped by a stale-but-present file.
 */

import { describe, expect, test } from "@jest/globals"
import * as fs from "fs"
import * as path from "path"

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..")

const readManifest = (file: string): unknown => {
  const absolute = path.join(PACKAGE_ROOT, file)
  // Deliberately not fs.existsSync + read: a missing file must surface as this
  // assertion, naming the path, rather than as a JSON.parse stack trace.
  expect(fs.existsSync(absolute)).toBe(true)
  return JSON.parse(fs.readFileSync(absolute, "utf8"))
}

describe("published manifests are present and well-formed", () => {
  test("tools.json carries the shape docs.serac.build destructures", () => {
    const manifest = readManifest("tools.json") as {
      generatedAt: string
      count: number
      groups: { name: string; displayName: string; tools: { name: string }[] }[]
    }

    expect(typeof manifest.generatedAt).toBe("string")
    expect(Array.isArray(manifest.groups)).toBe(true)
    expect(manifest.groups.length).toBeGreaterThan(0)

    for (const group of manifest.groups) {
      expect(typeof group.name).toBe("string")
      expect(typeof group.displayName).toBe("string")
      expect(Array.isArray(group.tools)).toBe(true)
    }

    const names = manifest.groups.flatMap((group) => group.tools.map((tool) => tool.name))

    // `count` is what the docs page renders as the headline number, so a
    // manifest whose count disagrees with its own contents ships a visible lie.
    expect(manifest.count).toBe(names.length)
    expect(new Set(names).size).toBe(names.length)
    expect(names.every((name) => name.startsWith("snow_"))).toBe(true)

    // A floor, not the exact count — the exact count is generate-tools-json's
    // business. This only catches a truncated or half-written manifest.
    expect(manifest.count).toBeGreaterThan(400)
  })

  test("sn-roles.manifest.json carries the shape the Portal destructures", () => {
    const manifest = readManifest("sn-roles.manifest.json") as {
      version: number
      testedAt: string
      stats: { tools: number }
      tools: Record<string, unknown>
    }

    expect(manifest.version).toBe(1)
    expect(typeof manifest.testedAt).toBe("string")
    expect(typeof manifest.tools).toBe("object")

    const names = Object.keys(manifest.tools)
    expect(names.length).toBeGreaterThan(400)
    expect(names.every((name) => name.startsWith("snow_"))).toBe(true)
    expect(manifest.stats.tools).toBe(names.length)
  })

  test("both manifests sit beside package.json, where their public URL expects them", () => {
    // The consumers fetch a literal path:
    //   raw.githubusercontent.com/serac-labs/serac/main/packages/servicenow-mcp/<file>
    // Moving either file deeper into the package would keep every test above
    // green while 404-ing production, so pin the location itself.
    //
    // Identity is asserted from package.json's `name`, NOT from the directory
    // basename: the release gate in publish-mcp.yml copies this package to
    // "$RUNNER_TEMP/standalone" and runs the suite there, and the Docker build
    // context renames it too. A basename assertion passes in the repo and
    // fails in exactly the two places that matter.
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as { name: string }
    expect(manifest.name).toBe("@serac-labs/servicenow-mcp")

    for (const file of ["tools.json", "sn-roles.manifest.json"]) {
      expect(fs.existsSync(path.join(PACKAGE_ROOT, file))).toBe(true)
    }
  })
})
