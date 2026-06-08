/**
 * Multi-tenant invariant test.
 *
 * Flags new module-level mutable state in `shared/*.ts`, which is a common
 * source of cross-tenant leaks in the HTTP transport (see the PR-6a audit).
 * Anything genuinely safe must be added to `ALLOWLIST` with a one-line note
 * explaining *why* the state is tenant-safe — don't silently allowlist.
 *
 * What counts as suspect:
 *   - `let` / `var` at module scope (mutable reference)
 *   - `new Map(...)` / `new Set(...)` / `new WeakMap(...)` / `new WeakSet(...)`
 *     at module scope (common cache pattern that typically needs tenant keys)
 *
 * Patterns inside class bodies, function bodies, or indented regions are
 * ignored — those are local state and always per-request in the handler flow.
 */

import { describe, test } from "@jest/globals"
import * as fs from "fs"
import * as path from "path"

const SHARED_DIR = path.resolve(__dirname, "..")

interface AllowedPattern {
  file: string
  pattern: RegExp
  reason: string
}

const ALLOWLIST: AllowedPattern[] = [
  {
    file: "tool-search.ts",
    pattern: /^let toolIndex:/,
    reason: "Tool definitions are static, tenant-agnostic metadata",
  },
  {
    file: "tool-search.ts",
    pattern: /^let sessionStore:/,
    reason: "Session-store reference, set once at bootstrap via setSessionStore; the store itself is tenant-scoped",
  },
  {
    file: "scripted-exec.ts",
    pattern: /^const endpointCache = new Map</,
    reason: "Keys are composed as tenantId\\x00instanceUrl — see getEndpointCacheKey()",
  },
  {
    file: "error-handler.ts",
    pattern: /^const ARTIFACT_SKIP_KEYS = new Set\(/,
    reason: "Static metadata — list of JSON keys to skip when scanning tool results",
  },
  {
    file: "instance-map-hook.ts",
    pattern: /^export const SKIP_ACTIONS = new Set\(/,
    reason: "Static metadata — list of read-only/skip actions for the instance-map post-hook",
  },
]

describe("Multi-tenant invariants in shared/", () => {
  test("no unexpected module-level mutable state", () => {
    const files = fs
      .readdirSync(SHARED_DIR)
      .filter((f) => f.endsWith(".ts") && !f.includes("__tests__") && fs.statSync(path.join(SHARED_DIR, f)).isFile())

    const violations: string[] = []

    for (const file of files) {
      const content = fs.readFileSync(path.join(SHARED_DIR, file), "utf-8")
      const lines = content.split("\n")

      // Track whether we're inside a template literal — those often contain
      // embedded ES5 scripts for ServiceNow server-side execution which
      // legitimately use `var`. Simple parity check on backticks per line.
      let insideTemplate = false

      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]
        const backtickCount = (raw.match(/`/g) ?? []).length
        const startedInsideTemplate = insideTemplate
        if (backtickCount % 2 === 1) insideTemplate = !insideTemplate
        // If we entered OR stayed inside a template literal on this line, skip it.
        if (startedInsideTemplate || insideTemplate) continue

        // Skip indented lines — those live inside a class, function, or block.
        if (raw.startsWith(" ") || raw.startsWith("\t")) continue

        // Strip trailing comments so matchers don't trip on end-of-line remarks.
        const stripped = raw.replace(/\s*\/\/.*$/, "").trimEnd()
        if (stripped.length === 0) continue
        if (stripped.startsWith("//") || stripped.startsWith("/*") || stripped.startsWith("*")) continue

        // Don't flag class/function/interface/type declarations themselves.
        if (/^(export\s+)?(async\s+)?(function|class|interface|type|namespace|enum)\s/.test(stripped)) continue

        const isMutableLet = /^(export\s+)?(let|var)\s+/.test(stripped)
        const isNewMapSet = /new\s+(Map|Set|WeakMap|WeakSet)\(/.test(stripped)

        if (!isMutableLet && !isNewMapSet) continue

        const allowed = ALLOWLIST.some((a) => file === a.file && a.pattern.test(stripped))
        if (allowed) continue

        violations.push(`${file}:${i + 1}: ${stripped}`)
      }
    }

    if (violations.length > 0) {
      const guidance =
        "Unexpected module-level mutable state detected in shared/*.ts.\n\n" +
        "Cross-tenant leaks in HTTP transport usually originate from patterns like this.\n" +
        "Options:\n" +
        "  1. Wrap the state in TenantScopedCache (keys include tenantId)\n" +
        "  2. Move the state into a per-request or per-tenant object passed through HandlerDeps\n" +
        "  3. If the state is genuinely tenant-agnostic (static metadata), add to\n" +
        "     `ALLOWLIST` in no-module-state.test.ts with a one-line reason.\n\n" +
        "Violations:\n" +
        violations.map((v) => `  ${v}`).join("\n")
      throw new Error(guidance)
    }
  })
})
