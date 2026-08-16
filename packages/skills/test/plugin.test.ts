/**
 * The Claude Code plugin manifests, which nothing else in this repo exercises.
 *
 * `/plugin marketplace add serac-labs/serac` installs this directory as a plugin: the marketplace entry
 * at the repo root points `source` here, `.claude-plugin/plugin.json` declares the skills path, and
 * `.mcp.json` is the MCP server that comes with them. Every way that breaks is silent — a `source` that
 * no longer resolves installs a plugin with no skills, a renamed npm bin leaves the server dead in every
 * installed copy, and both look fine in a diff.
 *
 * The skills path is `"."`, so the plugin ships whatever the tree holds; there is no copy step to forget
 * and nothing to regenerate. That is deliberate — this package already carries a drift test because a
 * copy step went stale once and three skills never reached a user.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { skillsRoot } from "../src/root"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const marketplace = await Bun.file(join(REPO, ".claude-plugin", "marketplace.json")).json()
const entry = marketplace.plugins.find((candidate: { name: string }) => candidate.name === "servicenow")
const pluginRoot = resolve(REPO, entry.source)
const plugin = await Bun.file(join(pluginRoot, ".claude-plugin", "plugin.json")).json()
const rootMcp = await Bun.file(join(REPO, ".mcp.json")).json()

/** Claude Code's rule for a skills path, and the same one the portal uses: a directory holding a SKILL.md. */
const skillDirs = (dir: string) =>
  readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => existsSync(join(path, "SKILL.md")))
    .map((path) => basename(path))
    .sort()

describe("marketplace entry", () => {
  test("points at a directory that is a plugin", () => {
    expect(marketplace.name).toBe("serac")
    expect(marketplace.owner.name).toBeTruthy()
    expect(statSync(pluginRoot).isDirectory()).toBe(true)
    expect(existsSync(join(pluginRoot, ".claude-plugin", "plugin.json"))).toBe(true)
  })
})

describe("plugin manifest", () => {
  test("ships every skill in the tree", () => {
    // Not a tautology: the default scan is `<plugin>/skills/`, which does not exist here. Drop the
    // `skills` field, or point it at a directory that is not the skills root, and the plugin installs
    // with 0 of 57 skills and no error anywhere.
    const declared = typeof plugin.skills === "string" ? [plugin.skills] : plugin.skills
    const shipped = declared.flatMap((path: string) => skillDirs(resolve(pluginRoot, path))).sort()
    expect(shipped).toEqual(skillDirs(skillsRoot()))
    expect(shipped.length).toBeGreaterThanOrEqual(50)
  })
})

describe("MCP server", () => {
  test("is the same definition the repo root hands to other clients", async () => {
    // Two files because they answer to two different loaders: Claude Code reads the plugin's copy after
    // install, everything else reads the repo-root one from a checkout. Nothing merges them.
    expect(await Bun.file(join(pluginRoot, ".mcp.json")).json()).toEqual(rootMcp)
  })

  test("runs a bin the published package actually exposes", async () => {
    // `npx @serac-labs/servicenow-mcp servicenow-mcp-stdio` does not work — the package publishes two
    // bins and neither is named after it, so npm answers "could not determine executable to run". The
    // bin has to be the command and the package has to be named separately.
    const published = await Bun.file(join(REPO, "packages", "servicenow-mcp", "package.json")).json()
    expect(rootMcp.mcpServers.servicenow.command).toBe("npx")
    expect(rootMcp.mcpServers.servicenow.args).toContain(`--package=${published.name}`)
    expect(Object.keys(published.bin)).toContain(rootMcp.mcpServers.servicenow.args.at(-1))
  })
})
