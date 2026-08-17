/**
 * The two things `createServer` puts on the initialize response — the MCP
 * `instructions` string and the `tools.listChanged` capability — checked where
 * they actually land, plus the notification that capability promises.
 *
 * `createServer` can look correct and still ship nothing: the SDK only puts
 * `instructions` on the initialize result when `ServerOptions.instructions` is
 * a non-empty string, and drops it silently otherwise. So this test does not
 * read the constant — it runs a real handshake over the SDK's in-memory
 * transport pair and asks a real `Client` what the server told it. If the
 * option is dropped, misspelled, or moved out of the options object, the
 * client's `getInstructions()` comes back undefined and every case here fails.
 *
 * The content assertions guard the three things that made this string worth
 * writing, each of which a well-meaning edit can quietly undo:
 *
 *   - It has to name tool_search and tool_execute. On the stdio server those
 *     are the entire visible surface; a model that is not told to widen the
 *     catalog concludes the instance is read-only and stops.
 *   - It has to stay tenant-neutral. transports/http.ts builds a fresh server
 *     per request from this same constant while serving many customers, so an
 *     instance URL added "just for stdio" would be handed to the next tenant
 *     that connects.
 *   - It must not vouch for tools it cannot vouch for. Part of this catalog
 *     never contacts an instance, so a blanket "every tool call is real" here
 *     is the server lending its own credibility to a fabricated result.
 */

import { describe, expect, test, afterEach } from "@jest/globals"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { MCPPromptManager } from "../shared/mcp-prompt-manager"
import { createServer } from "../servicenow-mcp-unified/shared/server-factory"
import { META_TOOLS } from "../servicenow-mcp-unified/tools/meta/index"
import { ToolSearch, buildToolIndex, setSessionStore } from "../servicenow-mcp-unified/shared/tool-search"
import { FileToolSessionStore } from "../servicenow-mcp-unified/shared/tool-session-store"
import { STDIO_TENANT } from "../servicenow-mcp-unified/shared/tenant-scope"

/**
 * Run one real initialize round-trip and hand back the live pair, so a test
 * can go on to make real tool calls over the same connection.
 */
