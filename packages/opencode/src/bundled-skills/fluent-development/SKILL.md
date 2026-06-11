---
name: fluent-development
description: This skill should be used when the user asks to "build a fluent app", "create a servicenow app in typescript", or mentions "servicenow sdk", "now-sdk", "fluent", "scoped app as code", or "pro-code development" — or when the working directory contains a now.config.json or *.now.ts files.
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
---

# Fluent (ServiceNow SDK) Development

Fluent is ServiceNow's pro-code model: application **metadata as declarative TypeScript**, with **git as the source of truth** instead of the instance. You edit `.now.ts` files locally, compile them (`build`), and push the compiled package to an instance (`install`). The CLI behind the tools is `now-sdk` from `@servicenow/sdk` (4.x, Node 20+).

## 1. Fluent vs the classic snow_* API tools

| Task | Use |
| --- | --- |
| Build/evolve an app whose definition should live in git | Fluent tools (`snow_fluent_*`) |
| Data operations (query/create/update records) | API tools (`snow_query_table`, ...) |
| ITSM/config changes on an existing non-Fluent instance | API tools (e.g. `snow_create_business_rule`) |
| Metadata types Fluent doesn't cover (see §5) | API tools, or keep as XML in `metadata/` |

Fluent changes the **definition** of an app; the API tools change a **live instance** directly. Don't mix them for the same artifact: editing a Fluent-managed record via the API gets overwritten on the next install.

## 2. Project anatomy

```
now.config.json              # { "scope": "x_acme_myapp", "scopeId": "<sys_app sys_id>", "name": "My App" }
package.json                 # devDeps: @servicenow/sdk, @servicenow/glide
src/fluent/*.now.ts          # the Fluent DSL (entry: index.now.ts)
src/fluent/generated/keys.ts # Now.ID registry -> sys_ids. MUST be committed.
src/server/                  # server-side code referenced from script: properties
metadata/                    # original XML for records not (yet) converted to Fluent
dist/                        # build output (gitignored)
```

- `now.config.json` binds the project to one scope: `scopeId` **is** the `sys_app` sys_id (generated locally for new apps, taken from the instance with init `from=sys_id`). It contains no instance/connection info — auth lives separately.
- `Now.ID['my-key']` gives every record a stable identity; the build regenerates `src/fluent/generated/keys.ts` mapping those keys to sys_ids.
- ❌ Forgetting to commit `keys.ts` → next build elsewhere mints **new sys_ids** → duplicate records on install.
- ✅ Commit `keys.ts` with every change; in CI run build with `frozen_keys` so a stale keys file fails the pipeline ("Keys file is out-of-date...").
- **Precedence:** a record that exists both as a `.now.ts` entity and as XML in `metadata/` uses the **XML version on build**. Delete the XML twin after converting, or pass `error_on_conflict` to make the collision fatal instead of silent.

## 3. The development loop

1. **`snow_fluent_status`** — what project am I in? Scope, SDK pin, keys.ts state, XML-vs-Fluent counts. Run this first in any existing project.
2. **`snow_fluent_explain`** — offline SDK docs (`now-sdk explain`). **Always check the topic for an API before writing its DSL** — property names changed across 4.x and guessing produces compile errors. Use the topic list to discover names; topics include `keys-file`, `ci-integration`, `developing-apps-guide`, and one per API.
3. **`snow_fluent_init`** — scaffold a new app, or convert an existing instance app with `from=<sys_id>` (conversion keeps everything as XML in `metadata/`; nothing changes on the app at the start).
4. Edit `.now.ts` files.
5. **`snow_fluent_build`** — compile. Fix TypeScript errors and re-run until clean (compile errors → exit 1).
6. **`snow_fluent_install`** — deploy to a **dev** instance. Then verify on the instance (e.g. `snow_query_table` against the target table, or `install` with `info=true` to read the last install status).
7. To pick up changes made on the instance: **`snow_fluent_download`** (instance → local XML, supports incremental), then **`snow_fluent_transform`** to convert selected XML to Fluent (supports table targeting and `from=<local file/dir>`). Conversion is opt-in and incremental — migrate record-by-record, leave the rest as XML.
8. When referencing tables outside the app: **`snow_fluent_dependencies`** to sync type definitions, with `add_table` + `scope` to register a specific table.

