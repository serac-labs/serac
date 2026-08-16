<p align="center">
<pre align="center">
███████╗███████╗██████╗  █████╗  ██████╗
██╔════╝██╔════╝██╔══██╗██╔══██╗██╔════╝
███████╗█████╗  ██████╔╝███████║██║     
╚════██║██╔══╝  ██╔══██╗██╔══██║██║     
███████║███████╗██║  ██║██║  ██║╚██████╗
╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝
</pre>
</p>

<h3 align="center">A ServiceNow MCP server, and the skill guides that teach an agent to use it.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@serac-labs/servicenow-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@serac-labs/servicenow-mcp?style=for-the-badge&logo=npm&logoColor=white&color=CB3837" /></a>&nbsp;
  <a href="https://github.com/serac-labs/serac/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/serac-labs/serac?style=for-the-badge&logo=github&color=yellow" /></a>&nbsp;
  <a href="https://github.com/serac-labs/serac/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge" /></a>
</p>

Two packages, and nothing else:

| Package                                                 | What it is                                                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`@serac-labs/servicenow-mcp`](packages/servicenow-mcp) | An MCP server for ServiceNow. 400+ `snow_*` tools over stdio or streamable HTTP, plus blast-radius impact analysis.   |
| [`@serac-labs/skills`](packages/skills)                 | 57 ServiceNow skill guides. Plain markdown an agent loads into its prompt so it uses those tools like a practitioner. |

The two are meant to be used together. The server gives a model the ability to act on a ServiceNow instance;
the skills give it the judgement to do so without breaking one — which update set to be in, why a Business
Rule needs ES5, what to check before renaming a field.

Both work with any [MCP](https://modelcontextprotocol.io) client. Neither requires the Serac product.

## Quick start

```bash
npm install -g @serac-labs/servicenow-mcp
```

Point your MCP client at the `servicenow-mcp-stdio` binary:

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

Credentials come from an OAuth application registry entry on your instance (`System OAuth > Application
Registry`). A developer instance from [developer.servicenow.com](https://developer.servicenow.com) is enough
to try everything here.

The catalog is far larger than a context window, so tools are **deferred** by default: `tools/list` returns
two meta-tools and the model widens its own surface as it works.

```
tool_search({query: "incident"})  → the matching tools, now enabled
tool_execute({tool: "snow_query_incidents", args: {query: "priority=1"}})
```

Set `SNOW_LAZY_TOOLS=false` to register the whole catalog up front instead. Full options, library usage and
the multi-tenancy rules are in the [package README](packages/servicenow-mcp/README.md).

### As a Claude Code plugin

The repository is also a plugin marketplace, so the server and all 57 skills arrive in one step:

```
/plugin marketplace add serac-labs/serac
/plugin install servicenow@serac
```

The server runs through `npx`, so nothing has to be installed first: export `SNOW_INSTANCE_URL`,
`SNOW_CLIENT_ID` and `SNOW_CLIENT_SECRET` and it is ready. The same entry is in [`.mcp.json`](.mcp.json) at
the repo root, which Claude Code reads for this project. Other clients each want it somewhere else: copy it
into `.cursor/mcp.json` (Cursor), `~/.codeium/windsurf/mcp_config.json` (Windsurf), or `.vscode/mcp.json`
for VS Code, which names the same block `servers` rather than `mcpServers`.

### Using the skills

A skill is a directory with a `SKILL.md`: YAML frontmatter naming the skill and the `snow_*` tools it
expects, then prose. Nothing loads them automatically — a host decides which ones to put in front of the
model. Copy the ones you want into your agent's skills directory, or read them from the package:

```ts
import { skillsRoot } from "@serac-labs/skills/root"
```

They are worth reading on their own, even without an agent involved. Start with
[`es5-compliance`](packages/skills/es5-compliance/SKILL.md),
[`update-set-workflow`](packages/skills/update-set-workflow/SKILL.md) or
[`blast-radius`](packages/skills/blast-radius/SKILL.md).

## Working on it

Requires [Bun](https://bun.sh) 1.3.14 — pinned in the root `package.json` `packageManager` field, which is
also what CI installs.

```bash
bun install
bun typecheck          # tsgo across both packages
bun run test           # both suites: 168 MCP tests, 60 skills tests
bun run lint           # oxlint
```

Tests do not run from the repo root directly — run them per package, or through turbo with `bun run test`:

```bash
cd packages/servicenow-mcp && bun test
cd packages/skills && bun test
```

### Adding a tool

Tools live in `packages/servicenow-mcp/src/servicenow-mcp-unified/tools/<domain>/snow_<name>.ts`, one file
per tool, each exporting a `toolDefinition` and an executor. The registry is generated by walking that
directory, so a new file in the right shape is a new tool — there is no central list to edit. Regenerate the
published manifest afterwards:

```bash
bun run --cwd packages/servicenow-mcp generate:tools-json
```

### Adding a skill

Create `packages/skills/<name>/SKILL.md` with frontmatter, then regenerate the embedded map:

```bash
bun run --cwd packages/skills generate
```

`bun test` in that package fails if the embedded map drifts from the tree, or if frontmatter names a tool the
MCP server does not actually have. Both of those have shipped to users before.

### Two files that are production, not build output

`packages/servicenow-mcp/tools.json` and `packages/servicenow-mcp/sn-roles.manifest.json` are committed
generated files, and live services fetch them straight from `main` over `raw.githubusercontent.com`. They are
published by being committed. Moving or renaming either one is a production change: the consumer has to be
repointed and deployed first, and the old path removed in a separate commit afterwards. See
[the package README](packages/servicenow-mcp/README.md#published-manifests--read-before-moving-them).

## Releases

`@serac-labs/servicenow-mcp` publishes from `.github/workflows/publish-mcp.yml` — a manual
`workflow_dispatch`, versioned from `packages/servicenow-mcp/package.json` and nothing else, with OIDC
trusted publishing and signed provenance. Every PR that touches the package runs the same build, test and
packaging gates without publishing, including one that copies the package out of the workspace entirely and
proves it installs, builds and tests with no monorepo around it.

`@serac-labs/skills` is not on npm today. It is consumed from a checkout.

## What used to be here

This repository was a fork of [opencode](https://github.com/anomalyco/opencode) carrying a terminal AI agent,
a TUI, a desktop app and a web console. Twenty-five packages went; the two above remain. The
`@serac-labs/core` CLI those packages built is discontinued — it stays installable on npm at its final
version, but there are no further releases and no security fixes for it.

The ServiceNow work was always the part worth keeping, and it was the part buried deepest. It is now the
whole repository.

One artifact of that era is deliberately still here: the `install` script at the repo root. Every CLI already
installed in the world fetches that exact URL when it self-upgrades, and `serac.build/install` redirects to
it. Deleting the file would pipe a GitHub 404 page into those users' shells. It stays until it is replaced
with something that tells them what happened — do not tidy it away.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) first — it is short. Every PR links an issue, and the code style
rules are in [AGENTS.md](./AGENTS.md).

## License

[Apache License 2.0](LICENSE). See [`NOTICE`](NOTICE) for third-party attributions: this code's history
begins in the MIT-licensed [opencode](https://github.com/anomalyco/opencode) project.
