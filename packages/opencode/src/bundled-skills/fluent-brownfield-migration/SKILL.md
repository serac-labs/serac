---
name: fluent-brownfield-migration
description: This skill should be used when the user asks to "convert this app to fluent", "migrate a scoped app to source control", "modernize this servicenow app", "bring an existing app into git", "transform to fluent", or mentions "brownfield" migration of an existing ServiceNow scoped application to the ServiceNow SDK / Fluent.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac-labs
  version: "1.0.0"
  category: servicenow
tools:
  - snow_fluent_status
  - snow_fluent_explain
  - snow_fluent_init
  - snow_fluent_build
  - snow_fluent_install
  - snow_fluent_transform
  - snow_fluent_download
  - snow_fluent_dependencies
  - snow_query_table
---

# Brownfield Migration: Existing Scoped App → Fluent + Git

Take a scoped app that lives only on an instance and move it into a git-managed ServiceNow SDK (Fluent) project — incrementally, with zero functional change at the start. Based on `@servicenow/sdk` 4.x (`now-sdk` CLI). Run `snow_fluent_status` first to see where a project already stands (scope, SDK pin, keys.ts, XML vs Fluent counts); use `snow_fluent_explain` for offline SDK docs on any topic.

## 1. Step zero: pull the app down as-is

Use `snow_fluent_init` with `from=<sys_app sys_id>` (CLI: `now-sdk init --from <sys_id>`). Since SDK 2.2.6 this does **not** generate Fluent code by default — it leaves every record as XML in the `metadata/` folder. Those XML files are the exact files the instance exports, so there is **no change to the application** at this point. `now.config.json` captures `scope` + `scopeId` (= the sys_app sys_id), and the XML builds and installs as-is.

This means you get value immediately: the app is in git, diffable, and deployable via `snow_fluent_build` + `snow_fluent_install` — before converting a single record to TypeScript. Commit this baseline first.

```text
✅ init --from sys_id → commit metadata/ + now.config.json + keys.ts → build → install to dev → verify
❌ init --from sys_id → immediately transform everything → fight 200 build errors with no known-good baseline
```

## 2. Convert incrementally — never big-bang

Convert table-by-table with `snow_fluent_transform` using the `tables` arg (CLI: `now-sdk transform --table <comma-separated tables>`, table targeting since 4.7.0). After a successful conversion, transformed files are scaffolded into the `generated/` directory and **removed from `metadata/`**.

The loop, per step:

1. `snow_fluent_transform` for ONE table (e.g. `sys_script` for Business Rules).
2. `snow_fluent_build` — immediately, every time.
3. Fix what broke, smoke-read the generated code.
4. Commit. One table family per commit.

Why never big-bang transform the whole app:

