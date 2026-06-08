Proactively identify 2–3 concrete contributions the user could make, based on open labels, code gaps, and TODOs. Research, don't code.

## Input

Optional `$ARGUMENTS`: a focus area like `servicenow`, `skills`, `docs`, `bug`, `perf`. If empty, scan broadly.

## Steps

1. **Read the playbook first.** `.claude/playbook.md` tells you the contribution types and where each lives. Don't suggest contributions that don't map to a type.

2. **Gather candidates from four sources:**

   a. **GitHub labels** — via `gh issue list`:
      - `gh issue list --label "good first issue" --state open --limit 10 --json number,title,labels`
      - `gh issue list --label "help wanted" --state open --limit 10 --json number,title,labels`
      - `gh issue list --label "bug" --state open --limit 10 --json number,title,labels`
      - If `$ARGUMENTS` specifies a focus area, bias the selection toward issues that match it.

   b. **Missing ServiceNow tool coverage** — if focus is `servicenow` or empty:
      - List `packages/servicenow-mcp/src/servicenow-mcp-unified/tools/` to see existing domains.
      - Pick 1–2 domains and list files in them. Look for notable *gaps*: obvious CRUD operations that are missing (e.g. a domain has `create` and `get` but no `update` or `delete`), or common ServiceNow endpoints that aren't wrapped yet. Be concrete. Don't invent gaps.
      - Cross-reference with the unified server README (`servicenow-mcp-unified/README.md`) section "Tool Count by Category" to sanity-check coverage.

   c. **TODO / FIXME markers in the code** — if focus is `bug` or empty:
      - `grep -rn "TODO\|FIXME\|XXX" packages/opencode/src/ | head -20` (or equivalent Grep search)
      - Filter out generic/obvious ones. Look for markers that describe a *concrete* missing feature or known limitation.

   d. **Bundled skills gaps** — if focus is `skills` or empty:
      - List `packages/opencode/src/bundled-skills/`. Compare against common ServiceNow workflows (catalog items, business rules, UI scripts, ATF, flow designer, client scripts). If a common workflow has no skill, that's a candidate.

3. **Filter to realistic work.** A good suggestion is:
   - Well-scoped (can be done in a single focused PR)
   - Maps to one playbook contribution type
   - Has either an existing issue (reference it) or is small enough that you can tell the user "open an issue first, then code"
   - Not blocked on design review (Type 3 work requires maintainer approval — only suggest it with a warning)

4. **Rank and pick the top 2 or 3.** For each, write:
   - **What** — one short sentence
   - **Type** — which playbook section applies
   - **Effort** — rough S/M/L
   - **Starting point** — which file(s) to read first, which existing example to copy from
   - **Issue status** — link to existing issue, or note "needs new issue first"

5. **Report to user.** Short. Don't pad.

## Safety gates

- **Don't suggest contributions that require design review** (new providers, core feature changes, UI changes) without explicitly flagging "this needs maintainer approval first — open an issue and wait for a green light".
- **Don't invent gaps.** If you can't find a concrete missing thing, say so. "Nothing obvious — the code coverage looks healthy" is a valid and honest answer.
- **Don't start picking an issue automatically.** This command is suggest-only. The user runs `/pick-issue <number>` if they want to proceed.

## Cross-references

- `.claude/playbook.md` — contribution types
- `packages/servicenow-mcp/src/servicenow-mcp-unified/README.md` — tool domain structure and count
- `CONTRIBUTING.md` — Issue-First Policy and the Type 3 design review rule

## Output format

```
Suggestions (focus: <area or "broad">)

1. [M, Type 1 — ServiceNow tool] Add snow_bulk_update_records to operations/
   The operations domain has create/get/delete but no bulk update. #2341 already
   tracks it. Start from tools/operations/snow_update_record.ts.

2. [S, Type 4 — bug fix] Fix telemetry crash exit reporting
   #3102. Affects the opencode CLI. See packages/opencode/src/session/prompt.ts
   around line 847.

3. [L, Type 2 — bundled skill] Add flow-designer skill
   No existing bundled skill covers Flow Designer patterns. Needs a new issue
   first. Copy format from bundled-skills/code-review/SKILL.md.

Pick one and run /pick-issue <number>, or open a new issue first for suggestions
without an existing number.
```
