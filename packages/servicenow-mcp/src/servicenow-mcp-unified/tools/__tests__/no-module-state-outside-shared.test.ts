/**
 * Multi-tenant invariant test for `tools/`, `handlers/` and `transports/`.
 *
 * Companion to `shared/__tests__/no-module-state.test.ts`, which scans only
 * the flat `shared/` directory. That gap is how the blast-radius discovery
 * cache — `tools/blast-radius/shared/deep-search.ts`, a process-global Map
 * shared by every tenant — went unnoticed. This walks the rest of the tree
 * recursively so the next one doesn't.
 *
 * Note the matcher below accepts `new Map<...>(` as well as `new Map(`. The
 * generic form is how every cache in this codebase is actually written, and a
 * matcher that misses it is a matcher that never fires.
 *
 * What counts as suspect:
 *   - `let` / `var` at module scope (mutable reference)
 *   - `new Map` / `Set` / `WeakMap` / `WeakSet` at module scope, with or
 *     without type arguments
 *
 * Indented lines (class bodies, function bodies) and the interiors of
 * template literals (ServiceNow ES5 snippets legitimately use `var`) are
 * ignored, matching the shared/ test.
 */

import { describe, test } from "@jest/globals"
import * as fs from "fs"
import * as path from "path"

const ROOT = path.resolve(__dirname, "..", "..")
const SCANNED_DIRS = ["tools", "handlers", "transports"]

interface AllowedPattern {
  /** Path relative to servicenow-mcp-unified/, POSIX separators. */
  file: string
  pattern: RegExp
  reason: string
}

const ALLOWLIST: AllowedPattern[] = [
  {
    file: "tools/blast-radius/shared/deep-search.ts",
    pattern: /^const discoveryCache = new Map</,
    reason:
      "Keys are composed tenant-first by the caller — see discoveryCacheKey() in " +
      "tools/blast-radius/snow_blast_radius_dependents.ts, pinned by its __tests__",
  },
  {
    file: "tools/blast-radius/shared/metadata-tables.ts",
    pattern: /^export const GLIDE_RECORD_BUILTINS = new Set\(/,
    reason: "Static metadata — GlideRecord built-in method names used to filter false-positive hits",
  },
  {
    file: "tools/operations/snow_record_manage.ts",
    pattern: /^export var (version|author) = /,
    reason: "Tool metadata strings, never reassigned — `var` is a leftover from the SDK migration",
  },
  {
    file: "tools/operations/snow_manage_group_membership.ts",
    pattern: /^export var (version|author) = /,
    reason: "Tool metadata strings, never reassigned — `var` is a leftover from the SDK migration",
  },
  {
    file: "tools/flow-designer/contract/drift-check.ts",
    pattern: /^const referenced = new Set<string>\(\)|^let checked = 0/,
    reason: "One-shot CLI script (top-level await, never imported by the server) — no request path",
  },
]

const listFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : listFiles(full)
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : []
  })

describe("Multi-tenant invariants outside shared/", () => {
  test("no unexpected module-level mutable state", () => {
    const violations: string[] = []

    for (const dir of SCANNED_DIRS) {
      for (const absolute of listFiles(path.join(ROOT, dir))) {
        const relative = path.relative(ROOT, absolute).split(path.sep).join("/")
        const lines = fs.readFileSync(absolute, "utf-8").split("\n")

        // Parity check on backticks: ServiceNow scripts embedded in template
        // literals legitimately use `var` at column 0.
        let insideTemplate = false

        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i]
          const backtickCount = (raw.match(/`/g) ?? []).length
          const startedInsideTemplate = insideTemplate
          if (backtickCount % 2 === 1) insideTemplate = !insideTemplate
          if (startedInsideTemplate || insideTemplate) continue

          // Skip indented lines — those live inside a class, function, or block.
          if (raw.startsWith(" ") || raw.startsWith("\t")) continue

          const stripped = raw.replace(/\s*\/\/.*$/, "").trimEnd()
          if (stripped.length === 0) continue
          if (stripped.startsWith("//") || stripped.startsWith("/*") || stripped.startsWith("*")) continue
          if (/^(export\s+)?(async\s+)?(function|class|interface|type|namespace|enum)\s/.test(stripped)) continue

          const isMutableLet = /^(export\s+)?(let|var)\s+/.test(stripped)
          const isNewMapSet = /new\s+(Map|Set|WeakMap|WeakSet)\s*[<(]/.test(stripped)
          if (!isMutableLet && !isNewMapSet) continue

          const allowed = ALLOWLIST.some((a) => relative === a.file && a.pattern.test(stripped))
          if (allowed) continue

          violations.push(`${relative}:${i + 1}: ${stripped}`)
        }
      }
    }

    if (violations.length > 0) {
      const guidance =
        "Unexpected module-level mutable state detected outside shared/.\n\n" +
        "In the HTTP transport one process serves every tenant, so process-global\n" +
        "state is shared between customers unless its key says otherwise.\n" +
        "Options:\n" +
        "  1. Wrap it in TenantScopedCache, or compose the key with\n" +
        "     resolveTenantScope() + tenantScopedKey() from shared/tenant-scope.ts\n" +
        "  2. Move the state into the per-request context\n" +
        "  3. If it is genuinely tenant-agnostic (static metadata, a CLI script),\n" +
        "     add it to `ALLOWLIST` in this file with a one-line reason.\n\n" +
        "Violations:\n" +
        violations.map((v) => `  ${v}`).join("\n")
      throw new Error(guidance)
    }
  })
})
