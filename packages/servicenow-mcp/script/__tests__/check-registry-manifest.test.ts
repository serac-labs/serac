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
  repository: { type: "git", url: "git+https://github.com/serac-labs/serac.git" },
  bin: {
    "servicenow-mcp": "./src/servicenow-mcp-unified/index.ts",
    "servicenow-mcp-stdio": "./src/servicenow-mcp-unified/index.ts",
    "servicenow-mcp-enterprise-proxy": "./src/enterprise-proxy/index.ts",
  },
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

  // The failure this repo actually shipped into: the package had only
  // servicenow-mcp-stdio and servicenow-mcp-enterprise-proxy, so `npx -y
  // @serac-labs/servicenow-mcp@0.2.1` — the command a registry entry with no
  // runtimeArguments means — died with "could not determine executable to run"
  // while every other check here stayed green.
  test("bins npx cannot choose between are reported", async () => {
    const problems = await registryManifestProblems(
      await fixture(SERVER, {
        ...PACKAGE,
        bin: {
          "servicenow-mcp-stdio": "./src/servicenow-mcp-unified/index.ts",
          "servicenow-mcp-enterprise-proxy": "./src/enterprise-proxy/index.ts",
        },
      }),
    )

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(`npx -y @serac-labs/servicenow-mcp@0.2.1`)
  })

  // npm's other resolution path: several names for one file is unambiguous, so
  // the checker must not demand a bin named after the package in that case.
  test("bins that all point at one file resolve without a name match", async () => {
    const aliases = { stdio: "./src/index.ts", "servicenow-mcp-stdio": "./src/index.ts" }

    expect(await registryManifestProblems(await fixture(SERVER, { ...PACKAGE, bin: aliases }))).toEqual([])
  })

  // A client told to run something other than the bare package is not subject
  // to npm's guess, so the bin shape stops being this checker's business.
  test("an entry with runtimeArguments is not held to npx bin resolution", async () => {
    const explicit = {
      ...SERVER,
      packages: [
        {
          ...SERVER.packages[0],
          runtimeHint: "npx",
          runtimeArguments: [{ type: "positional", valueHint: "bin", value: "servicenow-mcp-stdio" }],
        },
      ],
    }

    expect(
      await registryManifestProblems(await fixture(explicit, { ...PACKAGE, bin: { a: "./a.ts", b: "./b.ts" } })),
    ).toEqual([])
  })

  test("a missing server.json fails rather than reporting a clean run", async () => {
    const problems = await registryManifestProblems(join(tmpdir(), "registry-manifest-does-not-exist"))

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("server.json is missing")
  })
})
