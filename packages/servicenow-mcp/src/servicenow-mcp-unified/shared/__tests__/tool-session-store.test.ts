/**
 * Session-store tenancy.
 *
 * `FileToolSessionStore` is the process-wide DEFAULT (`tool-search.ts`
 * initialises `sessionStore` with it), and the HTTP transport only replaces it
 * as a side effect of `createHttpApp()`. An embedder that builds its own server
 * from the `./server` export never triggers that, so the default store has to
 * be the one that refuses multi-tenant use rather than the one that quietly
 * accepts it. Real files in a temp dir — no mocks.
 */

import { describe, test, expect, afterEach } from "@jest/globals"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { FileToolSessionStore, MemoryToolSessionStore } from "../tool-session-store"

const tempDirs: string[] = []

const storeInTempDir = (): FileToolSessionStore => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-session-store-"))
  tempDirs.push(dir)
  return new FileToolSessionStore(dir)
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe("FileToolSessionStore — stdio only", () => {
  test("round-trips enablement for the stdio sentinel", async () => {
    const store = storeInTempDir()
    await store.setEnabled("stdio", "ses_abc", new Set(["snow_query_table"]))
    expect(Array.from(await store.getEnabled("stdio", "ses_abc"))).toEqual(["snow_query_table"])
  })

  test("refuses a real tenant instead of writing tenant state to local disk", async () => {
    const store = storeInTempDir()
    await expect(store.setEnabled("1042", "user-42", new Set(["snow_query_table"]))).rejects.toThrow(/stdio-only/)
    await expect(store.getEnabled("1042", "user-42")).rejects.toThrow(/stdio-only/)
  })

  test("the refusal names the fix", async () => {
    const store = storeInTempDir()
    await expect(store.setEnabled("1042", "user-42", new Set())).rejects.toThrow(/MemoryToolSessionStore/)
  })

  test("two tenant ids the path sanitiser would merge can never both reach the disk", async () => {
    // sanitize() maps every non-[a-zA-Z0-9-_] character to "_", so "c:1042"
    // and "c_1042" share a directory — the directory that is supposed to BE
    // the tenant boundary. Refusing non-stdio tenants outright is what makes
    // that unreachable; without the guard this is a cross-tenant read.
    const store = storeInTempDir()
    await expect(store.setEnabled("c:1042", "s", new Set(["a"]))).rejects.toThrow()
    await expect(store.setEnabled("c_1042", "s", new Set(["b"]))).rejects.toThrow()
  })
})

describe("MemoryToolSessionStore — the multi-tenant one", () => {
  test("keeps two tenants sharing a session id apart, including sanitiser-colliding ids", async () => {
    const store = new MemoryToolSessionStore()
    await store.setEnabled("c:1042", "user-42", new Set(["snow_query_table"]))
    await store.setEnabled("c_1042", "user-42", new Set(["snow_create_incident"]))

    expect(Array.from(await store.getEnabled("c:1042", "user-42"))).toEqual(["snow_query_table"])
    expect(Array.from(await store.getEnabled("c_1042", "user-42"))).toEqual(["snow_create_incident"])
    expect((await store.getEnabled("c:2087", "user-42")).size).toBe(0)
  })
})
