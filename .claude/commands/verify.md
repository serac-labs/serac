Run the right tests and type checks for your current diff — not the full suite, just what your change actually touched. Cheap pre-PR sanity check.

## Steps

1. **Read the diff** via `git diff --name-only main...HEAD` (or `git status --short` if not on a branch). List the changed files.

2. **Classify the changes by which packages they touch.** A file under `packages/opencode/` means core. Under `packages/app/` means web UI. `packages/desktop/` means Tauri. And so on.

3. **Run the narrowest relevant checks** in this order:

   a. **Type check the affected packages.**
      - `packages/opencode/` → `cd packages/opencode && bun typecheck` (uses `tsgo`)
      - `packages/app/` → `cd packages/app && bun run type-check` (or equivalent)
      - Other packages → `bun turbo typecheck --filter=<package>`
      - Multiple packages → `bun turbo typecheck` from root

   b. **Run unit tests for affected packages.**
      - `packages/opencode/` → `cd packages/opencode && bun test` (or narrower: `bun test path/to/test`)
      - Other packages → `bun turbo test --filter=<package>`
      - **Never** `bun test` from the repo root — it doesn't work. Use `bun turbo test` instead.

   c. **If UI changed (`packages/app/`), run the Playwright E2E tests** only if the user explicitly asks. They're slow and flaky under CI — not every PR needs them locally.

   d. **If ServiceNow tool files changed**, also run the unified server smoke check: `bun dev serve` (then kill it after it prints the "listening on :4096" line). This confirms the tool auto-discovery still loads.

4. **Report to user.** For each check, a single line: `✓` or `✗`. If anything failed, include the exact error output (not a summary — the raw error). Do not try to fix the errors automatically; just report.

## Safety gates

- **Don't run the full test suite** unless the diff touches many packages or the user explicitly asks. The whole point of this command is to be cheap.
- **Don't commit anything**, don't stage anything, don't run any mutating git commands.
- **Don't auto-fix type errors** by editing files. Report them and stop.
- **Don't run Playwright E2E** unless the user asked. They're slow and they might need a local server running.

## Cross-references

- `CONTRIBUTING.md` — general "Developing Serac" section has the full command reference
- `.claude/playbook.md` — per contribution type, which tests matter most

## Output format

```
Verify on feat/your-branch — 4 files changed

Type check:
  ✓ packages/opencode (tsgo, 3.2s)

Tests:
  ✓ packages/opencode (bun test, 1 test, 0.4s)

Smoke:
  ✓ bun dev serve starts without errors

Result: all checks passed. Ready for /open-pr.
```

If failures:

```
Verify on feat/your-branch — 2 files changed

Type check:
  ✗ packages/opencode

  src/foo.ts:42:14 — Type 'undefined' is not assignable to type 'string'.

Result: type check failed. Fix the error above and rerun /verify.
```