- **Flat output.** Transform dumps everything into one flat `generated/` folder and doesn't separate script/HTML content into individual files — a whole-app transform is an unreviewable blob (GitHub discussion #25).
- **Unknown instance fields break builds.** Transform can emit fields missing from the SDK type definitions (e.g. `survey_overwrite` on `sys_app_module`, `sys_report` `active`/`type`), turning into TypeScript errors. One table at a time, these are fixable; all at once, they bury you (#61).
- **Form-layout re-transforms duplicate.** Re-transforming form layouts appends `sys_ui_section` content instead of replacing it, creating duplicates (#41). Small steps make this detectable.

```text
✅ transform tables=sys_script → build → commit → transform tables=sys_script_include → build → commit
❌ transform the entire metadata/ folder in one shot, then try to build
```

## 3. The precedence rule and catching twins

When the same record exists as both a Fluent entity (`.now.ts`) and an XML file in `metadata/`, **the XML version wins on build**. A half-deleted XML twin silently masks your new Fluent code.

- After each transform step, confirm the XML left `metadata/` (`snow_fluent_status` shows XML vs Fluent counts).
- Build with `error_on_conflict` (CLI: `now-sdk build --errorOnConflict`) to make Fluent-vs-XML sys_id conflicts fatal instead of silent. Use this for the whole migration; add `frozen_keys` (`--frozenKeys`) in CI to fail when keys.ts is out of date.

## 4. What converts well vs. what to leave as XML (for now)

**Convert early (mature Fluent APIs):** `Table` (incl. columns), `BusinessRule`, `Acl`, `ClientScript`, `ScriptInclude`, `UiAction`, `Role`, `Property`, `ScheduledScript` (4.5.0+), `RestApi`.

**Convert late or carefully:** Forms — historically broken (`sys_ui_section` handling) until the dedicated `Form` API in SDK 4.6.0; verify your SDK pin is ≥ 4.6 before transforming forms, and watch for the duplication bug on re-transform. Flows exist since 4.3.0 but are still maturing.

**Leave as XML / generic `Record` API:** classic Workflow (`wf_workflow`), reports and Performance Analytics, UI macros, UI scripts, processors, schedules, data sources. These have no first-class Fluent API — XML in `metadata/` round-trips unchanged and ships in the package just fine. Don't force them.

A partially converted app is a perfectly healthy end state. XML and Fluent coexist indefinitely in the same build.

## 5. ES5 vs modern TypeScript — know which layer you're in

The repo-wide "ES5 only" rule applies to script **content that executes on the instance's Rhino engine** — the string/file behind a `script:` property. The Fluent DSL itself is modern TypeScript and must be written as modern TypeScript:

```typescript
// Fluent DSL: modern TS is correct here ✅
import '@servicenow/sdk/global'
import { BusinessRule } from '@servicenow/sdk/core'

BusinessRule({
  $id: Now.ID['validate-request'],
  table: 'x_acme_req_request',
  when: 'before',
  action: ['insert', 'update'],
  // script CONTENT runs on Rhino: keep it ES5 ✅ (var, function, string concat — no const/let/arrow/template literals)
  script: "(function executeRule(current, previous) { var u = current.getValue('requested_for'); if (!u) { current.setAbortAction(true); gs.addErrorMessage('Requested for is required'); } })(current, previous);",
})
```

❌ Rewriting Fluent DSL files to `var`/`function()` style "for ES5 compliance" — wrong layer. ✅ ES5 inside `script:` strings and `src/server/` code destined for Rhino; modern TS everywhere else.

## 6. Staying in sync while others still edit in Studio

Migration takes days or weeks; teammates may keep changing the app on the instance. Before each transform session, pull instance changes into local XML with `snow_fluent_download` using `incremental` (CLI: `now-sdk download <directory> --incremental`), review the git diff, commit, then continue converting. Run `snow_fluent_dependencies` after pulling if new table references appeared (`add_table` + `scope` to bring in tables outside the app; also refreshes type defs).

Declare a cutover date: after it, all changes flow through git + `snow_fluent_install`, and Studio editing of this app stops. Until then, download-before-transform is the discipline that prevents overwriting colleagues' work.

**Install caveats** (`snow_fluent_install`): SDK installs bypass update sets entirely and create **no rollback context**. `reinstall` is the only "rollback" and it's destructive (uninstall + fresh install; side-effect records are not cleaned up). Install from automation only to dev/test instances — production goes through the App Repository, not `now-sdk install`.

## 7. Finishing the migration

- **`keys.ts` is sacred.** `src/fluent/generated/keys.ts` maps `Now.ID['...']` to sys_ids and is regenerated by every build. It MUST be committed — an uncommitted keys.ts means duplicate records on the next install. Enforce with `snow_fluent_build` + `frozen_keys` in CI (fails with "Keys file is out-of-date" if a dev forgot).
- **Repo hygiene:** `.gitignore` already excludes `.now/`, `dist/`, `node_modules/`. Commit `now.config.json`, `metadata/`, `src/`, `keys.ts`, `package.json`.
- **Team switches to Fluent-first:** changes happen in `.now.ts` files, PRs reviewed in git, deploys via install to dev → publish to App Repo for test/prod.
- **Advanced — global apps:** since SDK 4.4.0 (requires an Australia-release instance), `init --from` also converts global scoped apps, and `now-sdk move --ids <sys_ids>` lets a global app claim and customize global metadata. Treat as advanced; scoped apps are the well-trodden path.

## Verification checklist (run after every milestone, and at the end)

1. **Build clean:** `snow_fluent_build` with `error_on_conflict` exits without errors and without XML/Fluent twin warnings. Note: a missing `package.json` prints an ERROR but still exits 0 — check that `dist/` was actually produced.
2. **Install to dev:** `snow_fluent_install` to a dev instance succeeds; use `info` to confirm the last install status on the instance.
3. **Smoke-test on the instance:** exercise the app's main flows (create a record, trigger the key Business Rule, open the main form/list).
4. **Diff record counts:** with `snow_query_table`, count records per migrated table (`sys_script`, `sys_script_include`, `sys_security_acl`, etc., filtered by `sys_scope`) before vs after install — counts must match. Duplicates signal an uncommitted keys.ts or a form-layout re-transform; missing records signal a masked XML twin.
5. **Git state:** working tree clean after build (a dirty keys.ts after a "no-op" build means someone skipped a commit).
