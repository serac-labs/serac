# Contribution playbook

Per contribution type: where it lives, how existing examples look, which tests run, and what to put on the PR. This file is the single source of truth for the slash commands in `.claude/commands/`. When the repo structure changes, update this file first and the commands will pick it up.

All paths are relative to the repo root. The package that holds the core CLI/TUI/server code is called **`packages/opencode/`** on disk (the CONTRIBUTING.md still uses the pre-rename name `packages/snow-code` in a few places — trust the filesystem, not the doc).

---

## Type 1: new ServiceNow MCP tool

**What this is:** A new tool that wraps a ServiceNow API endpoint or operation, added to the unified MCP server. The goal of the unified server is exactly one server with 225+ tools organized by domain, auto-discovered from the filesystem.

### Where it lives

```
packages/servicenow-mcp/src/servicenow-mcp-unified/
├── tools/
│   └── <domain>/
│       ├── snow_your_tool.ts        # ← new file
│       └── index.ts                  # ← add your export here
└── shared/
    ├── auth.ts                       # getAuthenticatedClient
    ├── types.ts                      # MCPToolDefinition, ServiceNowContext, ToolResult
    └── error-handler.ts              # createSuccessResult, createErrorResult, SnowFlowError
```

Existing domains include: `operations/`, `deployment/`, `cmdb/`, `knowledge/`, `catalog/`, `change/`, `events/`, `user-admin/`, `access-control/`, `data-management/`, `import-export/`, `workflow/`, `scheduled-jobs/`, `email/`, `forms/`, `lists/`, `business-rules/`, `sla/`, `approvals/`, `attachments/`, `ui-policies/`, `metrics/`, `dashboards/`, `menus/`, `applications/`, `automation/`, `update-sets/`, `ui-builder/`, `integration/`, `platform/`, `blast-radius/`, `agile/`, `security/`, `reporting/`, `flow-designer/`, `virtual-agent/`, `devops/`, `advanced/`, `local-sync/`, and ~40 more. Pick the one that matches your tool's *purpose*, not its underlying API. If no domain fits, ask in an issue before creating a new domain folder.

### Existing example to read before you write

`packages/servicenow-mcp/src/servicenow-mcp-unified/tools/automation/snow_execute_script.ts`

It demonstrates: shared types import, `toolDefinition` export with all metadata fields, `execute` async function, `getAuthenticatedClient(context)` usage, `createSuccessResult`/`createErrorResult`, ES5 validation of script input (ServiceNow runs Rhino), and the SnowFlowError wrapping pattern. Read the first 150 lines; you don't need the specific Rhino bits unless your tool executes scripts.

### The minimum file

```typescript
import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_your_tool",
  description: "One sentence. What does it do and when should the agent reach for it?",
  category: "<domain>",
  subcategory: "<optional subarea>",
  use_cases: ["one", "two"],
  complexity: "basic",          // basic | intermediate | advanced
  frequency: "medium",          // low | medium | high
  permission: "read",           // read | write
  allowedRoles: ["developer"],
  inputSchema: {
    type: "object",
    properties: {
      // your params
    },
    required: [],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const client = await getAuthenticatedClient(context)
    // your logic here
    return createSuccessResult({ /* data */ }, { /* meta */ })
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, err.message, { originalError: err }),
    )
  }
}

export const version = "1.0.0"
export const author = "your-github-handle"
```

### Registration

Add the file's exports to `tools/<domain>/index.ts`:

```typescript
export * from "./snow_your_tool.js"
```

The main `tools/index.ts` already does `export * from "./<domain>/index.js"` for every domain, so nothing to touch there unless you created a brand-new domain.

### Style rules specific to ServiceNow tools

- **ES5 only for any script string** you send to ServiceNow. The Rhino engine does not understand `const`, `let`, arrow functions, template literals, destructuring, `for...of`, or `class`. This applies to the *script content you generate*, not your TypeScript file.
- **Never log credentials** in error messages or success metadata.
- **Use the shared client** from `getAuthenticatedClient`. Don't build your own HTTP client — you'll skip OAuth refresh, retries, and pooling.
- **Return dicts or strings from tools**, never raw HTTP response objects.

### Tests

