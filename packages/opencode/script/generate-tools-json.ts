#!/usr/bin/env bun
/**
 * Generate tools.json — a single, self-describing manifest of every
 * public ServiceNow MCP tool defined in this package.
 *
 * Walks `packages/servicenow-mcp/src/servicenow-mcp-unified/tools/`, dynamic-imports
 * each .ts tool file, reads the exported `toolDefinition`, and writes
 * `packages/opencode/tools.json` grouped by subcategory.
 *
 * Consumed by:
 *   - docs.serac.build (renders the Complete Tool Reference table
 *     client-side from this JSON, so docs auto-update with no
 *     hand-editing whenever this file regenerates)
 */

import { readdir, writeFile } from "fs/promises"
import { join, basename, dirname } from "path"
import { fileURLToPath } from "url"

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS_DIR = join(HERE, "..", "..", "servicenow-mcp", "src", "servicenow-mcp-unified", "tools")
const OUT_PATH = join(HERE, "..", "tools.json")

interface ToolEntry {
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
  deprecated?: boolean
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Skip non-tool helper dirs. These hold dev/CI scripts (not tool
      // definitions) and some run top-level `process.exit(...)` at import,
      // which would otherwise abort this whole generator when swept in.
      if (entry.name === "__tests__" || entry.name === "__harness__" || entry.name === "contract") continue
      out.push(...(await walk(path)))
    } else if (entry.isFile() && path.endsWith(".ts") && entry.name !== "index.ts") {
      out.push(path)
    }
  }
  return out
}

const titleCase = (s: string) =>
  s
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")

// Tolerate both snake_case (use_cases, allowed_roles) and the camelCase a
// few tools have drifted to. Returns undefined for missing/empty.
function pickStringArray(def: any, ...keys: string[]): string[] | undefined {
  for (const k of keys) {
    const v = def?.[k]
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) {
      return v as string[]
    }
  }
  return undefined
}

function pickString(def: any, ...keys: string[]): string | undefined {
  for (const k of keys) {
    if (typeof def?.[k] === "string" && def[k]) return def[k] as string
  }
  return undefined
}

async function main() {
  const files = await walk(TOOLS_DIR)
  console.log(`Walking ${files.length} candidate files…`)

  const byName = new Map<string, ToolEntry & { file: string }>()
  let skipped = 0
  let failed = 0

  for (const file of files) {
    try {
      const mod = (await import(file)) as { toolDefinition?: any }
      const def = mod.toolDefinition
      if (!def || typeof def.name !== "string" || !def.name.startsWith("snow_")) {
        skipped++
        continue
      }
      const desc = String(def.description ?? "").trim()
      const subcategory =
        (typeof def.subcategory === "string" && def.subcategory) ||
        basename(dirname(file)) ||
        "misc"
      const isDeprecated = /\bdeprecated\b/i.test(desc.slice(0, 60))

      // De-dup: when the same tool name appears twice (rare, happens during
      // refactors), keep the longer description — almost always the more
      // recent / canonical one.
      const existing = byName.get(def.name)
      if (existing && existing.description.length >= desc.length) continue

      byName.set(def.name, {
        file,
        name: def.name,
        description: desc,
        subcategory,
        permission: pickString(def, "permission"),
        allowedRoles: pickStringArray(def, "allowedRoles", "allowed_roles"),
        useCases: pickStringArray(def, "use_cases", "useCases"),
        complexity: pickString(def, "complexity"),
        frequency: pickString(def, "frequency"),
        // Pass JSON-Schema through verbatim so the docs renderer can drive
        // parameter tables (required flags, enums, defaults, descriptions)
        // directly from the canonical signature — no flattening here.
        inputSchema: def.inputSchema && typeof def.inputSchema === "object" ? def.inputSchema : undefined,
        outputSchema: def.outputSchema && typeof def.outputSchema === "object" ? def.outputSchema : undefined,
        deprecated: isDeprecated || undefined,
      })
    } catch (err) {
      failed++
      console.error(`  failed: ${basename(file)} — ${(err as Error).message.split("\n")[0]}`)
    }
  }

  const grouped = new Map<string, ToolEntry[]>()
  for (const t of byName.values()) {
    const group = t.subcategory
    if (!grouped.has(group)) grouped.set(group, [])
    grouped.get(group)!.push({
      name: t.name,
      description: t.description,
      subcategory: t.subcategory,
      permission: t.permission,
      allowedRoles: t.allowedRoles,
      useCases: t.useCases,
      complexity: t.complexity,
      frequency: t.frequency,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      deprecated: t.deprecated,
    })
  }

  const groups = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, tools]) => ({
      name,
      displayName: titleCase(name),
      tools: tools
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => {
          // Drop absent fields so the manifest doesn't balloon with nulls.
          // Stable key order keeps diffs clean.
          const out: Record<string, unknown> = {
            name: t.name,
            description: t.description,
          }
          if (t.permission) out.permission = t.permission
          if (t.allowedRoles) out.allowedRoles = t.allowedRoles
          if (t.useCases) out.useCases = t.useCases
          if (t.complexity) out.complexity = t.complexity
          if (t.frequency) out.frequency = t.frequency
          if (t.inputSchema) out.inputSchema = t.inputSchema
          if (t.outputSchema) out.outputSchema = t.outputSchema
          if (t.deprecated) out.deprecated = true
          return out
        }),
    }))

  const output = {
    generatedAt: new Date().toISOString(),
    count: byName.size,
    groups,
  }

  await writeFile(OUT_PATH, JSON.stringify(output, null, 2) + "\n")

  console.log(
    `\nWrote ${OUT_PATH}\n  ${byName.size} tools across ${groups.length} subcategories\n  ${skipped} skipped (no toolDefinition / non-snow_ name)\n  ${failed} failed to import`,
  )

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
