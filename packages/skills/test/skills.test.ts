/**
 * The whole test suite for the skills half of the repo.
 *
 * Skills are markdown, so nothing about them fails at compile time — every
 * mistake here is silent until it reaches a user's system prompt. These are the
 * three failures that have actually happened or are one edit away:
 *
 *   1. The embedded map drifting from the tree on disk. That is not
 *      hypothetical: the shipped binary carried 55 of 58 skills for weeks and
 *      three Fluent skills never reached a user, because the generator lived in
 *      /tmp and nothing compared its output to reality.
 *   2. Frontmatter naming a tool the MCP does not have. The agent is told a
 *      tool exists, calls it, and gets an unknown-tool error at runtime.
 *   3. A skill directory whose frontmatter `name` does not match its directory
 *      name, which breaks any consumer that keys skills by directory.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { BUNDLED_SKILLS } from "../src/embedded"
import { skillsRoot } from "../src/root"

const ROOT = skillsRoot()

/** A skill is a top-level directory containing a SKILL.md. Same rule the generator uses. */
const skillNames = readdirSync(ROOT)
  .filter((entry) => !entry.startsWith("."))
  .filter((entry) => statSync(join(ROOT, entry)).isDirectory())
  .filter((entry) => existsSync(join(ROOT, entry, "SKILL.md")))
  .sort()

const walk = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, acc)
    else acc.push(relative(ROOT, full))
  }
  return acc
}

/** The `tools:` list out of a SKILL.md's YAML frontmatter. */
const frontmatter = (name: string) => {
  const raw = readFileSync(join(ROOT, name, "SKILL.md"), "utf8")
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!match) return undefined
  const lines = match[1]!.split(/\r?\n/)
  const tools: string[] = []
  let inTools = false
  for (const line of lines) {
    if (/^tools:\s*$/.test(line)) {
      inTools = true
      continue
    }
    if (!inTools) continue
    const item = /^\s*-\s*(\S+)\s*$/.exec(line)
    if (item) tools.push(item[1]!)
    else if (/^\S/.test(line)) inTools = false
  }
  return {
    name: /^name:\s*(\S+)\s*$/m.exec(match[1]!)?.[1],
    description: /^description:\s*(.+)$/m.exec(match[1]!)?.[1],
    tools,
  }
}

describe("skill tree", () => {
  test("there are skills at all", () => {
    // A consumer that resolves the wrong directory sees an empty tree rather
    // than an error, so assert a floor instead of trusting the glob.
    expect(skillNames.length).toBeGreaterThanOrEqual(50)
  })

  test.each(skillNames)("%s has frontmatter whose name matches its directory", (name) => {
    const fm = frontmatter(name)
    expect(fm).toBeDefined()
    expect(fm!.name).toBe(name)
    expect(fm!.description).toBeTruthy()
  })
})

describe("embedded map", () => {
  test("is in sync with the markdown on disk", () => {
    const onDisk = skillNames.flatMap((name) => walk(join(ROOT, name)))
    // Fails when a skill was added, renamed or deleted without rerunning
    // `bun packages/skills/script/generate-embedded.ts`.
    expect(Object.keys(BUNDLED_SKILLS).sort()).toEqual(onDisk.sort())
    for (const rel of onDisk) {
      expect(BUNDLED_SKILLS[rel]).toBe(readFileSync(join(ROOT, rel), "utf8"))
    }
  })
})

describe("frontmatter tools", () => {
  // Resolved by path rather than by import: the MCP's tool modules are not
  // meant to be loaded outside a server, and this package must still test
  // cleanly if it is ever published or checked out on its own.
  const toolsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "servicenow-mcp",
    "src",
    "servicenow-mcp-unified",
    "tools",
  )

  const mcpToolNames = (): Set<string> => {
    const found = new Set<string>()
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          scan(full)
          continue
        }
        if (!entry.endsWith(".ts")) continue
        for (const m of readFileSync(full, "utf8").matchAll(/name:\s*"([a-z][a-z0-9_]*)"/g)) found.add(m[1]!)
      }
    }
    scan(toolsDir)
    return found
  }

  test("every tool a skill declares exists in @serac-labs/servicenow-mcp", () => {
    if (!existsSync(toolsDir)) {
      // Sibling package absent (standalone checkout) — nothing to check against.
      return
    }
    const known = mcpToolNames()
    expect(known.size).toBeGreaterThan(300)
    const unknown = skillNames.flatMap((name) =>
      (frontmatter(name)?.tools ?? []).filter((tool) => !known.has(tool)).map((tool) => `${name}: ${tool}`),
    )
    expect(unknown).toEqual([])
  })
})
