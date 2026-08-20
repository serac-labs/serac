---
name: mcp-tool-discovery
description: Find and call tools on this ServiceNow MCP server — the two meta-tools it starts with, why a missing session id makes every other tool unreachable, which queries actually match, and which advertised tools are not on the server at all.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: platform
tools:
  - tool_search
  - tool_execute
  - snow_diagnose_setup
---

# MCP Tool Discovery

This server registers over 440 `snow_*` tools across 80 domains and lists none of them. A fresh tool list
holds two meta-tools; everything else is behind `tool_search`. This guide is about getting from "there is
probably a tool for this" to a call that actually runs.

No exact total is quoted here, because there are two of them and they disagree:
`packages/servicenow-mcp/tools.json` is what the docs site publishes, the registry is what the running
server can dispatch, and nine published tools are missing from the registry (see "Nine tools you can find
in the docs but not on the server").

## Cold start: two tools

A fresh `tools/list` on the stdio transport returns exactly this, no matter how many tools exist:

```
tool_search
tool_execute
```

That is deliberate. The server's own note puts the full catalog at roughly 71k tokens of schema against
about 2k for the two meta-tools. The index is built with every tool marked deferred, and
`handlers/list-tools.ts` returns only meta-tools plus whatever the current session has enabled.

The HTTP transport (the portal) does the opposite — it registers the catalog as non-deferred, so its
`tools/list` returns everything and nothing needs enabling. You can tell which one you are on from the
status in a `tool_search` result: `[AVAILABLE]` means the server is not gating on the enabled set at all.

## The loop

```javascript
// 1. Search. Found tools are enabled for this session by default.
tool_search({ query: "update-sets" })

// 2. Read the status on each hit:
//    [AVAILABLE] — callable now, nothing had to be enabled
//    [ENABLED]   — deferred, and enabled for this session. Callable now.
//    [DEFERRED]  — NOT callable. Nothing was enabled; see the next section.

// 3. Execute.
tool_execute({ tool: "snow_ensure_active_update_set", args: { name: "Feature: SLA fix" } })
```

Pass `enable: false` when you only want to look — it searches without touching session state.

## No session id, no tools

This is the failure that wastes an afternoon. Enablement is stored per `(tenant, session)`. With no session
id there is nothing to attach it to, so `tool_search` enables nothing, every hit stays `[DEFERRED]`, and
every call is refused:

```
⚠ 5 deferred tool(s) were NOT enabled: this request carries no session id, so there is nothing to
attach the enablement to. They stay [DEFERRED] and tool_execute will refuse them.
```

```json
{
  "success": false,
  "error": "Tool \"snow_query_table\" is [DEFERRED] and must be enabled first",
  "hint": "Use tool_search({query: \"query table\"}) to enable this tool",
  "status": "[DEFERRED]"
}
```

Searching again does not help. The session id is resolved, in order, from the JWT payload's `sessionId`,
an `x-session-id` header, the `SNOW_SESSION_ID` environment variable, and finally a `current-session.json`
file written by the Serac CLI. Over plain stdio the first two do not exist and the file only exists if the
Serac TUI has run on this machine, so a client that launches the server itself — including the Claude Code
plugin's `npx … servicenow-mcp-stdio` — has no session id unless you give it one:

```json
{
  "mcpServers": {
    "servicenow": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "--package=@serac-labs/servicenow-mcp", "servicenow-mcp-stdio"],
      "env": { "SNOW_SESSION_ID": "my-session" }
    }
  }
}
```

That is the entry the plugin ships in `packages/skills/.mcp.json` with one addition — `env`. Keep
`command` and `args` when you edit it; an entry carrying only `env` cannot launch anything. Any stable
string works as the id. Two consequences worth knowing:

- The enabled set is **persisted to disk** per session and restored on restart, under
  `~/Library/Application Support/snow-code/enabled-tools/stdio/<session>.json` on macOS,
  `~/.local/share/snow-code/enabled-tools/` on Linux, `%APPDATA%\snow-code\` on Windows. The directory is
  still named `snow-code` from before the rename. Reuse the same `SNOW_SESSION_ID` and yesterday's tools
  are already enabled; delete the file to start clean.
- On the HTTP transport the store is in memory and per tenant, and a request that cannot be placed in a
  tenant is refused rather than pooled. You will see `no tenant scope` in the hint instead.

## Calling by name, and why `tool_execute` is safer

Once a tool is enabled, the server dispatches it by name — `handlers/call-tool.ts` accepts
`snow_query_table` directly, and the agent instructions tell you to do exactly that.

What the server does not do is tell your client the list grew. It declares `capabilities: { tools: {} }`
with no `listChanged`, and never sends `notifications/tools/list_changed`
(https://modelcontextprotocol.io/specification/2025-06-18/server/tools). Per the spec that notification is
what prompts a client to re-issue `tools/list`. So whether a newly enabled tool appears as a callable tool
in your context depends entirely on whether your client re-lists on its own.

`tool_execute` was in the cold-start list, so it always works. Use it for the first call after a search;
by-name is a convenience, not a guarantee.

### Read the envelope, not just the outer flag

`tool_execute` reports whether it *dispatched*, not whether the operation worked. The tool's own verdict is
nested:

```json
{
  "success": true,
  "tool": "snow_query_table",
  "result": { "success": false, "error": "undefined is not an object (evaluating 'context.instanceUrl.replace')" }
}
```

An outer `success: true` with an inner `success: false` is a failed operation. Check `result.success`.

That particular inner error is not a bug in the tool — it is what every tool says when no instance is
configured at all. `SNOW_INSTANCE` is unset; go set it rather than reading the executor.

### Guard flags go inside `args`

Writes against a production-classified instance and configuration writes with no active update set are
blocked at the tool layer, through `tool_execute` exactly as through a by-name call. The retry flags
`__confirmProd` and `__skipUpdateSet` belong **inside** the `args` object, not beside it — they are read
from the inner arguments and stripped before the executor sees them:

```javascript
tool_execute({
  tool: "snow_create_business_rule",
  args: { table: "incident", name: "Auto-assign", __confirmProd: true },
})
```

## Querying: what matches and what silently does not

The index holds, per tool, the name with `snow_` stripped and split on `_` (keeping parts longer than two
characters), plus the **first ten significant words of the description**. A distinguishing noun that
appears late in a long description is not reachable by keyword. Scoring adds points for exact-id,
substring, keyword and per-word matches, plus 25 for a domain-name match.

**Domain names are the best query.** They pull a whole coherent group and nothing else:

```javascript
tool_search({ query: "update-sets" })  // all three: snow_update_set_query, snow_ensure_active_update_set, snow_update_set_manage
tool_search({ query: "blast-radius" }) // the whole impact-analysis family
tool_search({ query: "local-sync" })   // the pull/push/status/cleanup family
tool_search({ query: "atf" })          // test, test step, test suite, discover, execute, results
```

The domain names are the directory names under
`packages/servicenow-mcp/src/servicenow-mcp-unified/tools/`, minus a few that are not domains: `__tests__`
is tests, `meta` is where `tool_search` and `tool_execute` themselves live and is deliberately outside the
registry, and `adapters` is an empty placeholder. Everything else is searchable.

`limit` defaults to 10, and seven domains hold more than that: `security`, `integration`, `automation`,
`operations`, `agile`, `cmdb`, `ui-builder`. Exact per-domain counts are not worth memorising — they move
every time a tool lands — so treat a sweep that returns exactly 10 as truncated and raise `limit`.

**Table names mostly do not work.** This is the trap the old version of this guide walked readers into:

| Query                   | What comes back                                                        |
| ----------------------- | ---------------------------------------------------------------------- |
| `"sys_script_include"`  | Nothing. `No tools found matching "sys_script_include"`                |
| `"sys_user"`            | `snow_create_acl_role`, `snow_switch_application_scope`, `snow_test_connection` — noise |
| `"sysevent_email_action"` | `snow_create_notification`, `snow_email_notification_manage` — works, by luck |
| `"sp_widget"`           | `snow_create_sp_widget` — works, because a tool is named after it       |

Search the operation instead: `"script include"` finds `snow_create_script_include`, `"notification"`
finds the email tools, `"widget"` finds the Service Portal family.

When nothing matches, the response carries a `suggestion` listing "available domains". That list is the
**first fifteen domain names alphabetically**, `access-control` through `calculators`. It is not the domain list
and it is not a ranked suggestion — do not conclude from it that `operations` or `update-sets` do not
exist.

### What the index actually returns

Top hits from the shipped index, re-run against this checkout. Scoring is a stable sort, so tools on equal
scores come back in registration order and the exact ranking shifts every time a tool lands. Read the
membership, not the position:

| Query              | Top hits                                                                     |
| ------------------ | ---------------------------------------------------------------------------- |
| `"query table"`    | `snow_query_table`, `snow_validate_query`, `snow_graphql_query`, `snow_record_manage` |
| `"incident"`       | `snow_analyze_incident`, `snow_auto_resolve_incident`, `snow_create_security_incident` |
| `"cmdb"`           | `snow_cmdb_identify_reconcile`, `snow_search_cmdb`, `snow_cmdb_search`       |
| `"business rule"`  | `snow_create_business_rule`, `snow_disable_business_rule`                    |
| `"attachment"`     | `snow_get_attachments`, `snow_delete_attachment`, `snow_upload_attachment`   |
| `"acl"`            | `snow_acl_explain`, `snow_create_acl_role`, `snow_create_acl` — and `snow_test_acl`, which fabricates its answer; see below |
| `"flow"`           | `snow_start_workflow`, `snow_workflow_manage`, `snow_manage_flow`            |
| `"jira"`           | `snow_create_oauth_profile`, `snow_install_spoke` — see the last section     |

Note `"incident"` does not return the tool you want for incident CRUD. That is `snow_record_manage`
(`{ action, table: "incident", … }`), which the query `"record"` or `"query table"` finds. Note also
`snow_search_cmdb` and `snow_cmdb_search` — two different tools in two different domains that do nearly the
same thing. Duplicated names are common here; read both descriptions before picking.

## Ranking is relevance, not quality

`tool_search` ranks by string match. It has no idea whether a tool works, and this catalog lies in two
different ways. You need both, because the defence against one does not catch the other.

**Mode one: it never contacts the instance.** The executor assembles a success object out of the arguments
you passed and returns it. Two of these come back at the top for obvious queries:

- `tool_search({ query: "artifact" })` ranks **`snow_clone_instance_artifact`** first. It never opens a
  connection. It returns `success` with `"message": "Cross-instance cloning requires additional
  authentication setup"` and a list of steps naming `snow_export_artifact` and `snow_import_artifact` —
  neither of which exists on this server. Use an update set for instance-to-instance promotion, or
  `snow_pull_artifact` / `snow_push_artifact` for local round-trips.
- `tool_search({ query: "incident" })` ranks **`snow_create_security_incident`** third. It is an
  unimplemented stub: it validates and echoes your arguments back with
  `"summary": "Security incident \"…\" prepared with priority: …"`. Nothing reaches the instance — note the
  word "prepared". All six `snow_create_*` tools in the `security` domain are stubs of the same kind. The
  SIR tools that do work are the `snow_sir_*` family (`snow_sir_incident_manage` and friends, which read
  and write `sn_si_incident`), and `snow_record_manage` against the table directly always works.

The clearest example of why the description is not evidence: `snow_create_access_control` in `security`
advertises "Writes to `sys_security_acl`" and never opens a connection. `snow_create_acl` in
`access-control` is the one that actually `POST`s to `/api/now/table/sys_security_acl`.

**Mode two: it contacts the instance and asks the wrong question.** A larger cluster of tools `POST`s a
record to `/api/now/table/sys_script_execution` and reads the Table API's echo of the row it just inserted
as though it were the output of a script. The Table API inserts records; it does not run them. So nothing
executes, and every check mode one taught you passes anyway: there is a real HTTP call, a real `201`, a
real sys_id, and `result.success` is `true`.

`snow_test_acl`, a top hit for `"acl"` above, is the one to know. It returns
`has_access: response.data.result` — `result` being the inserted row, a truthy object on every call — so
it reports access unconditionally and never evaluates an ACL. It ignores the `operation` and `user` you
gave it. For ACL work, use `snow_acl_explain` to see which rules match and which roles the user holds, and
`snow_create_acl` to write one; for the actual verdict, impersonate in the UI, because the platform
decides an ACL against one specific record and nothing over the Table API evaluates that.

Not everything in that cluster fabricates — some tools throw when the echo carries no output, which is a
loud, honest failure. The distinguishing question is always whether the response describes the thing you
asked about or the request you filed.

Two habits that cost nothing:

- Prefer a tool whose description names a table or an API endpoint — then confirm it, because a
  description alone proves nothing. Vagueness ("handles authentication, dependency resolution and data
  migration") is a reliable smell; a named table is a starting point, not a guarantee.
- After any write you care about, read it back with `snow_query_table` or `snow_record_manage` — and read
  back **the artifact you meant to change, on the table you meant to change it on**. A sys_id in the
  response is not evidence by itself: the `sys_script_execution` tools hand you a perfectly re-queryable
  sys_id belonging to a row you never asked for. If you created a business rule, the proof is a row in
  `sys_script`, not a successful lookup of whatever id came back.

The dependable core, for reference: `snow_query_table` and `snow_record_manage` for records,
`snow_artifact_manage` and `snow_pull_artifact` / `snow_push_artifact` for artifacts,
`snow_update_set_manage` / `snow_ensure_active_update_set` for change tracking, `snow_session_context` for
who you are authenticated as, `snow_diagnose_setup` when calls fail for reasons that look like nothing.

## The result is a summary, not a schema

Each hit is trimmed: description cut at 200 characters, at most **five parameters** shown, each parameter
description cut at 80. `has_more_params: true` means there are more, and the search response will not show
them. `snow_artifact_manage` has 56 parameters; you see five.

To see the whole schema, enable the tool and let your client re-list (`tools/list` carries the full
`inputSchema`), or call it and read the validation error. Do not infer that a parameter does not exist
because `tool_search` did not print it.

## The docs list and the server's list are checked against each other

`tools.json` — the manifest the docs site and the portal render — is generated by walking the tool files.
The running server builds its registry from a hard-coded domain map in `shared/tool-registry.ts`. Those
are two different readers of the same tree, and they drifted: nine tools were published and unreachable
(`tools/fsm/`, `tools/predictive-intelligence/` and `snow_create_catalog_variable`, none of them in the
map or re-exported), and `snow_comprehensive_search` was the reverse — callable but absent from the
manifest. That was serac-labs/serac#307, now fixed, and
`packages/servicenow-mcp/src/__tests__/registry-manifest-parity.test.ts` fails in either direction if it
happens again.

So a name in `tools.json` is a name you can call. If a tool answers

```json
{
  "success": false,
  "error": "Tool not found: snow_something",
  "suggestion": "Use tool_search to find available tools"
}
```

the name is wrong, not missing — check it against `tools.json` rather than re-searching for it.

One thing the manifest does carry that you should not call: entries marked `"deprecated": true`, whose
description opens with `[DEPRECATED - use <replacement>]`. `snow_comprehensive_search` is one — it is a
backwards-compatible alias for `snow_search_artifacts`. Use the replacement the description names.

## Two environment variables that do not do what they say

- **`SNOW_LAZY_TOOLS=false`** is documented as loading the whole catalog at startup. On stdio it does not:
  the transport builds its index with every tool marked deferred regardless of the variable, so
  `tools/list` still returns `tool_search` and `tool_execute` and nothing else. The startup log claims
  otherwise. Discover through `tool_search` either way.
- **`SNOW_TOOL_DOMAINS=cmdb,operations`** filters `tools/list` only. `tool_execute` never consults it, so a
  tool from an excluded domain still runs if it has been enabled. Treat it as a display filter, not a
  restriction.

## Enterprise integrations are a different server

`jira_*`, `azdo_*`, `confluence_*`, `github_*` and `gitlab_*` are real, and they are not here. Every tool
in this server's registry begins with `snow_` — `tool_search` and `tool_execute` are the exception, and
they are not registry tools at all but the two meta-tools bolted on beside it. The integrations live
behind a separate binary,
`servicenow-mcp-enterprise-proxy`, which fetches its catalog from the Serac license server and exposes its
own pair of meta-tools — `enterprise_tool_search` and `enterprise_tool_execute`, prefixed precisely so they
cannot collide with the two on this server.

So `tool_search({ query: "jira" })` is the wrong call, not a call for tools that do not exist: on this
server it returns `snow_create_oauth_profile` and `snow_install_spoke`. If `enterprise_tool_search` is not
in your tool list, that server is not configured for this session — the plugin's `.mcp.json` starts only
`servicenow-mcp-stdio` — and no query will reach those tools.

## Discovery is silent

Never narrate it. Do not say "let me first activate the tool" or "I'm searching for the right tool" — search,
enable, call, and report the outcome. If a call fails, search again with different terms, silently.

## When discovery is not the problem

If tools resolve and enable but every call fails — 401s, HTML where JSON should be, "not valid JSON" —
stop searching and call `snow_diagnose_setup`. It reports which credential source was used, whether the
instance is awake, and whether the OAuth exchange succeeds. A hibernating developer instance answers with
an HTML login page, and every tool then looks like it has a parse bug.

| Symptom                                                | Cause                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| Every hit is `[DEFERRED]`, nothing enables              | No session id — set `SNOW_SESSION_ID`                        |
| `Tool "x" is [DEFERRED] and must be enabled first`      | Not enabled in this session; `tool_search` it first          |
| `Tool not found: x` after a successful docs lookup      | Published but never registered — see serac-labs/serac#307    |
| `No tools found matching "sys_..."`                     | Table-name query; search the operation instead               |
| Enabled tool never appears in your client's tool list   | No `listChanged` notification — use `tool_execute`           |
| `success: true` but nothing changed on the instance     | Read `result.success`; if that is true too, re-query the artifact on its own table — the tool may be a stub or a `sys_script_execution` echo |
| Tool refuses over HTTP but works locally                | Transport allowlist — that tool touches the local filesystem |
