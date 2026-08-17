# @serac-labs/servicenow-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for ServiceNow: 400+ `snow_*` tools over
stdio or streamable HTTP, plus blast-radius impact analysis. Part of [Serac](https://serac.build).

```bash
npm install -g @serac-labs/servicenow-mcp
```

## Use it as an MCP server

Point any MCP client at the `servicenow-mcp-stdio` binary:

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "servicenow-mcp-stdio",
      "env": {
        "SNOW_INSTANCE_URL": "https://dev12345.service-now.com",
        "SNOW_CLIENT_ID": "…",
        "SNOW_CLIENT_SECRET": "…"
      }
    }
  }
}
```

The catalog is large enough to blow a context window, so tools are **deferred** by default: `tools/list`
returns two meta-tools, and the model widens its own surface as it goes.

```
tool_search({query: "incident"})     → the matching tools, marked [ENABLED]
tool_execute({tool: "snow_query_incidents", args: {query: "priority=1"}})
```

Set `SNOW_LAZY_TOOLS=false` to register the whole catalog up front instead.

## When it does not work

Setting up OAuth on an instance you have never used is the part that goes wrong, and it goes wrong
invisibly: the server starts without credentials, so the first symptom is an error inside an unrelated tool
call. Ask for a diagnosis instead of guessing:

```bash
servicenow-mcp-stdio --doctor
```

```
ServiceNow MCP — setup check

  warn  credentials   Loaded from /Users/you/.serac/auth.json (modified 2026-01-04).
                      instance https://dev11111.service-now.com
                      client id …ab12, client secret set
                      environment: SNOW_CLIENT_ID, SNOW_CLIENT_SECRET set, but the environment link needs
                      instance + client id + client secret together, so it was skipped
  ok    instance url  https://dev11111.service-now.com
  FAIL  instance      The instance is hibernating.
                      HTTP 200, text/html;charset=UTF-8
                      -> Sign in at https://developer.servicenow.com, open your instance and press Wake.
  skip  oauth token   Not reached — fix the checks above first.
  skip  api access    Not reached — fix the checks above first.
  skip  roles         Not reached — fix the checks above first.

1 problem found. Fix the first FAIL above, then run this again.
```

It walks the chain the server itself walks — environment variables, then `auth.json`, then the enterprise
portal — and reports which link supplied what, so a forgotten `auth.json` cannot quietly outrank the
variables you just set. Then it checks the URL, the instance (hibernating instances answer with an HTML
login page, which makes every tool look like it has a parse bug), the OAuth token exchange (a rejected
client id is reported separately from a rejected grant, quoting what ServiceNow returned), the API call, and
finally how much of the catalog the authenticated account's roles actually cover, from
`sn-roles.manifest.json`.

It exits non-zero when something is wrong, prints nothing to stdout on the server path, and never prints a
secret. `snow_diagnose_setup` returns the same report to the model — useful when the MCP client hides the
server's stderr, which most of them do. That tool is stdio-only: the report describes the local process.

## Use it as a library

ESM only. The package exports named subpaths rather than one barrel, so importing blast-radius does not
pull in the transports:

```ts
import { snow_blast_radius_dependents_exec } from "@serac-labs/servicenow-mcp/blast-radius"

const result = await snow_blast_radius_dependents_exec(
  { artifact_type: "script_include", artifact_identifier: "AcmeUtils" },
  { instanceUrl, clientId, clientSecret, accessToken, tenantId: "customer-1042", origin: "http" },
)
```

Each tool is exported as a `*_def` / `*_exec` pair: the MCP tool definition and the executor.

| Subpath             | What it is                                                    |
| ------------------- | ------------------------------------------------------------- |
| `.`                 | Everything — the barrel                                       |
| `/server`           | `createServer()`, to embed the MCP server in your own process |
| `/stdio`            | The stdio transport                                           |
| `/http`             | The streamable-HTTP transport, as a Hono app                  |
| `/blast-radius`     | Impact-analysis tools, usable without the MCP layer           |
| `/sn-roles`         | The ServiceNow roles each tool needs — see below              |
| `/types`            | `ServiceNowContext`, `MCPToolDefinition`, …                   |
| `/auth`             | OAuth + basic auth, token cache, authenticated Axios client   |
| `/error-handler`    | Result envelopes and error classification                     |
| `/enterprise-proxy` | Client for the licensed enterprise tool catalog               |

## A note on tenancy

`ServiceNowContext` carries a `tenantId` and an `origin`, and they are not decoration.

- **stdio** is single-tenant: one process, one user, one credential set. In-process caches are shared
  across requests and that is correct.
- **HTTP** is multi-tenant: one process serves every customer, so every cache and every piece of session
  state is keyed by tenant. A request that cannot be placed in a tenant is refused rather than pooled into
  a shared bucket — see `src/servicenow-mcp-unified/shared/tenant-scope.ts`.

If you embed a tool executor directly (rather than going through a transport), pass a `tenantId` whenever
your process serves more than one customer. Without one, tenant-keyed caches fall back to fingerprinting
the credentials, which is safe but colder.

None of this state is shared between processes, so an HTTP deployment should run **single-replica** or
supply its own shared store.

## The roles manifest

`sn-roles.manifest.json` answers "which ServiceNow role do I need to run this tool?" It is empirical, not
documentation-derived: `script/probe-sn-roles` extracts every `(table, operation)` pair each tool performs,
then resolves it against a live instance's `sys_security_acl` — the rows ServiceNow's own auth engine reads
at request time. `files` ships it inside the npm tarball as of the next release — 0.2.1 and earlier did not
contain it at all — and the `/sn-roles` subpath types it:

```ts
import { loadSnRolesManifest } from "@serac-labs/servicenow-mcp/sn-roles"

