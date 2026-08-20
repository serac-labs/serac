#!/usr/bin/env bun
/**
 * Generate tools.json — a self-describing manifest of every public ServiceNow
 * MCP tool defined in this package.
 *
 * Walks `src/servicenow-mcp-unified/tools/`, dynamic-imports each .ts tool
 * file, reads the exported `toolDefinition`, and writes `../tools.json`
 * grouped by subcategory.
 *
 * WHY THIS FILE EXISTS AGAIN
 * --------------------------
 * The manifest it produces is fetched at runtime from
 * raw.githubusercontent.com/serac-labs/serac/main by docs.serac.build, which
 * throws and blanks its entire Complete Tool Reference if the fetch 404s. The
 * generator that produced it was written on the feat/extract-servicenow-mcp
 * branch and never merged — commit 20b1a90ef1 committed the generated output
 * to main on its own and said so in its message ("only the generator +
 * workflow ... live on the in-flight branch"). The artifact has therefore been
 * frozen at generatedAt 2026-06-08 ever since, drifting from the tool tree it
 * claims to describe, with no way to regenerate it that did not start with
 * "find the right unmerged branch".
 *
 * That is the same failure the skills embed had (its header pointed at
 * /tmp/gen-skills.ts), and it is why this now lives next to the tools it
 * describes, inside the package that survives, with a `--check` drift gate.
 *
 * Run after adding, renaming or deleting a tool:
 *   bun run --cwd packages/servicenow-mcp generate:tools-json
 *
 * `--check` regenerates in memory and exits non-zero if the checked-in file is
 * stale, without writing.
 */

import { readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, basename, dirname, relative } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS_DIR = join(HERE, "..", "src", "servicenow-mcp-unified", "tools")
const OUT_PATH = join(HERE, "..", "tools.json")

const rel = (path: string) => relative(process.cwd(), path)

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Skip non-tool helper dirs. These hold dev/CI scripts (not tool
      // definitions) and some run top-level `process.exit(...)` at import,
      // which would otherwise abort this whole generator when swept in.
      if (entry.name === "__tests__" || entry.name === "__harness__" || entry.name === "contract") continue
      out.push(...(await walk(path)))
      continue
    }
    if (entry.isFile() && path.endsWith(".ts") && entry.name !== "index.ts") out.push(path)
  }
  return out
}

const titleCase = (s: string) =>
  s
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")

// Tolerate both snake_case (use_cases, allowed_roles) and the camelCase a few
// tools have drifted to. Returns undefined for missing/empty.
const pickStringArray = (def: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = def[key]
    if (Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === "string")) {
      return value as string[]
    }
  }
  return undefined
}

const pickString = (def: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = def[key]
    if (typeof value === "string" && value) return value
  }
  return undefined
}

const pickObject = (def: Record<string, unknown>, key: string) => {
  const value = def[key]
  return value && typeof value === "object" ? value : undefined
}

type ToolEntry = {
  name: string
  description: string
  subcategory: string
  permission?: string
  allowedRoles?: string[]
  useCases?: string[]
  complexity?: string
  frequency?: string
  inputSchema?: unknown
  outputSchema?: unknown
  deprecated?: true
}

const collect = async (files: string[]) => {
  const byName = new Map<string, ToolEntry>()
  const skipped: string[] = []
  const failed: string[] = []

  for (const file of files) {
    // Dynamic import is the only way to read a tool's real definition (some are
    // computed, not literal), and it is the only thing here that can throw.
    const mod = await (import(file) as Promise<ToolModule>).catch((err: Error) => {
      failed.push(`${basename(file)} — ${err.message.split("\n")[0]}`)
      return undefined
    })
    if (!mod) continue

    // `toolDefinitionAlias` is the second definition a file may export: a
    // renamed tool keeps its old name callable by spreading the new
    // definition under the old name, and the domain index registers both
    // (`operations/index.ts` exports both as `_def`). Reading only
    // `toolDefinition` published 444 of the 445 tools a session can call —
    // `snow_comprehensive_search` was reachable and undocumented (#307). It
    // carries its own `[DEPRECATED - use …]` marker, so publishing it points
    // callers at the replacement instead of leaving them to find the old name
    // by accident.
    const defs = [mod.toolDefinition, mod.toolDefinitionAlias].filter(
      (def): def is Record<string, unknown> => !!def && typeof def.name === "string" && def.name.startsWith("snow_"),
    )
    if (defs.length === 0) {
      skipped.push(file)
      continue
    }

    for (const def of defs) collectOne(def as ToolDefinitionShape, file, byName)
  }

  return { byName, skipped, failed }
}

type ToolModule = { toolDefinition?: Record<string, unknown>; toolDefinitionAlias?: Record<string, unknown> }
type ToolDefinitionShape = Record<string, unknown> & { name: string }

