# Contributing to Serac

This repository is a ServiceNow MCP server and a set of skill guides. Contributions that fit well:

- A new `snow_*` tool, or a fix to an existing one
- A new skill guide, or a correction to one
- Behaviour that differs across ServiceNow releases, scopes, or domain-separated instances
- Bug fixes with a reproduction
- Documentation that was wrong or missing

If you are unsure whether something would be accepted, open an issue and ask before writing it.

## Issue first

**Every PR links an issue.** Open one describing the bug or the idea, then reference it from the PR with
`Fixes #123` or `Closes #123`. For a small fix a couple of sentences is enough — just enough context for a
maintainer to understand the problem without reading the diff first. PRs with no linked issue may be closed
without review.

For anything net-new, wait for a maintainer to agree on the approach in the issue before you build it. That
is not bureaucracy; it is the only way to avoid someone spending a weekend on a PR that will not be merged.

## License and the DCO

Serac is released under the [Apache License 2.0](./LICENSE). Its history begins in the MIT-licensed
[opencode](https://github.com/anomalyco/opencode) project — see [`NOTICE`](./NOTICE). By contributing you
agree your contributions are licensed under the same Apache 2.0 terms.

We use the [Developer Certificate of Origin](https://developercertificate.org/) — a lightweight way to
certify that you wrote, or otherwise have the right to submit, the code you contribute. It is **not** a
copyright-assignment CLA; you keep ownership of your work.

Sign off every commit, which `git commit -s` does for you:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email must match the commit author.

## Getting set up

Requires [Bun](https://bun.sh) 1.3.14 (pinned in the root `package.json`).

```bash
bun install
bun typecheck
bun run test
```

That is the whole toolchain. There is no build step for development — both packages run from TypeScript
source; `bun run build` in the MCP package exists only to produce the npm tarball.

### Testing against a real instance

Most of the test suite runs offline. Anything that talks to ServiceNow needs an instance: get a free
developer instance from [developer.servicenow.com](https://developer.servicenow.com), create an OAuth entry
under `System OAuth > Application Registry`, and export:

```bash
export SNOW_INSTANCE_URL=https://dev12345.service-now.com
export SNOW_CLIENT_ID=…
export SNOW_CLIENT_SECRET=…
```

Developer instances hibernate after a few days of inactivity and then answer with an HTML login page instead
of JSON, which makes failures look like parse errors. If a tool starts returning nonsense, wake the instance
first — `bun packages/servicenow-mcp/src/servicenow-mcp-unified/index.ts --doctor` says whether that is what
happened, along with which credentials it picked up and from where.

### Adding a tool or a skill

Both are described in [AGENTS.md](./AGENTS.md), along with the code style. The short version:

- A tool is one file under `packages/servicenow-mcp/src/servicenow-mcp-unified/tools/<domain>/`. After
  adding one, run `bun run --cwd packages/servicenow-mcp generate:tools-json`.
- A skill is one directory under `packages/skills/` containing a `SKILL.md`. After adding one, run
  `bun run --cwd packages/skills generate`.

Both generators have a `--check` mode, and `bun test` fails if the checked-in artifact drifts from the tree.

### Two files that are production

`packages/servicenow-mcp/tools.json` and `packages/servicenow-mcp/sn-roles.manifest.json` are fetched at
runtime from `main` by live services. Changing their **contents** is normal. Changing their **path** is a
production change that needs the consumer repointed and deployed first, then the old path removed in a
separate commit. Never both in one PR.

### Formatting

The MCP source is not uniformly prettier-formatted, and this is deliberate for now: reformatting ~180 files
would bury every real change in whitespace. `bun run format` exists, but please do not run it across files
you are not otherwise touching. Match the style of the code around you.

## Pull request expectations

- **Keep it small and focused.** One issue, one PR.
- **Explain how you verified it.** What did you run? How can a reviewer confirm it? For a tool, "I called it
  against a developer instance and got X" is worth more than any amount of description.
- **No AI-generated walls of text.** Long generated PR descriptions and issues are not acceptable and may be
  ignored. Write short descriptions in your own words. If you cannot explain the change briefly, it is
  probably too large.
- **PR titles follow conventional commits:** `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, with
  an optional scope — `fix(mcp): …`, `docs(skills): …`.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md).

## Issues

Use one of the issue templates. Blank issues are disabled. A bug report needs enough detail to reproduce:
what you ran, what happened, what you expected, and which ServiceNow release you are on.
