# Agent prompt fragments

An end-user agent's `AGENTS.md` doctrine is composed from the fragments in this
directory instead of being one monolithic file. This keeps the ServiceNow
doctrine that must never drift (the Two Hard Rules, silent tool discovery, the
core anti-patterns, …) in a single canonical place that downstream products can
consume.

They live in `@serac-labs/servicenow-mcp` because the MCP server and the skills
are the two things this repository ships — every consumer of this doctrine must
be able to reach it without any other package existing. They are plain assets:
the MCP's own TypeScript never imports them, but they are listed in `files` and
re-exported under the `./agent-fragments/*` subpath, so they ship in the npm
tarball as well as in a git clone.

## Folders

| Folder           | Who consumes it  | Notes                                                                                                                                                                                                                                                                                         |
| ---------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/`        | The Serac Portal | Environment-invariant ServiceNow doctrine. Editing a file here changes the agent's behaviour in every product that syncs it. Treat changes as you would a prompt change anywhere — they ship to users.                                                                                        |
| `prompt-blocks/` | The Serac Portal | Canonical source for the non-`AGENTS.md` system-prompt pieces the portal assembles at runtime — chart-rendering instructions, the bundled-skills catalog preamble, and the plan/explore mode prefixes. Hosted here so the prompting that reaches end users is open-source and single-sourced. |

There was a third folder, `oss/`, holding a CLI/TUI-specific overlay (identity
line, REVIEWER.md, local-sync dev workflows, CLI anti-patterns and checklist).
Its only consumer was the terminal agent that used to live in this repository,
and the portal sync has always excluded it by name. It was removed with that
agent; recover it from git history if a future host wants an overlay to start
from.

## How it's assembled

These are plain `.txt` assets — nothing in this package imports them. The
consumer reaches in from outside, which is why the directory layout is a
contract rather than an implementation detail.

**The Serac Portal** syncs `shared/` + `prompt-blocks/` at build time (its
`portal/backend/scripts/sync-oss-prompts.ts`) and composes its own `AGENTS.md`
from `shared/` plus a portal-specific overlay. It resolves this directory **by
path**, out of an unpinned `git clone` of this repo run inside its Docker build,
and the sync script `process.exit(1)`s when the path is missing — inside a `&&`
chain, so a rename here turns the portal's image build red. **Do not rename or
move `shared/` or `prompt-blocks/` without landing the portal change first.**
The path has moved once already and the portal had to grow fallbacks to survive
it; those fallbacks point at paths that no longer exist, so there is nothing
left to catch a second move.
