# @serac-labs/servicenow-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for ServiceNow: ~426 `snow_*` tools over
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

| Subpath            | What it is                                                     |
| ------------------ | -------------------------------------------------------------- |
| `.`                | Everything — the barrel                                        |
| `/server`          | `createServer()`, to embed the MCP server in your own process   |
| `/stdio`           | The stdio transport                                            |
| `/http`            | The streamable-HTTP transport, as a Hono app                    |
| `/blast-radius`    | Impact-analysis tools, usable without the MCP layer             |
| `/types`           | `ServiceNowContext`, `MCPToolDefinition`, …                     |
| `/auth`            | OAuth + basic auth, token cache, authenticated Axios client     |
| `/error-handler`   | Result envelopes and error classification                       |
| `/enterprise-proxy`| Client for the licensed enterprise tool catalog                 |

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

## Requirements

Node 20+ or Bun 1.2+. ESM only — there is no CommonJS `require` entrypoint.

## Links

- [Serac](https://serac.build) — the CLI and agent this catalog was built for
- [Issues](https://github.com/serac-labs/serac/issues)
- [Source](https://github.com/serac-labs/serac/tree/main/packages/servicenow-mcp)

Apache-2.0
