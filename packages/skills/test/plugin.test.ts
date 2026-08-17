/**
 * The Claude Code plugin manifests, which nothing else in this repo exercises.
 *
 * `/plugin marketplace add serac-labs/serac` installs this directory as a plugin: the marketplace entry
 * at the repo root points `source` here, `.claude-plugin/plugin.json` declares the skills path, and
 * `.mcp.json` is the MCP server that comes with them. Every way that breaks is silent — a `source` that
 * no longer resolves installs a plugin with no skills, and a description that outlives the tree is what
 * the `/plugin` picker shows before anyone installs.
 *
 * The skills path is the plugin root, so the plugin ships whatever the tree holds; there is no copy step
 * to forget and nothing to regenerate. That is deliberate — this package already carries a drift test
 * because a copy step went stale once and three skills never reached a user.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BUNDLED_SKILLS } from "../src/embedded"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const marketplace = await Bun.file(join(REPO, ".claude-plugin", "marketplace.json")).json()
const entry = marketplace.plugins.find((candidate: { name: string }) => candidate.name === "servicenow")
const pluginRoot = resolve(REPO, entry.source)
const plugin = await Bun.file(join(pluginRoot, ".claude-plugin", "plugin.json")).json()
const rootMcp = await Bun.file(join(REPO, ".mcp.json")).json()
const mcpPackage = await Bun.file(join(REPO, "packages", "servicenow-mcp", "package.json")).json()
const toolCount = (await Bun.file(join(REPO, "packages", "servicenow-mcp", "tools.json")).json()).count

/** Generated from the tree by `script/generate-embedded.ts`, and kept honest by skills.test.ts. */
const embedded = [...new Set(Object.keys(BUNDLED_SKILLS).map((key) => key.split("/")[0]))].sort()

describe("marketplace entry", () => {
  test("points at a directory that is a plugin", () => {
    expect(marketplace.name).toBe("serac")
    expect(marketplace.owner.name).toBeTruthy()
    expect(statSync(pluginRoot).isDirectory()).toBe(true)
    expect(existsSync(join(pluginRoot, ".claude-plugin", "plugin.json"))).toBe(true)
  })

  test("the counts it advertises are the ones the tree has", () => {
    // These two strings are the whole product description in the `/plugin` picker, and nothing else reads
    // them. tools.json has sat two months stale before now (test.yml's --check step exists for that), so a
    // hardcoded number in a file no test touches is a number that goes wrong.
    //
    // The tool figure may be an exact count or a "400+" floor, and both are checked against the tree. The
    // floor is what this repo writes, because tools.json counts what is PUBLISHED and the registry loads
    // fewer (serac-labs/serac#307) — an exact number here would be precise and wrong.
    expect(embedded.length).toBeGreaterThanOrEqual(50)
    ;[entry.description, plugin.description].forEach((description: string) => {
      const advertised = description.match(/(\d+)(\+?) snow_\*/)
      expect(advertised?.[1]).toBeTruthy()
      const claimed = Number(advertised?.[1] ?? 0)
      expect(advertised?.[2] === "+" ? toolCount >= claimed : toolCount === claimed).toBe(true)
      expect(description).toContain(`${embedded.length} skill guides`)
    })
  })
})

describe("plugin manifest", () => {
  test("ships every skill the package embeds", () => {
    // The manifest alone decides which directories reach a user. Comparing against the embedded map — a
    // checked-in artifact generated from the tree, not another read of the same directory — is what
    // catches a skills path resolving somewhere else: point it at a directory that is not the skills root
    // and the plugin installs with 0 of 57 skills and no error anywhere.
    const shipped = plugin.skills
      .flatMap((path: string) => {
        const dir = resolve(pluginRoot, path)
        return readdirSync(dir).filter((name) => existsSync(join(dir, name, "SKILL.md")))
      })
      .sort()
    expect(shipped).toEqual(embedded)
  })

  test("writes the skills path the way older Claude Code parses it", () => {
    // `"."` and `"./"` both mean the plugin root, but `"."` fails manifest validation before Claude Code
    // 2.1.221 — the plugin then does not load at all — and the published manifest schema requires `./`.
    expect(plugin.skills.every((path: string) => path.startsWith("./"))).toBe(true)
  })
})

describe("MCP server", () => {
  test("is the same definition the repo root hands to other clients", async () => {
    // Two files because they answer to two different loaders: Claude Code reads the plugin's copy after
    // install, and the repo-root one from a checkout. Nothing merges them.
    expect(await Bun.file(join(pluginRoot, ".mcp.json")).json()).toEqual(rootMcp)
  })

  test("names a bin this package declares", async () => {
    // `npx @serac-labs/servicenow-mcp servicenow-mcp-stdio` does not work — the package publishes two bins
    // and neither is named after it, so npm answers "could not determine executable to run". The bin has to
    // be the command and the package has to be named separately.
    //
    // This reads the working tree, so it catches a rename here going out of sync with these configs. It
    // says nothing about what is on npm: the plugin runs the published `latest`, and only publish-mcp.yml
    // sees that tarball — its smoke gate drives every bin over JSON-RPC before a release goes out.
    expect(rootMcp.mcpServers.servicenow.command).toBe("npx")
    expect(rootMcp.mcpServers.servicenow.args).toContain(`--package=${mcpPackage.name}`)
    expect(Object.keys(mcpPackage.bin)).toContain(rootMcp.mcpServers.servicenow.args.at(-1))
  })
})
