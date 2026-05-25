First-time bootstrap for contributing to Serac. Run this once after cloning. It verifies prerequisites, installs dependencies, does a smoke check, and orients you in the monorepo.

## Steps

1. **Verify prerequisites** — run and report:
   - `bun --version` (must be 1.3+, reject otherwise with a clear message pointing to https://bun.sh)
   - `node --version` (informational, not blocking)
   - `gh --version` and `gh auth status` (informational for `/pick-issue`, `/suggest-contribution`, and `/open-pr` — warn if not authenticated)
   - `git branch --show-current` — if not on `main`, tell the user that Serac's default branch is `main` and suggest `git checkout main`

2. **Install dependencies.** From the repo root: `bun install`. Stream the output. If it fails: do not proceed, surface the error as-is.

3. **Smoke check.** Run `bun dev --help` from the repo root to confirm the CLI loads. If it prints the help output, you're good. If it crashes, report the error and stop.

4. **Orient the user.** Read `.claude/README.md` and `.claude/playbook.md`, then tell the user:
   - Which packages exist under `packages/` (one-line each)
   - The default branch (`main`) and the conventional commit prefixes they'll need for PR titles
   - The two golden rules: Issue-First Policy and "no AI walls of text"
   - The three or four slash commands they're most likely to use next (`/pick-issue`, `/suggest-contribution`, `/verify`, `/open-pr`)

5. **Report done.** One short paragraph: what you verified, what's installed, what to do next. If there's a `help wanted` or `good first issue` label on GitHub (check via `gh issue list --label "good first issue" --state open --limit 3`), mention the three most recent as an entry point — but don't pick one for the user.

## Safety gates

- Do not run `/pick-issue`, `/open-pr`, or any mutating command as part of setup.
- Do not modify files in the working tree. This is strictly read + install.
- If `bun install` fails, stop and report. Don't try to "fix" the install error by running random commands — the user needs to see the real error.

## Output format

```
Setup 2026-04-09 10:14

✓ Bun 1.3.2
✓ gh authenticated as <username>
✓ On branch main
✓ bun install (2,341 packages, 14.8s)
✓ bun dev --help runs

Packages under packages/: app, console, desktop, docs, enterprise, extensions,
function, identity, mobile, opencode, plugin, script, sdk, slack, ui, util, web.
Core code lives in packages/opencode/.

Default branch: main. PR titles use conventional commits (feat:, fix:, docs:, etc).

Golden rules (from CONTRIBUTING.md):
- Issue-First: every PR must link an existing issue
- No AI walls of text in PR descriptions or issue bodies

Most useful next commands: /suggest-contribution, /pick-issue <number>, /verify, /open-pr.

Recent good-first-issues: #1234, #1211, #1198.
```
