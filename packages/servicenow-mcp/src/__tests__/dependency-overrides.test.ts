/**
 * The root `overrides` block, and why a stale one is invisible.
 *
 * `bun audit` reported 23 advisories — two of them high — against a tree whose
 * direct dependencies were all patched. Both came from a nested resolution the
 * lockfile had pinned and never revisited:
 *
 *   "form-data":       ["form-data@4.0.6", ...]   <- what package.json asks for
 *   "axios/form-data": ["form-data@4.0.5", ...]   <- what axios actually got
 *
 * axios declares `form-data: ^4.0.5`, which 4.0.6 satisfies, so nothing was
 * wrong with the ranges — the lockfile simply kept the resolution it already
 * had. `bun update form-data` does not touch it and neither does
 * `bun install --force`. The same thing had `@modelcontextprotocol/sdk` on
 * hono 4.12.12 while the workspace ran 4.12.34.
 *
 * That is what `overrides` is for, and it introduces the failure this file
 * exists for: the override names a version in a SECOND place. Renovate bumps
 * `packages/servicenow-mcp/package.json` and knows nothing about the root
 * block, so the override silently becomes a DOWNGRADE — pinning the whole
 * tree back to the version it was written for, including the direct
 * dependency that used to be fine.
 *
 * Both halves are checked: the versions have to agree, and the lockfile has to
 * show one resolution per overridden package.
 */

import { describe, expect, test } from "bun:test"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")

const root: { overrides?: Record<string, string> } = await Bun.file(`${REPO}/package.json`).json()
const pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = await Bun.file(
  `${REPO}/packages/servicenow-mcp/package.json`,
).json()
const lockfile = await Bun.file(`${REPO}/bun.lock`).text()

const overrides = Object.entries(root.overrides ?? {})
const declared = { ...pkg.devDependencies, ...pkg.dependencies }

describe("root overrides", () => {
  test("there are some, and they are exact versions", () => {
    // A range here would re-resolve on every lockfile refresh, which is the
    // drift the override was added to stop.
    expect(overrides.length).toBeGreaterThan(0)
    expect(overrides.filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version))).toEqual([])
  })

  test("each one matches what the package declares", () => {
    // The downgrade case: package.json moves to 4.0.7, the override still says
    // 4.0.6, and every copy in the tree — including the direct one — goes back
    // to 4.0.6 without a word.
    const mismatched = overrides
      .filter(([name]) => declared[name] !== undefined)
      .filter(([name, version]) => declared[name] !== version)
      .map(([name, version]) => `${name}: override ${version}, package.json ${declared[name]}`)

    expect(mismatched).toEqual([])
  })

  test("the lockfile resolves each overridden package exactly once", () => {
    // A nested entry is keyed "<parent>/<name>". One of these is the whole bug:
    // an advisory that `bun audit` reports and every direct-dependency check
    // says is already fixed.
    const nested = overrides.flatMap(([name]) =>
      [...lockfile.matchAll(new RegExp(`^\\s*"([^"]+/${name})":`, "gm"))].map((match) => match[1]!),
    )

    expect(nested).toEqual([])
  })
})
