/**
 * `tools.json` and the tool registry have to describe the same catalog.
 *
 * They were built from the same directory tree by two different readers and
 * drifted anyway. The generator imports every `.ts` file under `tools/` and
 * reads its exported definition; the server imports a hand-maintained map of
 * domain `index.ts` modules (`STATIC_TOOL_MODULES`) and pairs `<name>_def`
 * with `<name>_exec`. A directory that nobody adds to that map is published
 * and unreachable — `tools/fsm/` and `tools/predictive-intelligence/` were
 * exactly that, eight tools advertised on docs.serac.build and in the portal
 * that no session could call, plus `snow_create_catalog_variable`, whose file
 * was never re-exported by `knowledge/index.ts` (#307).
 *
 * It broke in the other direction too: `snow_comprehensive_search` is
 * registered from `toolDefinitionAlias` and the generator only read
 * `toolDefinition`, so a callable tool was missing from the manifest that
 * documents the catalog.
 *
 * `generate:tools-json:check` cannot catch either one. It compares the
 * manifest against the tool *sources*, and both halves of the drift live
 * between a source file and an `index.ts`.
 *
 * Both directions fail here, because both are the same defect: a tool a
 * session can call is documented, and a tool that is documented can be called.
 */

import { describe, expect, test } from "bun:test"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { toolRegistry } from "../servicenow-mcp-unified/shared/tool-registry"

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

await toolRegistry.initialize()
const registered = new Set(toolRegistry.getToolDefinitions().map((tool) => tool.name))

const manifest: { count: number; groups: { tools: { name: string }[] }[] } = await Bun.file(
  join(PACKAGE_ROOT, "tools.json"),
).json()
const published = new Set(manifest.groups.flatMap((group) => group.tools.map((tool) => tool.name)))

describe("tools.json describes the catalog the server registers", () => {
  test("every published tool is registered", () => {
    // The failure this reproduces: 444 in the manifest, 436 in the registry.
    // A tool here is advertised on the docs site and in the portal, and a
    // session that asks for it gets "unknown tool".
    expect([...published].filter((name) => !registered.has(name)).sort()).toEqual([])
  })

  test("every registered tool is published", () => {
    // A tool here is callable and undocumented — invisible to the docs site,
    // the portal, and to anyone reading the manifest to see what exists.
    expect([...registered].filter((name) => !published.has(name)).sort()).toEqual([])
  })

  test("the manifest count matches the tools it lists", () => {
    // `count` is read directly by the docs site and the portal marketing copy
    // without recounting, so a wrong number ships as a public claim.
    expect(manifest.count).toBe(published.size)
  })

  test("every domain directory is in STATIC_TOOL_MODULES", async () => {
    // The parity checks above only notice a missing domain once one of its
    // tools reaches the manifest. This one fails the moment the directory
    // exists, and names the step that was skipped for `fsm` and
    // `predictive-intelligence`: adding a `tools/<domain>/` directory means
    // adding it to that map, or its tools load for nobody.
    //
    // `meta` is excluded because it is not a ServiceNow domain: `tool_search`
    // and `tool_execute` are registered by the transports directly, not
    // through the registry.
    const toolsDir = join(PACKAGE_ROOT, "src", "servicenow-mcp-unified", "tools")
    const onDisk = (await Array.fromAsync(new Bun.Glob("*/index.ts").scan({ cwd: toolsDir })))
      .map((entry) => dirname(entry))
      .filter((domain) => domain !== "meta")
      .sort()

    const mapped = toolRegistry.getAvailableDomains()
    expect(onDisk.filter((domain) => !mapped.includes(domain))).toEqual([])
  })
})
