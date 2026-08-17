/**
 * Build an MCP Server with all request handlers wired up.
 *
 * Transport-agnostic: the caller supplies a `resolveContext` strategy and a
 * prompt manager, then hooks up whatever transport (stdio, streamable HTTP)
 * onto the returned Server instance.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { registerHandlers } from "../handlers/register.js"
import { type HandlerDeps } from "../handlers/types.js"

/**
 * The `instructions` string on the initialize response (MCP lifecycle spec,
 * 2025-06-18). Clients hand this to the model before it sees a single tool, so
 * it is the only place to say the thing a cold session cannot work out for
 * itself: `tools/list` shows two meta-tools, and without being told, a model
 * reads that as "this server can barely do anything" and stops.
 *
 * Three constraints on anything added here.
 *
 * It must be true in every mode. Deferral is not a fixed property of the
 * server: `handlers/list-tools.ts` gates on SNOW_LAZY_TOOLS (default on) AND on
 * the `deferred` flag each transport registers in the tool index, and
 * `transports/http-entry.ts` registers the whole catalog with `deferred: false`
 * — so the shipped HTTP server lists everything while stdio lists two. The text
 * therefore describes what the model can observe in its own `tools/list` rather
 * than asserting one mode.
 *
 * It must be tenant-neutral. Both transports build their server from this same
 * constant, and the HTTP transport builds a fresh one per request while serving
 * many customers — so an instance URL, a username or an environment label put
 * in here would be handed to whichever tenant asked next. It cannot name the
 * credentials either: `transports/http-resolver.ts` resolves tenant and
 * credentials per request from a downstream endpoint, so consecutive requests
 * on one server can be different customers. Naming the instance needs a
 * per-session string, not this one; see the test in
 * src/__tests__/server-instructions.test.ts, which fails on an embedded URL.
 *
 * It must not make claims on the catalog's behalf. A model reads `instructions`
 * as the server's own ground truth, so a universal like "every tool call is a
 * real REST call" is not a harmless simplification — it lends credibility to
 * the executors that fabricate. Dozens of them never construct a client at all,
 * and a cluster of them POST a record to sys_script_execution and return the
 * Table API's echo as if it were script output. So the claim here is scoped to
 * the server (what a write that lands means), and verification is handed back
 * to the model rather than promised on the tools' behalf.
 *
 * Failure modes are named, not re-explained: the guard messages in
 * shared/update-set-guard.ts already spell out the exact retry at the moment of
 * failure, and repeating them here would be one more thing to keep in sync.
 */
const INSTRUCTIONS = `Bridge to a live ServiceNow instance, not a sandbox: a write that reaches the instance is a real change to real data, made with the credentials this session resolves to. Not every tool reaches it — some compute locally by design, and a few report success without ever calling the instance — so a tool's own success envelope is a claim, not proof. When a write matters, read the record back.

FINDING TOOLS. The catalog is large and usually deferred. If tools/list shows only tool_search and tool_execute, the rest is hidden until you ask for it: call tool_search({ query: "..." }) with words for the job ("incident", "widget deploy", "update set", "cmdb"), then read the marker on each hit — [AVAILABLE] and [ENABLED] are callable now, [DEFERRED] is not — and run tool_execute({ tool, args }). Anything listed in tools/list can also be called directly. If tools/list already shows hundreds of snow_* tools then nothing is deferred here and tool_search is only a lookup. Never conclude from a short tools/list that a capability is missing; search first.

WHEN CALLS FAIL it is usually one of three things.
- No usable credentials: tools that touch the instance return an authentication error rather than an empty result, and rephrasing the call will not help.
- The instance answers with an HTML page or a 502/503 instead of JSON, which surfaces as a parse or auth failure. A hibernating developer instance does this — open it in a browser to wake it, then retry.
- A guard blocked a write: configuration writes need an active update set for the session, and writes to an instance labelled production need the user's explicit approval. The error names the exact call to make next. Follow it rather than working around it with a background script.

snow_session_context returns the authenticated user, their roles, the current update set and the domain in one call — ground role and ACL reasoning on it instead of guessing. snow_diagnose_setup (stdio server only) reports which credential source was used and whether the instance is answering.`

export interface ServerDeps extends HandlerDeps {
  name?: string
  version?: string
}

export const createServer = (deps: ServerDeps): Server => {
  const server = new Server(
    {
      name: deps.name ?? "servicenow-unified",
      version: deps.version ?? "1.0.0",
    },
    {
      capabilities: {
        // The tool list is not fixed for the life of a stdio session: a
        // tool_search that enables deferred tools changes what the next
        // tools/list returns, and a client that caches the list has no way to
        // find out. handlers/call-tool.ts emits the matching notification, so
        // this declaration is backed by an emitter rather than aspirational —
        // the SDK does not check (assertNotificationCapability only asks
        // whether `tools` is truthy), the client does.
        tools: { listChanged: true },
        prompts: {},
      },
      instructions: INSTRUCTIONS,
    },
  )

  registerHandlers(server, deps)
  return server
}
