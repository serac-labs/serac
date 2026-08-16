/**
 * Drives the real `registryManifestProblems` against real files on disk, one
 * fixture repo per failure mode.
 *
 * It deliberately does NOT assert against the checkout's own `server.json`:
 * `publish-mcp.yml` copies this package out of the workspace and runs `bun
 * test` there with no repo root above it, so a test reading `../../..` would
 * fail that release gate for a file that is legitimately absent. The real
 * files are checked by `bun run --cwd packages/servicenow-mcp
 * check:registry-manifest`, which `publish-mcp-registry.yml` runs on every PR.
 * What is proven here is that the checker actually reports the drift it is
 * there to catch — including that a deleted `server.json` is a failure and not
 * a clean run.
 */

import { describe, expect, test } from "@jest/globals"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registryManifestProblems } from "../check-registry-manifest.js"

// A repo where the two manifests agree. Every test below breaks exactly one
// thing about it, so the reported problem can only come from that break.
const SERVER = {
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "io.github.serac-labs/servicenow-mcp",
  description: "400+ ServiceNow tools",
  version: "0.2.1",
  repository: { url: "https://github.com/serac-labs/serac", source: "github" },
  packages: [
    {
      registryType: "npm",
      identifier: "@serac-labs/servicenow-mcp",
      version: "0.2.1",
      transport: { type: "stdio" },
    },
  ],
}

const PACKAGE = {
  name: "@serac-labs/servicenow-mcp",
  version: "0.2.1",
  mcpName: "io.github.serac-labs/servicenow-mcp",
}

const fixture = async (server: unknown, pkg: unknown) => {
  const root = await mkdtemp(join(tmpdir(), "registry-manifest-"))
  await mkdir(join(root, "packages", "servicenow-mcp"), { recursive: true })
  await Bun.write(join(root, "server.json"), JSON.stringify(server, null, 2))
  await Bun.write(join(root, "packages", "servicenow-mcp", "package.json"), JSON.stringify(pkg, null, 2))
  return root
}

describe("server.json / package.json drift", () => {
  test("agreeing manifests report nothing", async () => {
    expect(await registryManifestProblems(await fixture(SERVER, PACKAGE))).toEqual([])
  })

  test("a version bump server.json did not follow is reported, in both places it is written down", async () => {
    const problems = await registryManifestProblems(await fixture(SERVER, { ...PACKAGE, version: "0.3.0" }))

    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain(`server.json says "0.2.1", package.json says "0.3.0"`)
    expect(problems[1]).toContain(`pinned to "0.2.1", package.json says "0.3.0"`)
  })

  test("a package entry left on the old version is reported even when the server version was bumped", async () => {
    const stale = { ...SERVER, version: "0.3.0", packages: [{ ...SERVER.packages[0], version: "0.2.1" }] }
    const problems = await registryManifestProblems(await fixture(stale, { ...PACKAGE, version: "0.3.0" }))

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(`pinned to "0.2.1"`)
  })

  // The registry reads mcpName off the npm manifest to prove the publisher owns
  // the package, so this pair disagreeing is a rejected publish, not a warning.
  test("an mcpName that no longer matches the server name is reported", async () => {
    const problems = await registryManifestProblems(
      await fixture(SERVER, { ...PACKAGE, mcpName: "io.github.serac-labs/serac" }),
    )

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("mcpName")
  })

  // `mcp-publisher validate` accepts this — the schema only requires one slash
  // — so nothing before the publish attempt would catch it.
  test("a server name outside the repository owner's namespace is reported", async () => {
    const problems = await registryManifestProblems(
      await fixture(
        { ...SERVER, name: "build.serac/servicenow-mcp" },
        { ...PACKAGE, mcpName: "build.serac/servicenow-mcp" },
      ),
    )

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("io.github.serac-labs/")
  })

  test("a missing server.json fails rather than reporting a clean run", async () => {
    const problems = await registryManifestProblems(join(tmpdir(), "registry-manifest-does-not-exist"))

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("server.json is missing")
  })
})