const manifest = loadSnRolesManifest()
manifest.tools["snow_trigger_scheduled_job"].snRoles
// { anyOf: ["admin", "system_scheduler_admin"], minimumBundle: ["system_scheduler_admin"] }
```

`loadSnRolesManifest()` re-reads and re-parses ~420 kB per call, so hold the result. `snRolesManifestPath`
is the absolute path to the same file, for consumers that would rather stream or serve it than parse it.

### Schema

| Top-level     | What it is                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `version`     | Schema version, currently `1`. Bumped when the shape changes, not when the data is re-probed.            |
| `validatedOn` | The release string the probed instance reported, e.g. `glide-australia-02-11-2026__patch1-…`.            |
| `testedAt`    | When the probe ran, ISO-8601.                                                                            |
| `stats`       | Rollups over the whole run, below.                                                                       |
| `tools`       | Keyed by tool name. A tool that is absent has not been probed, which is not the same as needing no role. |

Each tool is one of two shapes. Resolved:

```json
"snow_job_status": {
  "snRoles": { "anyOf": ["admin"], "minimumBundle": ["assessment_admin", "snc_internal"] },
  "primitives": [
    { "table": "sys_trigger", "operation": "read", "roles": ["…"], "source": "direct", "scriptAcls": 0 },
    { "table": "sys_execution_tracker", "operation": "read", "roles": ["snc_internal"], "source": "direct", "scriptAcls": 1 }
  ]
}
```

- **`anyOf`** — single roles that ALONE suffice for the whole tool: the intersection of every primitive's
  role list, plus `admin`, which bypasses ACLs outright. Just `["admin"]` means no single non-admin role
  covers it. `public` shows up here too; it is ServiceNow's "no authentication required" marker, not a role
  anyone can be granted, so do not render it as one.
- **`minimumBundle`** — the smallest set of roles a user needs _together_ (greedy set-cover), computed with
  the `public` primitives dropped — which is why a tool whose every primitive is `public` comes out as `[]`,
  needing no authenticated role at all. `["admin"]` means some primitive had nothing non-admin left in its
  role list, and that happens two ways: a genuinely admin-only ACL, or an ACL carrying no roles at all,
  which any authenticated caller passes. They are indistinguishable in the rollup, so check that
  primitive's own `roles` before telling someone they need admin. `admin` stays an implicit alternative
  either way.
- **`primitives`** — one entry per table call the tool makes, so a table read three times appears three
  times. `roles` is OR-combined across every matching ACL, and an empty `roles` means the ACL rows exist but
  name no role — any authenticated caller passes. `source` is how the ACL was found: `direct` on the table,
  `inherited` from a `sys_db_object.super_class` ancestor (then `inheritedFrom` names it), `wildcard` from
  the `*` ACL, or `none` — nothing matched at any level, and `roles` is then ServiceNow's implicit
  admin-only deny, assumed rather than measured. `scriptAcls` counts matching ACLs that carry a condition or
  advanced script — above zero, the role list is necessary but may not be sufficient, because those scripts
  run per record and the probe cannot evaluate them.

Untestable:

```json
"snow_date_filter": {
  "snRoles": null,
  "untestable": true,
  "reason": "no /api/now/table/<table> calls detected in static analysis"
}
```

**`untestable` means "not measurable by this method", not "needs no role"** — `stats.untestable` is how many
entries are in this state, and it is a large share of them. The extractor only sees literal
`/api/now/table/<table>` endpoints passed to `client.get/post/…`, so tools that go through Scripted REST or
another API, tools that only compute locally, and tools that build their table name at runtime all land here
with no roles at all.

`stats` mirrors the run: `tools` and `untestable` are entry counts; `primitivesTotal` is the number of
distinct `(table, operation)` pairs and `primitivesResolved` how many of them the instance answered for
(fewer means a partial run); `sourceDistribution` counts primitive _occurrences_, so it sums higher than
`primitivesTotal`; and `topRoles[].tools` is misnamed — it counts distinct primitives whose ACLs accept the
role, not tools.

### Staleness

`validatedOn`, not `testedAt`, is the field that matters: roles and ACLs move between ServiceNow families
and sometimes between patches, so the manifest is exact for the release it names and a strong hint
elsewhere. Nothing refreshes it automatically — `probe:sn-roles` needs OAuth credentials for a live
instance, so it is a human running it after a family upgrade and diffing the result.

Tools added since the last run therefore have no entry — there are some today. `src/__tests__/sn-roles.test.ts`
names the current set and fails if it changes in either direction, so the gap stays visible instead of
silently growing.

## Published manifests — read before moving them

Two generated JSON files live at the root of this package. Both are published _by
being committed_, because live services fetch them straight from `main` over
`raw.githubusercontent.com`. `sn-roles.manifest.json` is _also_ in the npm
tarball, behind the `/sn-roles` subpath above; `tools.json` is not:

| File                     | Fetched at runtime by                                                         | If the URL 404s                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.json`             | `docs.serac.build` — the Complete Tool Reference                              | Hard and immediate. The fetch `throw`s and the whole section renders an error box for every visitor.                                                                                |
| `sn-roles.manifest.json` | The Serac Portal's tool-permissions API **and** `docs.serac.build` separately | Silent and delayed. The portal caches for 30 min and serves stale, so it breaks on the next cold start, not at deploy. The docs copy null-guards and quietly drops the role column. |

