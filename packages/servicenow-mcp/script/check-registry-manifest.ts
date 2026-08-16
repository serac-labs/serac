#!/usr/bin/env bun
/**
 * Gate the repo-root `server.json` — the manifest the official MCP registry
 * stores — against this package's `package.json`.
 *
 * Four values are written down in both files, and every one of them is
 * hand-maintained:
 *
 *   - the VERSION. `publish-mcp.yml` takes the version it publishes from this
 *     package's manifest and from nothing else, deliberately: a second version
 *     string that can disagree is the coupling that once made this package
 *     inherit opencode's version number. `server.json` is exactly such a
 *     second string, so it is checked rather than trusted.
 *   - `mcpName`. The registry fetches
 *     registry.npmjs.org/<identifier>/<version> and refuses the publish unless
 *     the manifest it finds there carries an `mcpName` equal to the server
 *     name — that is how it proves the publisher owns the npm package. A
 *     mismatch is not a warning, it is a rejected release.
 *   - the npm package NAME, repeated as `packages[].identifier`.
 *   - the NAMESPACE. GitHub OIDC grants `io.github.<repository owner>/*` and
 *     nothing else, so a server name outside the owner in `repository.url`
 *     cannot be published from this repo's Actions at all. `mcp-publisher
 *     validate` does NOT catch this — a bare `serac-labs/servicenow-mcp`
 *     satisfies the schema pattern and fails only at publish time.
 *
 * Run:
 *   bun run --cwd packages/servicenow-mcp check:registry-manifest
 *
 * `.github/workflows/publish-mcp-registry.yml` runs it on every PR and again
 * before it uploads anything, so drift is caught here rather than published.
 */

import { join } from "node:path"

export const registryManifestProblems = async (repoRoot: string): Promise<string[]> => {
  const serverPath = join(repoRoot, "server.json")
  const packagePath = join(repoRoot, "packages", "servicenow-mcp", "package.json")

  const server: ServerManifest | undefined = await Bun.file(serverPath)
    .json()
    .catch(() => undefined)
  if (!server) return [`${serverPath} is missing or is not valid JSON`]

  const pkg: PackageManifest | undefined = await Bun.file(packagePath)
    .json()
    .catch(() => undefined)
  if (!pkg) return [`${packagePath} is missing or is not valid JSON`]

  // The owner segment of the repository URL is what the OIDC token's
  // `repository_owner` claim will say, which is what the registry turns into a
  // namespace grant.
  const owner = server.repository?.url?.split("github.com/")[1]?.split("/")[0]
  const npm = server.packages?.filter((entry) => entry.registryType === "npm") ?? []

  return [
    server.version === pkg.version
      ? undefined
      : `version: server.json says "${server.version}", package.json says "${pkg.version}". The package manifest is the only version source — bring server.json to it.`,
    pkg.mcpName === server.name
      ? undefined
      : `ownership: package.json mcpName "${pkg.mcpName}" is not server.json name "${server.name}". The registry reads mcpName off the published npm manifest and rejects the publish when they differ.`,
    owner && server.name?.startsWith(`io.github.${owner}/`)
      ? undefined
      : `namespace: server.json name "${server.name}" is not under "io.github.${owner}/", the owner in repository.url "${server.repository?.url}". GitHub OIDC grants that namespace and no other.`,
    npm.length > 0
      ? undefined
      : `packages: server.json declares no npm package, so the registry listing would have no install path.`,
    ...npm.flatMap((entry) => [
      entry.identifier === pkg.name
        ? undefined
        : `packages: identifier "${entry.identifier}" is not the published package name "${pkg.name}".`,
      entry.version === pkg.version
        ? undefined
        : `packages: "${entry.identifier}" is pinned to "${entry.version}", package.json says "${pkg.version}". The registry validates that exact version on npm.`,
    ]),
  ].filter((problem): problem is string => problem !== undefined)
}

type ServerManifest = {
  name?: string
  version?: string
  repository?: { url?: string }
  packages?: { registryType?: string; identifier?: string; version?: string }[]
}

type PackageManifest = { name?: string; version?: string; mcpName?: string }

if (import.meta.main) {
  // script/ -> packages/servicenow-mcp/ -> packages/ -> repo root.
  const problems = await registryManifestProblems(join(import.meta.dir, "..", "..", ".."))

  if (problems.length === 0) {
    console.log("server.json agrees with packages/servicenow-mcp/package.json")
    process.exit(0)
  }

  console.error(`server.json disagrees with packages/servicenow-mcp/package.json:`)
  console.error(problems.map((problem) => `  - ${problem}`).join("\n"))
  process.exit(1)
}
