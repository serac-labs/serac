# CLAUDE.md

This file is read by Claude Code (and other harnesses that load `CLAUDE.md`) when you open this repo. Its only job is to orient you: most of what you need lives elsewhere.

## If you are a contributor using an AI coding agent

Start here: [`.claude/README.md`](./.claude/README.md).

The repo ships an optional harness with seven slash commands (`/setup`, `/pick-issue`, `/suggest-contribution`, `/add-servicenow-tool`, `/add-skill`, `/verify`, `/open-pr`) and a playbook mapping each contribution type to the right file locations, example to copy, tests, and PR conventions. You don't have to use it — regular PRs are equally welcome — but if you do, it will keep you inside the lines the maintainers care about.

## Non-negotiable rules (from `CONTRIBUTING.md`)

1. **Issue-First Policy.** Every PR links an existing issue (`Fixes #N` or `Closes #N`). No exceptions. The harness refuses to open a PR without one.
2. **No AI-generated walls of text.** PR descriptions and issue bodies must be short, focused, and written in your own words. The `/open-pr` command will ask *you* for the summary and refuse to generate prose on your behalf. Pasting generated paragraphs defeats the purpose; maintainers close PRs that do this.
3. **Default branch is `main`.** Always branch from `main`. PRs target `main`.
4. **Conventional commit prefixes.** `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `perf:`, optionally scoped like `feat(opencode):`.

## Style guide

See [`AGENTS.md`](./AGENTS.md). Short version: prefer `const`, avoid `let`/`else`/`try`-`catch`/`any`, prefer single-word identifiers, use Bun APIs where they fit, avoid unnecessary destructuring. No mocks in tests.

## PR flow and all the details

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). It covers Bun setup, debugger configuration, the full "what kind of changes get merged" list, the PR expectations (including the two non-negotiables above), and the conventional commit prefix table.

## Repo layout at a glance

```
packages/
├── opencode/     ← core CLI, server, TUI, MCP client, ServiceNow tools, bundled skills
├── app/          ← web UI (SolidJS + Vite)
├── desktop/      ← native app (Tauri v2, wraps app)
├── plugin/       ← plugin SDK
├── sdk/          ← JS SDK
├── ui/           ← shared UI components
├── util/         ← shared utilities
└── (~10 more)    ← console, docs, extensions, function, identity, mobile, script, slack, web, enterprise
```

Most contributions land in `packages/opencode/`. See `.claude/playbook.md` for the exact sub-paths per contribution type.

## Auto-generated artifacts (do not hand-edit)

- **`packages/opencode/tools.json`** — manifest of every public ServiceNow MCP tool (name, description, subcategory, permission, deprecated flag). Consumed by `docs.serac.build` to render the Complete Tool Reference table. Regenerated automatically by `.github/workflows/generate-tools-json.yml` on every push to `main` whenever `packages/opencode/src/servicenow/servicenow-mcp-unified/tools/**` changes; the workflow runs `bun packages/opencode/script/generate-tools-json.ts` and commits the result with `[skip ci]`. Run locally with the same command if you want to preview before pushing.

  When you add/edit/remove a tool: change only the `.ts` file in `tools/`. Don't edit `tools.json` directly — your edit will be overwritten on the next workflow run, and the description there is authoritative-by-source-of-truth, not authoritative-by-edit.

## Things not to do

- Don't read `packages/opencode/src/project/agent-fragments/` for style guidance — those fragments compose the end-user agent's `AGENTS.md` (the product prompt, not contributor guidance). If you do edit a fragment, the snapshot test in `test/project/agents-template.test.ts` will flag the resulting `AGENTS.md` diff for review. The `prompt-blocks/` subfolder is consumed by downstream products (the Serac Portal), not the TUI — see that folder's `README.md`.
- Don't rename packages or modules as a side effect of another change.
- Don't add dependencies without justification in the PR body.
- Don't `git push --force` to any shared branch.
- Don't include `Co-Authored-By: Claude` or similar AI-attribution footers in commits or PR bodies — maintainers don't want them.
- Don't hand-edit `packages/opencode/tools.json` — see "Auto-generated artifacts" above.