So: **changing the path of either file is a production change, not a refactor.**
It needs the consumer repointed and deployed first, then the old path removed in
a separate commit. Never both in one.

"Published by being committed" also means **`git add` is part of the release.**
When these two files were moved here out of `packages/opencode`, they spent a
while as untracked files: every gate — install, typecheck, tests, build, the
standalone packaging gate — passed, because nothing in this package imports
them. A `git commit -am` at that moment would have shipped the deletion of the
old path with nothing at the new one, and the first symptom would have been
docs.serac.build erroring for every visitor.

`script/__tests__/published-manifests.test.ts` is the backstop: it fails if
either manifest is missing, unparseable, or has lost the top-level shape its
consumers destructure. It asserts nothing about freshness — that is
`generate:tools-json:check`, which `.github/workflows/test.yml` runs on every
push and PR.

### Regenerating them

```bash
bun run --cwd packages/servicenow-mcp generate:tools-json         # writes tools.json
bun run --cwd packages/servicenow-mcp generate:tools-json:check   # drift gate, no write
bun run --cwd packages/servicenow-mcp probe:sn-roles              # writes sn-roles.manifest.json
```

`generate-tools-json.ts` walks `src/servicenow-mcp-unified/tools/`, imports each
tool and reads its `toolDefinition` — it is pure and safe to run in CI, and it
refuses to write a partial manifest if any tool file fails to import.

`probe-sn-roles/` cannot run in CI: it resolves each tool's minimum ServiceNow
role by reading `sys_security_acl` on a **live instance**, so it needs OAuth
credentials and is a deliberate manual run. Re-run and diff it after a
ServiceNow family upgrade. See `script/probe-sn-roles/README.md`.

Both generators were stranded on an unmerged branch for two months while the
manifests they own sat frozen on `main` — that is why they now live next to the
tools they describe, and why `generate:tools-json:check` exists.

## Requirements

Node 20+ or Bun 1.2+. ESM only — there is no CommonJS `require` entrypoint.

## Links

- [docs.serac.build](https://docs.serac.build) — the full tool reference, generated from `tools.json`
- [`@serac-labs/skills`](../skills) — the ServiceNow skill guides that teach an agent to drive these tools
- [Serac](https://serac.build) — the product this catalog was built for
- [Issues](https://github.com/serac-labs/serac/issues)
- [Source](https://github.com/serac-labs/serac/tree/main/packages/servicenow-mcp)

Apache-2.0