const connected = async (resolveContext: Parameters<typeof createServer>[0]["resolveContext"]) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createServer({ resolveContext, promptManager: new MCPPromptManager("servicenow-unified") })
  const client = new Client({ name: "server-instructions-test", version: "0.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    server,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/**
 * Initialize with a resolver that refuses to run: the instructions string and
 * the capability set are static and tenant-neutral by design, so needing a
 * ServiceNow context to complete a handshake is itself the regression. This
 * throws rather than quietly passing a placeholder context in.
 */
const initialized = () =>
  connected(async () => {
    throw new Error("resolveContext must not be called during initialize")
  })

/** What the client was told at initialize. */
const handshake = async () => {
  const session = await initialized()
  const instructions = session.client.getInstructions()
  await session.close()
  return instructions
}

/**
 * The same round-trip, but refusing to hand back a missing string — otherwise
 * every content assertion below would pass vacuously against `""` the moment
 * the option stopped being set, and only the first case would report it.
 */
const instructionsText = async () => {
  const instructions = await handshake()
  if (typeof instructions !== "string" || instructions.length === 0)
    throw new Error("initialize response carried no instructions — see ServerOptions.instructions in server-factory.ts")
  return instructions
}

/**
 * Every `snow_*` name declared anywhere under tools/. Read from source rather
 * than from `toolRegistry.initialize()` so one unrelated tool file failing to
 * import cannot turn this into a false accusation about the instructions.
 */
const toolNamesOnDisk = () => {
  const dir = resolve(__dirname, "..", "servicenow-mcp-unified", "tools")
  return new Set(
    readdirSync(dir, { recursive: true })
      .map(String)
      .filter((entry) => entry.endsWith(".ts") && !entry.includes("__tests__"))
      .flatMap((entry) => [
        ...readFileSync(resolve(dir, entry), "utf-8").matchAll(/name:\s*["'](snow_[a-z0-9_]+)["']/g),
      ])
      .map((match) => match[1]),
  )
}

describe("MCP server instructions", () => {
  test("the initialize response carries them", async () => {
    const instructions = await handshake()
    expect(typeof instructions).toBe("string")
    expect((instructions ?? "").length).toBeGreaterThan(200)
  })

  test("they tell the model how to widen a deferred catalog", async () => {
    const instructions = await instructionsText()
    for (const meta of META_TOOLS) {
      expect(instructions).toContain(meta.definition.name)
    }
    // The status markers are what tool_search actually returns
    // (tools/meta/index.ts statusFor) — telling the model to read a marker we
    // do not emit would send it looking for something that is not there.
    expect(instructions).toContain("[DEFERRED]")
  })

  test("every tool it names is a tool this server has", async () => {
    const instructions = await instructionsText()
    const known = toolNamesOnDisk()
    for (const meta of META_TOOLS) known.add(meta.definition.name)
    // Existence only. `known` is every snow_* name declared under tools/, so
    // this catches a typo or a tool that was deleted — it does not catch a name
    // that exists but does not do what it says. Some executors in this catalog
    // never contact the instance; recommending one of those from the initialize
    // string would pass here and still be a lie. Read the executor before
    // adding a name.
    expect(known.size).toBeGreaterThan(100)
    expect([...new Set(instructions.match(/snow_[a-z0-9_]{3,}/g) ?? [])].filter((n) => !known.has(n))).toEqual([])
  })

  test("they carry no instance identity", async () => {
    const instructions = await instructionsText()
    // A per-request HTTP server hands this same string to every tenant.
    expect(instructions).not.toMatch(/https?:\/\//)
    expect(instructions).not.toMatch(/service-now\.com/i)
  })

  test("they do not vouch for the whole catalog", async () => {
    const instructions = await instructionsText()
    // 71 executors in this catalog never construct a client, and 18 POST to
    // sys_script_execution and return the Table API's echo as if it were script
    // output. An earlier revision opened with "Every tool call is a real REST
    // call against that instance ... and writes are real writes", which reads
    // as the server vouching for all of them and makes a fabricated success
    // envelope more credible rather than less. The wording below is not sacred;
    // what has to survive an edit is that the caveat is stated at all and that
    // the model is told how to check — so this asserts the two halves of that,
    // and will fail if a tidy-up deletes either.
    expect(instructions).toMatch(/without ever calling the instance/i)
    expect(instructions).toMatch(/read the record back/i)
  })
})

/**
 * The other half of the initialize response: the server says the tool list can
 * change, so it has to actually say when it changes.
 *
 * On stdio the whole catalog is registered `deferred: true`, so `tools/list`
 * returns two meta-tools until a `tool_search` enables more — a change a client
 * that cached the list can only learn about from
 * `notifications/tools/list_changed`. These run a real handshake and a real
 * `tools/call` and watch the wire, because a declared capability with no
 * emitter is a false claim and reads identically in the source.
 *
 * No ServiceNow instance is involved: `tool_search` only reads the in-process
 * index and the session store, both of which are set up here for real.
 */
describe("tools/list_changed", () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
    ToolSearch.clearIndex()
  })

  /**
   * A stdio session pointed at a throwaway session store, with `snow_query_table`
   * in the search index at the given deferral. The name is a real tool so the
   * index entry is the shape the transports build; nothing executes it.
   */
  const stdioSession = async (deferred: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-list-changed-"))
    dirs.push(dir)
    setSessionStore(new FileToolSessionStore(dir))
    ToolSearch.clearIndex()
    ToolSearch.registerTools(
      buildToolIndex(
        [{ name: "snow_query_table", description: "Query any ServiceNow table with an encoded query." }],
        () => "operations",
        deferred,
      ),
    )
    return connected(async () => ({
      sessionId: "ses_list_changed",
      origin: "stdio" as const,
      // tool_search never authenticates, and leaving these blank keeps it that
      // way: if this test ever starts needing real credentials, something on
      // the meta path has started reaching for the instance.
      serviceNow: { instanceUrl: "", clientId: "", clientSecret: "", tenantId: STDIO_TENANT },
    }))
  }

  /** Call tool_search over the wire and hand back the payload it reported. */
  const search = async (client: Client) => {
    const result = await client.callTool({ name: "tool_search", arguments: { query: "query table" } })
    return JSON.parse((result.content as { text: string }[])[0].text)
  }

  test("the capability is declared on the initialize response", async () => {
    const session = await initialized()
    expect(session.client.getServerCapabilities()?.tools?.listChanged).toBe(true)
    await session.close()
  })

  test("a tool_search that enables deferred tools notifies the client", async () => {
    const session = await stdioSession(true)
    // InMemoryTransport delivers synchronously and the notification is sent
    // before the tools/call response, so by the time the call resolves the
    // handler has either run or never will — no timers, no flake.
    const notifications: unknown[] = []
    session.client.setNotificationHandler(ToolListChangedNotificationSchema, async (n) => {
      notifications.push(n)
    })
    expect((await search(session.client)).enabled_tools).toEqual(["snow_query_table"])
    expect(notifications.length).toBe(1)
    await session.close()
  })

  test("a search that enabled nothing stays quiet", async () => {
    // Mirrors the shipped HTTP server, which registers the catalog with
    // `deferred: false`: nothing is gated, so nothing is written to the session
    // store and the tool list did not change. Notifying anyway would train
    // clients to re-list on every search.
    const session = await stdioSession(false)
    const notifications: unknown[] = []
    session.client.setNotificationHandler(ToolListChangedNotificationSchema, async (n) => {
      notifications.push(n)
    })
    expect((await search(session.client)).enabled_tools).toEqual([])
    expect(notifications.length).toBe(0)
    await session.close()
  })
})
