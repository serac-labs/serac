/**
 * Transport parity test.
 *
 * Catches regressions in the `transports: [...]` allowlist that tools carry
 * in their `MCPToolDefinition`. Two things we want to enforce:
 *
 *   1. Every tool that declares `transports: ["stdio"]` is in the documented
 *      `EXPECTED_STDIO_ONLY` list below. If the list drifts in either
 *      direction — a tool was added/removed from the codebase, or the
 *      allowlist was changed without updating this test — the test fails
 *      and forces a conscious decision.
 *
 *   2. No tool is silently `transports: ["http"]` only. HTTP-only would be
 *      unusual (we'd expect either both or stdio-only), so flag it.
 *
 * The check uses plain regex against the source files — no tool registry
 * initialization needed, so it runs in milliseconds.
 */

import { describe, test } from "@jest/globals"
import * as fs from "fs"
import * as path from "path"

const TOOLS_DIR = path.resolve(__dirname, "..", "..", "tools")

/**
 * Tools that are deliberately restricted to the stdio transport.
 * These read or write machine-local filesystem paths which would leak
 * cross-tenant in an HTTP multi-tenant server.
 *
 * Keep this list in sync with the `transports: ["stdio"]` annotations in the
 * individual tool files. Adding or removing an entry requires touching both.
 */
const EXPECTED_STDIO_ONLY = new Set<string>([
  "snow_sync_cleanup",
  "snow_memory_search",
  "snow_sync_data_consistency",
  // snow_artifact_manage and snow_pull_artifact were stdio-only until they
  // grew per-arg HTTP-safety guards (`httpForbiddenArgs`). They now run on
  // both transports — the unsafe filesystem args are rejected centrally
  // by call-tool.ts on HTTP, the rest of the surface stays available.
])

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (full.endsWith(".ts") && !full.includes("__tests__")) out.push(full)
  }
  return out
}

const parseTransports = (content: string): string[] | undefined => {
  // Matches `transports: ["stdio"]`, `transports: ["stdio", "http"]`, etc.
  // Only the first occurrence is considered — tool files have one definition.
  const match = content.match(/transports\s*:\s*\[([^\]]*)\]/)
  if (!match) return undefined
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0)
}

const parseToolName = (content: string): string | undefined => {
  const match = content.match(/name\s*:\s*["'](snow_[a-zA-Z0-9_]+)["']/)
  return match?.[1]
}

describe("Transport parity", () => {
  test("every stdio-only tool matches the documented list", () => {
    const files = walk(TOOLS_DIR)
    const foundStdioOnly = new Set<string>()
    const foundHttpOnly: string[] = []
    const unknownTransport: string[] = []

    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8")
      const transports = parseTransports(content)
      if (!transports) continue // tool available on every transport — OK

      const toolName = parseToolName(content)
      if (!toolName) continue // not a tool definition file

      // Validate declared transports only contain known values
      for (const t of transports) {
        if (t !== "stdio" && t !== "http") {
          unknownTransport.push(`${toolName} (${path.basename(file)}): "${t}"`)
        }
      }

      if (transports.length === 1 && transports[0] === "stdio") {
        foundStdioOnly.add(toolName)
      } else if (transports.length === 1 && transports[0] === "http") {
        foundHttpOnly.push(`${toolName} (${path.basename(file)})`)
      }
    }

    const errors: string[] = []

    if (unknownTransport.length > 0) {
      errors.push(
        "Unknown transport value in tool definition:\n" + unknownTransport.map((e) => `  ${e}`).join("\n"),
      )
    }

    if (foundHttpOnly.length > 0) {
      errors.push(
        "Tool marked http-only — unusual, confirm intent:\n" + foundHttpOnly.map((e) => `  ${e}`).join("\n"),
      )
    }

    const missing = [...EXPECTED_STDIO_ONLY].filter((n) => !foundStdioOnly.has(n)).sort()
    const unexpected = [...foundStdioOnly].filter((n) => !EXPECTED_STDIO_ONLY.has(n)).sort()

    if (missing.length > 0) {
      errors.push(
        "Tool expected to be stdio-only but no `transports: [\"stdio\"]` found:\n" +
          missing.map((n) => `  ${n}`).join("\n") +
          "\nEither add the annotation back, or remove the tool from EXPECTED_STDIO_ONLY.",
      )
    }

    if (unexpected.length > 0) {
      errors.push(
        "Tool marked stdio-only but not in EXPECTED_STDIO_ONLY:\n" +
          unexpected.map((n) => `  ${n}`).join("\n") +
          "\nIf this is intentional, add the tool to EXPECTED_STDIO_ONLY in transport-parity.test.ts.",
      )
    }

    if (errors.length > 0) {
      throw new Error("Transport parity violation:\n\n" + errors.join("\n\n"))
    }
  })
})
