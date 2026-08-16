# @serac-labs/servicenow-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for ServiceNow: 437 `snow_*` tools over
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

## Published manifests — read before moving them

Two generated JSON files live at the root of this package. They are **not** part
of the npm tarball; they are published _by being committed_, because live
services fetch them straight from `main` over `raw.githubusercontent.com`:

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