## 4. Writing Fluent DSL — and the ES5 boundary

**The ES5 rule applies to code that runs on the instance's Rhino engine — i.e. the string inside `script:` — NOT to the Fluent DSL itself.** Fluent files are modern TypeScript compiled locally by the SDK. Do not "ES5-ify" `.now.ts` files; do not put ES6 inside `script:` strings.

```typescript
// src/fluent/business-rules/close-children.now.ts
// (verify exact properties first: snow_fluent_explain topic for BusinessRule)
import '@servicenow/sdk/global'
import { BusinessRule } from '@servicenow/sdk/core'

// ✅ Modern TypeScript here — this never runs on Rhino
export const closeChildren = BusinessRule({
  $id: Now.ID['close-children-br'],
  name: 'Close child incidents',
  table: 'incident',
  when: 'after',
  action: ['update'],
  script: `
    // ❌ const/let/arrow/template-literals — Rhino will reject them
    // ✅ ES5 only inside this string:
    var child = new GlideRecord('incident');
    child.addQuery('parent_incident', current.getUniqueValue());
    child.addQuery('active', true);
    child.query();
    while (child.next()) {
      child.state = current.state;
      child.update();
    }
  `,
})
```

- ❌ `Now.ID` inside a `Record` API's `data` block — it only resolves in `$id` and produces blank references elsewhere.
- ✅ `$id: Now.ID['stable-key']` on every entity; never hand-write sys_ids.

## 5. Coverage limits — what stays API-side or XML

Fluent has dedicated APIs for the common core (tables, business rules, ACLs, client/UI scripts via ClientScript/UiAction/UiPolicy, script includes, roles, properties, scheduled scripts, Scripted REST, Flow Designer, Service Catalog, Service Portal, ATF, AI Agents). **Not first-class**: classic Workflow (`wf_workflow`), UI Builder pages, reports/PA dashboards, UI macros, UI scripts, processors, schedules (`cmn_schedule`), decision tables, data sources.

- ✅ For uncovered types: the generic `Record` API, or `$override` (4.7.0+) to set fields the typed API doesn't expose — or simply leave them as XML in `metadata/` (XML round-trips unchanged through build/install).
- ✅ Columns on tables outside the app: `Table` `augments` (4.6.1+).
- **Global apps** need SDK >= 4.4.0 **and** an Australia-release instance for the instance-side parts (moving global records into the app, transforming updates); on older instances stick to scoped apps. pnpm is not fully supported for global apps.

## 6. Install gotchas (read before deploying)

- **Installs bypass update sets and create no rollback context.** History lands in `sys_upgrade_history` only. Never install straight to production — promote via the App Repository; dev/test instances only.
- **Demo data:** the raw CLI defaults `--demoData` to TRUE; the `snow_fluent_install` tool defaults it to FALSE — pass `demo_data=true` only when the user wants the project's demo data on the instance.
- **`reinstall` is destructive**: uninstall + fresh install (`-r/--reinstall`). It is the only "rollback", and side-effect records (e.g. auto-created M2M rows) are not cleaned up.
- Flows are auto-published on install (SDK 4.5+); pass `skip_flow_activation` to suppress that.
- A build run outside a project ("Could not find package.json") still **exits 0** — check for `dist/` output, not just the exit code.
- "Unable to install application as application was null" usually means the scope prefix doesn't match the instance's `glide.appcreator.company.code`.
- Since 4.4.0 unknown/misspelled properties are **build errors** (previously silently ignored) — another reason to run `snow_fluent_explain` before writing DSL.

## Output format

After an install, report: target instance, scope, install result (from `info`), whether demo data was included, and a reminder that the change is not in an update set and cannot be rolled back except via `reinstall`.
