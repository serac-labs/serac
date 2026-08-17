/**
 * Every ServiceNow environment variable the documentation tells someone to set has to be one the code
 * actually reads.
 *
 * The quick start told people to export `SNOW_INSTANCE_URL` while the loader read only
 * `SERVICENOW_INSTANCE_URL` and `SNOW_INSTANCE` (#316). Nothing failed: the server started
 * unauthenticated and then reported missing *credentials*, which points a reader at the wrong thing
 * entirely. Docs and loader get edited in different PRs by different people, so the only thing that keeps
 * them in step is a check.
 *
 * The set of readable names is derived from the source, not listed here — adding a variable should not
 * mean editing this file too.
 */

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ENV_VARS } from "../servicenow-mcp-unified/shared/context-loader"

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const REPO = resolve(PACKAGE_ROOT, "..", "..")

// Tests are excluded on purpose, and it matters: context-loader.test.ts assigns
// `process.env.SNOW_INSTANCE_URL` to exercise the loader, and counting that as "the code reads it" made
// this check pass against a faithful reconstruction of the very bug it exists for.
const sources = (
  await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: join(PACKAGE_ROOT, "src"), absolute: true }))
).filter((file) => !file.includes("__tests__"))

// ENV_VARS is resolved through `process.env[name]` at runtime, so its entries are string literals no
// `process.env.X` scan can see. Both halves are needed.
const readByCode = new Set([
  ...Object.values(ENV_VARS).flat(),
  ...(await Promise.all(sources.map((file) => Bun.file(file).text()))).flatMap((text) =>
    [...text.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\["([A-Z0-9_]+)"\])/g)].map((match) => match[1] ?? match[2]),
  ),
])

// The package README ships inside the package and is always here. The repo-root docs are not: the publish
// gate copies this package out of the workspace and runs the suite with no repo around it, where they
// genuinely do not exist. The last test below stops that from hiding a deletion inside a real checkout.
const rootDocs = ["README.md", "CONTRIBUTING.md", "SECURITY.md"].map((name) => join(REPO, name))
const docs = [join(PACKAGE_ROOT, "README.md"), ...rootDocs.filter((path) => existsSync(path))]

describe("documented environment variables", () => {
  docs.forEach((path) => {
    test(`${relative(REPO, path)} names only variables the code reads`, async () => {
      const documented = [
        ...new Set(
          [...(await Bun.file(path).text()).matchAll(/\b((?:SNOW|SERVICENOW)_[A-Z0-9_]+)\b/g)].map((match) => match[1]),
        ),
      ]
      expect(
        documented
          .filter((name) => !readByCode.has(name))
          .map((name) => `${name}: documented here, read nowhere in src — fix the doc or the loader`),
      ).toEqual([])
    })
  })

  test("the repo-root docs are checked wherever the repo is", () => {
    expect(existsSync(join(REPO, "package.json")) ? rootDocs.every((path) => existsSync(path)) : true).toBe(true)
  })
})