- Type check: ServiceNow tools now live in their own package — run `cd packages/servicenow-mcp && bun typecheck` (uses `tsgo`). For opencode itself: `cd packages/opencode && bun typecheck`.
- Smoke: `bun dev serve` and make sure the server boots without complaining about your new tool.
- If you added unit tests: `cd packages/opencode && bun test path/to/test`

### Live validation against a ServiceNow instance

There is no integration-test infrastructure in this repo (no live instance in CI). When you ship a tool that targets unfamiliar tables — or when you leave `// TODO: verify against live instance` markers in the code — use the developer-only `snow_dev_test_connection` tool (in `tools/development/`) to confirm your assumptions against any ServiceNow instance you have access to. Five actions, all read-only:

- `oauth` — verify caller-supplied OAuth credentials work against an instance (no context needed; bypasses the normal authenticated client to test arbitrary creds)
- `connection` — confirm the current authenticated context is healthy
- `table` — `sys_db_object` lookup to verify a table exists and is accessible (catches missing-plugin issues)
- `columns` — `sys_dictionary` lookup to list a table's column names + types — the fastest way to resolve "verify column X" TODOs
- `query` — dry-run an encoded query with `limit=1` to confirm result shape

The tool name prefix `snow_dev_*` and `category: "development"` mark it as developer-only; the portal in `serac-platform` excludes `category=development` from `CATEGORY_FEATURES` BASE so it does not appear in production instance-chat. Don't add other `snow_dev_*` tools without keeping that exclusion in mind.

If a tool you're building activates a non-default plugin (FSM, GRC, SIR, etc.), `snow_plugin_manage` (in `tools/plugins/`) handles the install: `activate` (with optional `wait: true` to block until done), `progress` (poll an async install), `repair` (rollback + reinstall for stuck plugins).

### PR conventions

- Title: `feat(opencode): add snow_your_tool for <one-liner>`  *(or `fix(...)` if replacing a broken tool)*
- Body: one paragraph — what the tool does, which ServiceNow endpoint it wraps, why this belongs in the unified server. Mention whether you tested it against a real instance.
- Label: `servicenow`, plus `feat` or `fix`

---

## Type 2: new bundled skill

**What this is:** A markdown-based "skill" that teaches the agent a reusable ServiceNow workflow, pattern, or checklist. Skills are discovered by the TUI and offered to the user as context when relevant.

### Where it lives

```
packages/opencode/src/bundled-skills/
└── <your-slug>/
    └── SKILL.md
```

One directory per skill, one `SKILL.md` per directory. No TypeScript, no tests, no compilation — just markdown.

### Existing example to read before you write

`packages/opencode/src/bundled-skills/code-review/SKILL.md` — covers the full format: frontmatter, instructional sections, code examples, severity tables. About 270 lines; read it end to end, it's short enough.

### The minimum file

```markdown
---
name: your-slug
description: This skill should be used when the user asks to "<trigger 1>", "<trigger 2>", or any <broader category>. Be specific about trigger phrases — the agent uses this to decide when to load the skill.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: your-github-handle
  version: "1.0.0"
  category: servicenow
tools:
  - snow_tool_that_this_skill_expects_to_call
  - snow_another_tool
---

# <Skill title>

<Short paragraph: what this skill teaches and when an agent should apply it.>

## 1. <First step or concept>

Explain, show ServiceNow code examples in fenced blocks (ES5 only for Rhino), flag common mistakes with ❌/✅.

## 2. <Next step or concept>

...

## Output format

<If the skill produces a structured output, show the exact format the agent should emit.>
```

### Style rules specific to skills

- **Triggers in the description are scanned verbatim.** Write them the way a user would phrase them ("review code", "check my ACLs"). Vague descriptions mean the skill never loads.
- **Code examples must be ES5** — Serac users are on ServiceNow Rhino.
- **Cite tools** in the frontmatter's `tools:` array so the TUI can pre-surface them when the skill activates. Use the real tool names from the unified MCP server.
- **Short is fine.** The `code-review` skill is 270 lines. A focused skill on "how to create a scheduled job" could be 40 lines. Don't pad.

### Registration

None — skills are auto-discovered by directory scanning under `bundled-skills/`. Just add the directory and the `SKILL.md`.

