/**
 * Structural guarantee: only stdio can emit anonymous telemetry.
 *
 * The HTTP transport is the multi-tenant server the platform runs for its
 * customers. A ping from there would measure our own infrastructure, collapse
 * many tenants into a single "install", and transmit on behalf of users who
 * never installed anything — the platform already records that population in
 * `mcp_usage`. So "HTTP must not emit" is enforced by reachability, not by a
 * comment or a runtime flag: the HTTP entry points simply have no import path
 * to the telemetry module.
 *
 * These tests walk the real import graph on disk. Deleting the telemetry
 * import from the stdio entry, or adding one anywhere near HTTP, fails here.
 */

import { describe, test, expect } from "@jest/globals"
import * as fs from "fs"
import * as path from "path"

const SRC = path.resolve(__dirname, "..", "..", "..")
const TELEMETRY = path.join(SRC, "telemetry", "anonymous-telemetry.ts")
const STDIO_ENTRY = path.join(SRC, "servicenow-mcp-unified", "index.ts")
const HTTP_ENTRY = path.join(SRC, "servicenow-mcp-unified", "transports", "http-entry.ts")
const HTTP_APP = path.join(SRC, "servicenow-mcp-unified", "transports", "http.ts")
const PACKAGE_ROOT_EXPORT = path.join(SRC, "index.ts")

/** Every relative specifier in a file: static imports, re-exports, dynamic imports. */
const relativeSpecifiers = (source: string): string[] => {
  const out: string[] = []
  const patterns = [
    /(?:^|\s)(?:import|export)\s[^;]*?from\s*["'](\.[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
    /(?:^|\s)import\s+["'](\.[^"']+)["']/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1]!)
  }
  return out
}

/** Resolve a specifier the way the bundler/runtime does: `.js` maps back to `.ts`. */
const resolveSpecifier = (fromFile: string, specifier: string): string | undefined => {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base,
    `${base}.ts`,
    path.join(base, "index.ts"),
    path.join(base.replace(/\.js$/, ""), "index.ts"),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
}

/** Transitive closure of the local files an entry point pulls in. */
const importClosure = (entry: string): Set<string> => {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const source = fs.readFileSync(file, "utf-8")
    for (const specifier of relativeSpecifiers(source)) {
      const resolved = resolveSpecifier(file, specifier)
      if (resolved && !seen.has(resolved)) queue.push(resolved)
    }
  }
  return seen
}

/**
 * Every shipped file under src/ that imports the telemetry module. Tests are
 * excluded: `tsconfig.build.json` keeps them out of dist/ and `files: ["dist"]`
 * keeps dist/ the only thing published, so a test importing the module can
 * never put it on an HTTP code path.
 */
const telemetryImporters = (): string[] => {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (fs.statSync(full).isDirectory()) {
        if (entry !== "__tests__") walk(full)
        continue
      }
      if (!full.endsWith(".ts") || full.endsWith(".test.ts") || full === TELEMETRY) continue
      const source = fs.readFileSync(full, "utf-8")
      for (const specifier of relativeSpecifiers(source)) {
        if (resolveSpecifier(full, specifier) === TELEMETRY) {
          found.push(path.relative(SRC, full))
          break
        }
      }
    }
  }
  walk(SRC)
  return found.sort()
}

describe("telemetry is structurally stdio-only", () => {
  test("the module and both entry points exist where these tests look", () => {
    for (const file of [TELEMETRY, STDIO_ENTRY, HTTP_ENTRY, HTTP_APP]) {
      expect(fs.existsSync(file)).toBe(true)
    }
  })

  test("the stdio entry point reaches the telemetry module", () => {
    expect([...importClosure(STDIO_ENTRY)]).toContain(TELEMETRY)
  })

  test("no HTTP entry point can reach the telemetry module", () => {
    for (const entry of [HTTP_ENTRY, HTTP_APP]) {
      const closure = importClosure(entry)
      // The closure is real, not empty-by-accident.
      expect(closure.size).toBeGreaterThan(3)
      expect([...closure]).not.toContain(TELEMETRY)
    }
  })

  test("the package's public entry point does not drag telemetry in either", () => {
    expect([...importClosure(PACKAGE_ROOT_EXPORT)]).not.toContain(TELEMETRY)
  })

  test("the stdio entry point is the only importer in the whole package", () => {
    expect(telemetryImporters()).toEqual([path.relative(SRC, STDIO_ENTRY)])
  })

  test("the HTTP app exposes no tool-call hook to wire telemetry into", () => {
    // The counter reaches stdio by dependency injection (`startStdio({ onToolCall })`).
    // `createHttpApp` deliberately has no such parameter, so there is no
    // symmetrical mistake available on the HTTP side.
    expect(fs.readFileSync(HTTP_APP, "utf-8")).not.toContain("onToolCall")
    expect(fs.readFileSync(HTTP_ENTRY, "utf-8")).not.toContain("onToolCall")
  })

  test("the HTTP image opts out even though nothing in it can emit", () => {
    // Reachability is the guarantee; this is the belt to its braces. The image
    // ships src/ wholesale, so the stdio entry is inside it and only the CMD
    // keeps it unreached — `docker run <image> bun run .../index.ts`, or a
    // compose file overriding `command:`, would emit pings from platform
    // infrastructure on behalf of tenants who installed nothing.
    const dockerfile = fs.readFileSync(path.resolve(SRC, "..", "Dockerfile.mcp-http"), "utf-8")
    expect(dockerfile).toMatch(/^ENV SERAC_TELEMETRY_DISABLED=1$/m)
    expect(dockerfile).toContain("http-entry.ts")
  })

  test("the telemetry module is not re-exported from package.json", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(SRC, "..", "package.json"), "utf-8")) as {
      exports: Record<string, unknown>
      bin: Record<string, string>
    }
    const surface = JSON.stringify({ exports: manifest.exports, bin: manifest.bin })
    expect(surface).not.toContain("telemetry")
  })
})
