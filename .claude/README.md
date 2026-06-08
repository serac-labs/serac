# AI contributor harness for Serac

A minimal, opinionated harness for contributing to Serac with an AI coding agent (Claude Code, OpenCode, or any harness that reads `.claude/commands/`). Use it if you want, skip it if you don't — Serac accepts regular PRs either way.

## What this gives you

Six slash commands that map to the concrete work a Serac contributor actually does, plus a `playbook.md` the agent reads before suggesting or scaffolding anything so it doesn't guess about where files belong.

| Command | Purpose |
|---|---|
| `/setup` | First-time bootstrap: verify Bun, install deps, run a smoke check, orient you in the monorepo |
| `/pick-issue <number>` | Fetch a GitHub issue via `gh`, read the relevant code, propose an approach — and wait for your OK before changing anything |
| `/suggest-contribution` | Proactively identify gaps (open `help wanted` / `good first issue` labels, missing ServiceNow tool coverage, TODOs, docs holes) and propose 2–3 concrete contributions with impact estimates |
| `/add-servicenow-tool <tool_name>` | Scaffold a new tool in `packages/servicenow-mcp/src/servicenow-mcp-unified/tools/<domain>/` following the existing pattern, wired up via the domain's `index.ts` |
| `/add-skill <slug>` | Scaffold a new bundled skill in `packages/opencode/src/bundled-skills/<slug>/SKILL.md` with the right frontmatter |
| `/verify` | Run the *right* tests/typecheck for your diff (not the full suite — just what your change actually touched) |
| `/open-pr` | Create a PR that follows [CONTRIBUTING.md](../CONTRIBUTING.md): conventional commit title, **short** body in your own words, `Fixes #N` link, screenshot reminder for UI changes |

## The one rule the harness will not break

From `CONTRIBUTING.md`:

> Long, AI-generated PR descriptions and issues are not acceptable and may be ignored.

The `/open-pr` command is built to resist writing AI-fluff descriptions. It will ask *you* for a short, human-written summary and refuse to generate walls of text for you. Respect this — if you paste a generated paragraph, the maintainers will likely close the PR.

## Issue-First Policy

Serac requires every PR to link an existing issue. `/pick-issue` starts from an issue. `/suggest-contribution` will tell you when there's already a matching issue, and when you need to open a new one before coding. Don't skip this step — PRs without linked issues get closed.

## Prerequisites

- **Bun 1.3+** — for the repo itself
- **`gh` CLI** — authenticated (`gh auth status` should say you're logged in). Used by `/pick-issue`, `/suggest-contribution` and `/open-pr` to read issues and open PRs. No custom MCP server required.
- **Claude Code or another harness** that loads `.claude/commands/` as slash commands
- **Default branch is `main`.** Always branch from `main`.

## First-time setup

```bash
# Clone the repo
git clone https://github.com/serac-labs/serac.git
cd snow-flow
git checkout main

# Open in your AI harness, then run:
/setup
```

## How to use this

1. `/setup` once after cloning.
2. When you want to contribute but don't know where to start: `/suggest-contribution`.
3. When you've picked an issue: `/pick-issue 1234`.
4. While coding: use `/add-servicenow-tool` or `/add-skill` as shortcuts if your contribution is one of those two common patterns.
5. Before opening a PR: `/verify`.
6. To open the PR: `/open-pr` — and **write the summary yourself**.

## What's in this directory

```
.claude/
├── README.md         # ← this file
├── playbook.md       # Per contribution type: where in the code, example, tests, PR label
└── commands/
    ├── setup.md
    ├── pick-issue.md
    ├── suggest-contribution.md
    ├── add-servicenow-tool.md
    ├── add-skill.md
    ├── verify.md
    └── open-pr.md
```

## Feedback

If a command suggests something dumb, tells you something wrong, or scaffolds a file in the wrong place: open an issue with the label `harness` and describe what went wrong. The harness should evolve with the codebase — patterns that drift out of sync are the whole point of this file instead of unwritten tribal knowledge.