### Tests

Bundled skills don't have code tests. The validation is: does the markdown parse, does the frontmatter match the schema the loader expects, and do the trigger phrases actually overlap with how users phrase requests. If you changed `SKILL.md` schema: `cd packages/opencode && bun typecheck`.

### PR conventions

- Title: `feat(opencode): add <slug> bundled skill`
- Body: one paragraph — what the skill teaches, which user phrases trigger it, whether it depends on existing tools or expects new ones.
- Label: `skill`, plus `feat`

---

## Type 3: new AI provider

**What this is:** Add support for a new LLM provider through the Vercel AI SDK wrapper layer.

**Where it lives:** `packages/opencode/src/provider/` — see existing providers (e.g. `provider.ts`) to understand the registration pattern.

**Process:** This is a larger change that often touches auth flows and settings UI. **Do not start without opening an issue first** — providers are part of the "UI or core product feature" category in CONTRIBUTING.md that requires design review. Describe the provider, its auth model, and why it adds value that the existing providers don't cover. Wait for maintainer approval.

**PR conventions:** `feat(opencode): add <provider> support` with label `provider`.

---

## Type 4: bug fix

**Where it lives:** Wherever the bug is. Before touching code, find the related issue (or open one — Issue-First Policy). Read the surrounding code to understand why it was written that way; bugs are often tradeoffs, not mistakes.

**Tests:** Run the tests that currently cover the file you're changing (`/verify` will figure this out from the diff). If there's no existing test that would have caught the bug, add one. This is the single most important thing you can do as a bug-fixer.

**PR conventions:** Title starts with `fix:` or `fix(<scope>):`. Body explains:
1. The bug (what was broken)
2. The root cause (why it was broken)
3. How you verified the fix (what did you run, what was the before/after)

Per CONTRIBUTING.md section "Logic Changes", skipping the verification explanation is grounds for rejection.

---

## Type 5: performance improvement

**Where it lives:** Hot paths, usually in `packages/opencode/src/` — providers, session management, tool execution, or the TUI render loop. Don't guess — profile first.

**Before coding:** Benchmark the current state. Run the scenario that's slow, measure it (time, memory, CPU, whatever). Your PR must include before/after numbers. "Feels faster" is not acceptable.

**Tests:** All existing tests must still pass, and the benchmarks you ran must be included in the PR body.

**PR conventions:** Title `perf:` or `perf(<scope>):`. Body has before/after numbers and the command you used to measure. Label `perf`.

---

## Type 6: documentation

**Where it lives:** `CONTRIBUTING.md`, `AGENTS.md`, the main `README.md`, the `docs/` submap in the relevant package, or SKILL.md files for in-product knowledge.

**Tests:** None, but proofread. Don't commit AI-generated walls of text. Same rule as PR descriptions — write in your own words, keep it short, explain the actual change.

**PR conventions:** Title `docs:` or `docs(<scope>):`. Label `docs`.

---

## General PR guardrails (apply to all types)

From CONTRIBUTING.md, in order of importance:

1. **Issue-First Policy** — every PR must reference an existing issue with `Fixes #N` or `Closes #N`. No exceptions.
2. **Keep PRs small and focused** — one concern per PR. Refactors and fixes should not share a PR.
3. **No AI walls of text** — descriptions short, in your own words.
4. **UI changes need screenshots** — before and after.
5. **Logic changes need verification notes** — what you tested, how a reviewer can reproduce.
6. **Conventional commit title** — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `perf:`, optionally with scope like `feat(opencode):` or `fix(desktop):`.
7. **Style guide in `AGENTS.md`** — prefer `const`, avoid `let`, avoid `else`, avoid `try/catch`, avoid `any`, prefer single-word identifiers, use Bun APIs where they fit.

## What not to do

- Don't rewrite existing tools to match your style. A tool that works and passes tests stays as-is unless you have a bug fix or a clear perf win.
- Don't refactor across package boundaries in a single PR.
- Don't add dependencies without justification — Serac tries to stay dependency-light. If your PR adds a package, explain why in the body.
- Don't commit generated files unless the repo already commits them. Check `.gitignore` if unsure.
- Don't skip `/verify` before opening a PR. It's cheap and catches obvious breakage.