const collectOne = (def: ToolDefinitionShape, file: string, byName: Map<string, ToolEntry>) => {
  const description = String(def.description ?? "").trim()
  const subcategory = pickString(def, "subcategory") ?? basename(dirname(file)) ?? "misc"

  // De-dup: when the same tool name appears twice (rare, happens during
  // refactors), keep the longer description — almost always the more recent
  // / canonical one.
  const existing = byName.get(def.name)
  if (existing && existing.description.length >= description.length) return

  byName.set(def.name, {
    name: def.name,
    description,
    subcategory,
    permission: pickString(def, "permission"),
    allowedRoles: pickStringArray(def, "allowedRoles", "allowed_roles"),
    useCases: pickStringArray(def, "use_cases", "useCases"),
    complexity: pickString(def, "complexity"),
    frequency: pickString(def, "frequency"),
    // Pass JSON-Schema through verbatim so the docs renderer can drive
    // parameter tables (required flags, enums, defaults, descriptions)
    // directly from the canonical signature — no flattening here.
    inputSchema: pickObject(def, "inputSchema"),
    outputSchema: pickObject(def, "outputSchema"),
    deprecated: /\bdeprecated\b/i.test(description.slice(0, 60)) || undefined,
  })
}

const group = (tools: ToolEntry[]) => {
  const grouped = new Map<string, ToolEntry[]>()
  for (const tool of tools) {
    const bucket = grouped.get(tool.subcategory) ?? []
    bucket.push(tool)
    grouped.set(tool.subcategory, bucket)
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entries]) => ({
      name,
      displayName: titleCase(name),
      tools: entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((tool) => {
          // Drop absent fields so the manifest doesn't balloon with nulls.
          // Stable key order keeps diffs clean.
          const out: Record<string, unknown> = { name: tool.name, description: tool.description }
          if (tool.permission) out.permission = tool.permission
          if (tool.allowedRoles) out.allowedRoles = tool.allowedRoles
          if (tool.useCases) out.useCases = tool.useCases
          if (tool.complexity) out.complexity = tool.complexity
          if (tool.frequency) out.frequency = tool.frequency
          if (tool.inputSchema) out.inputSchema = tool.inputSchema
          if (tool.outputSchema) out.outputSchema = tool.outputSchema
          if (tool.deprecated) out.deprecated = true
          return out
        }),
    }))
}

const render = (groups: ReturnType<typeof group>, count: number, generatedAt: string) =>
  JSON.stringify({ generatedAt, count, groups }, null, 2) + "\n"

const namesIn = (json: { groups?: { tools?: { name?: string }[] }[] }) =>
  new Set((json.groups ?? []).flatMap((g) => (g.tools ?? []).map((t) => t.name ?? "")))

const main = async () => {
  const files = await walk(TOOLS_DIR)
  console.log(`Walking ${files.length} candidate files…`)

  const { byName, skipped, failed } = await collect(files)
  for (const message of failed) console.error(`  failed: ${message}`)

  const groups = group([...byName.values()])
  const count = byName.size

  console.log(
    `\n  ${count} tools across ${groups.length} subcategories\n` +
      `  ${skipped.length} skipped (no toolDefinition / non-snow_ name)\n` +
      `  ${failed.length} failed to import`,
  )

  // A failed import is a tool silently missing from the public docs. Fail
  // before writing so a half-manifest is never committed.
  if (failed.length > 0) {
    console.error(`\n${failed.length} tool file(s) failed to import — refusing to write a partial manifest`)
    process.exit(1)
  }

  if (process.argv.includes("--check")) {
    const current = existsSync(OUT_PATH) ? await Bun.file(OUT_PATH).json() : undefined
    if (!current) {
      console.error(`${rel(OUT_PATH)} is missing. Run: bun run --cwd packages/servicenow-mcp generate:tools-json`)
      process.exit(1)
    }

    // Regenerate with the checked-in timestamp so only real content differences
    // can show up in the comparison.
    const fresh = render(groups, count, String(current.generatedAt))
    const stale = fresh !== JSON.stringify(current, null, 2) + "\n"

    const onDisk = namesIn({ groups })
    const inFile = namesIn(current)
    const added = [...onDisk].filter((name) => !inFile.has(name)).sort()
    const removed = [...inFile].filter((name) => !onDisk.has(name)).sort()

    if (!stale) {
      console.log(`\nup to date: ${count} tools, ${groups.length} subcategories`)
      process.exit(0)
    }

    console.error(
      `\n${rel(OUT_PATH)} is stale — generatedAt ${current.generatedAt}, count ${current.count}; on disk ${count}`,
    )
    if (added.length > 0)
      console.error(`  ${added.length} tool(s) on disk but not in the manifest: ${added.join(", ")}`)
    if (removed.length > 0)
      console.error(`  ${removed.length} tool(s) in the manifest but not on disk: ${removed.join(", ")}`)
    if (added.length === 0 && removed.length === 0)
      console.error(`  same tool names; a description, schema or subcategory changed`)
    console.error(`Run: bun run --cwd packages/servicenow-mcp generate:tools-json`)
    process.exit(1)
  }

  const contents = render(groups, count, new Date().toISOString())
  await writeFile(OUT_PATH, contents)
  console.log(`\nWrote ${rel(OUT_PATH)}`)
  console.log(`docs.serac.build fetches this file from main — commit it, or the change is invisible.`)
}

await main()
