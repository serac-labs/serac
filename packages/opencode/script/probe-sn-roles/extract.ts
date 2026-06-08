/**
 * Static analysis: extract (table, operation) primitives from every MCP tool
 * file in `packages/servicenow-mcp/src/servicenow-mcp-unified/tools/`.
 *
 * Output shape per tool:
 *   { name, file, subcategory, calls: [{ method, table, endpoint }] }
 *
 * Tools that issue no `/api/now/table/<table>` calls are marked `untestable`
 * with a reason — they likely use non-table endpoints (catalog API, attachment,
 * scripted REST) or are pure client-side utilities.
 */

import { readdir, stat } from "fs/promises"
import { join, dirname, basename } from "path"
import { fileURLToPath } from "url"

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS_DIR = join(HERE, "..", "..", "..", "servicenow-mcp", "src", "servicenow-mcp-unified", "tools")

export interface Call {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  table: string | null
  endpoint: string
}

export interface Tool {
  name: string
  file: string
  subcategory: string
  permission?: string
  calls: Call[]
}

export interface Primitive {
  table: string
  operation: "read" | "create" | "write" | "delete"
  usedBy: string[]
}

export interface Extraction {
  tools: Record<string, Tool>
  primitives: Record<string, Primitive>
  untestable: { name: string; file: string; subcategory: string; reason: string }[]
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir)) {
    const p = join(dir, e)
    const s = await stat(p)
    if (s.isDirectory()) {
      if (e === "__tests__" || e === "shared") continue
      out.push(...(await walk(p)))
      continue
    }
    if (s.isFile() && p.endsWith(".ts") && e !== "index.ts") out.push(p)
  }
  return out
}

const METHOD_TO_OP: Record<Call["method"], Primitive["operation"]> = {
  GET: "read",
  POST: "create",
  PATCH: "write",
  PUT: "write",
  DELETE: "delete",
}

export async function extract(): Promise<Extraction> {
  const files = await walk(TOOLS_DIR)
  const tools: Record<string, Tool> = {}
  const primitives: Record<string, Primitive> = {}
  const untestable: Extraction["untestable"] = []

  for (const file of files) {
    const src = await Bun.file(file).text()

    const nameMatch = src.match(/name:\s*"(snow_[a-z_0-9]+)"/)
    if (!nameMatch) continue
    const name = nameMatch[1]

    const subMatch = src.match(/subcategory:\s*"([^"]+)"/)
    const subcategory = subMatch?.[1] ?? basename(dirname(file))

    const permMatch = src.match(/permission:\s*"([^"]+)"/)
    const permission = permMatch?.[1]

    const callRe = /client\.(get|post|patch|delete|put)\(\s*[`"']([^`"'${?]+)/gi
    const calls: Call[] = []
    for (const m of src.matchAll(callRe)) {
      const method = m[1].toUpperCase() as Call["method"]
      const endpoint = m[2].trim()
      const tableMatch = endpoint.match(/\/api\/now\/table\/([a-z_0-9]+)/)
      const table = tableMatch?.[1] ?? null
      calls.push({ method, table, endpoint })
    }

    const tool: Tool = {
      name,
      file: file.replace(TOOLS_DIR, "tools"),
      subcategory,
      permission,
      calls,
    }
    tools[name] = tool

    const tableCalls = calls.filter((c) => c.table)
    if (tableCalls.length === 0) {
      untestable.push({
        name,
        file: tool.file,
        subcategory,
        reason: "no /api/now/table/<table> calls in static analysis",
      })
      continue
    }

    for (const c of tableCalls) {
      const op = METHOD_TO_OP[c.method]
      const key = `${c.table}:${op}`
      const existing = primitives[key]
      if (existing) {
        if (!existing.usedBy.includes(name)) existing.usedBy.push(name)
        continue
      }
      primitives[key] = { table: c.table!, operation: op, usedBy: [name] }
    }
  }

  return { tools, primitives, untestable }
}

if (import.meta.main) {
  const result = await extract()
  console.log(`tools:        ${Object.keys(result.tools).length}`)
  console.log(`primitives:   ${Object.keys(result.primitives).length}`)
  console.log(`untestable:   ${result.untestable.length}`)
  console.log(`unique tables: ${new Set(Object.values(result.primitives).map((p) => p.table)).size}`)
}
