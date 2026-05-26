# Agent prompt fragments

The end-user agent's `AGENTS.md` doctrine is composed from the fragments in
this directory instead of being one monolithic file. This keeps the
ServiceNow doctrine that must never drift (the Two Hard Rules, silent tool
discovery, the core anti-patterns, …) in a single canonical place that
downstream products can consume.

## Folders

| Folder | Who consumes it | Notes |
|---|---|---|
| `shared/` | **The TUI agent template** (`../agents-template.ts`) **and** the Serac Portal | Environment-invariant ServiceNow doctrine. Editing a file here changes the agent's behaviour in every product. Treat changes as you would a prompt change anywhere — they ship to users. |
| `oss/` | The TUI agent template only | CLI/TUI-specific overlay (identity line, REVIEWER.md, `sn_render_preview` / local-sync workflows, the CLI anti-patterns and checklist). |
| `prompt-blocks/` | Downstream products only (the Serac Portal) | Canonical source for non-`AGENTS.md` system-prompt pieces the portal assembles at runtime — chart-rendering instructions, the bundled-skills catalog preamble, and the plan/explore mode prefixes. Hosted here so the prompting that reaches portal end users is open-source and single-sourced, even though the TUI does not import these itself. |

## How it's assembled

`../agents-template.ts` imports the `shared/` + `oss/` fragments via Bun's
text-file loader and joins them in a fixed order into `AGENTS_TEMPLATE`,
which `../bootstrap.ts` writes to a new project's `AGENTS.md`. A snapshot
test (`test/project/agents-template.test.ts`) locks the composed output so a
fragment edit surfaces as a reviewable diff rather than silent drift.

The Serac Portal syncs `shared/` + `prompt-blocks/` at build time (see its
`scripts/sync-oss-prompts.ts`) and composes its own `AGENTS.md` from
`shared/` + a portal-specific overlay.