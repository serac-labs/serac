---
name: blast-radius
description: Trace ServiceNow configuration dependencies — what artifacts touch a given field, what calls a script include, table/app-level config inventory. Use before deletes, renames, or refactors.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "2.0.0"
  category: servicenow
tools:
  - snow_blast_radius_apps
  - snow_blast_radius_table_configs
  - snow_blast_radius_artifact_dependencies
  - snow_blast_radius_field_references
  - snow_blast_radius_dependents
  - snow_code_search
---

# Blast Radius for ServiceNow

Blast Radius provides configuration dependency analysis across a ServiceNow instance. Before making changes to fields, tables, or artifacts, use these tools to understand the full blast radius.

## Tool Overview

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `snow_blast_radius_apps` | List apps with config counts | Starting point — understand the instance landscape |
| `snow_blast_radius_table_configs` | All configs on a table | "What runs on the incident table?" |
| `snow_blast_radius_field_references` | Reverse field lookup | "What touches incident.assignment_group?" |
| `snow_blast_radius_artifact_dependencies` | Forward dependency analysis | "What does this business rule read/write?" |
| `snow_blast_radius_dependents` | Find what uses / calls an artifact (deep 3-phase scan, 100+ tables) | "What calls IncidentUtils?" / "Can I safely delete this business rule?" |
| `snow_code_search` | Substring search across every script-bearing table (business rules, script includes, client scripts, widgets, scripted REST ops, UI actions, ACLs, notifications, UX scripts, …) | "Where is `IncidentUtils.resolve` referenced anywhere?" — use when reverse-dependency tools don't index what you need |

## Coverage

`snow_blast_radius_field_references` and `snow_blast_radius_table_configs` scan the following artifact types in parallel. Types backed by plugins that are not activated on the instance fail silently — the tool reports them under `errors_by_type` and continues.

**Table-scoped (queried with the table name as filter):**
- Business rules (`sys_script`) — script + condition + filter_condition + role_conditions
- Client scripts (`sys_script_client`)
- UI actions (`sys_ui_action`) — script + condition
- UI policies (`sys_ui_policy`) — script_true + script_false + conditions
- UI policy actions (`sys_ui_policy_action`) — exact field match
- Data policies (`sys_data_policy2`)
- Data policy rules (`sys_data_policy_rule`) — exact table_field match
- ACLs (`sys_security_acl`) — field-level name match always included, table-level only when script/condition references the field
- Email notifications (`sysevent_email_action`) — subject + message_html + message_text + condition + advanced_condition
- Metric definitions (`metric_definition`) — script + exact field match
- Inbound email actions (`sysevent_in_email_action`) — script + condition
- Transform entries (`sys_transform_entry`) — target_field / source_field
- Dictionary `dependent` / `dependent_on_field` — UI-level field dependencies

**Global (no table column — grep all records, filter client-side by script content mentioning the table name):**
- Script includes (`sys_script_include`)
- Scheduled jobs (`sysauto_script`)
- Fix scripts (`sys_script_fix`)
- Script actions (`sysevent_script_action`)
- Transform scripts (`sys_transform_script`)
- Processors (`sys_processor`)
- UI scripts (`sys_ui_script`)
- Scripted REST resources (`sys_ws_operation`) — operation_script
- Email scripts (`sys_script_email`)
- Service Portal widgets (`sp_widget`) — server script + client script + link
- Catalog client scripts (`catalog_script_client`)
- Catalog UI policies (`catalog_ui_policy`)
- ATF step inputs (`sys_atf_step`)

**Table hierarchy:** By default the tools walk `sys_db_object.super_class` up to three levels, so a query on `incident` also returns artifacts scoped to `task`. Disable via `include_parent_tables: false`.

## When results are truncated

`snow_blast_radius_field_references` returns a `truncated_types` array naming artifact types where the sysparm_limit was hit. Global-scope types (script_includes, scheduled_jobs, widgets, ATF steps) are the usual suspects — they have no table column, so the pre-filter matches any script mentioning the field name anywhere.

**What to do when `truncated_types` is non-empty:**

1. Re-run `snow_blast_radius_field_references` with a higher `limit_per_type` (e.g. 100) — often enough for medium-size instances.
2. If still truncated, switch to `snow_code_search` for the affected tables with a tighter pattern. Example for `incident.priority` references in script includes:
   ```
   snow_code_search({
     query: "current.priority",
     tables: ["sys_script_include"],
     per_table_limit: 100,
   })
   ```
   Repeat with `"'priority'"` and `'"priority"'` to catch `setValue('priority')` / `"priority"` patterns. Results are unclassified (no read/write split) but complete.
3. Intersect the `snow_code_search` hits with the script-analyzer output by running `snow_blast_radius_artifact_dependencies` on each individual script include for accurate read/write classification.

Treat `truncated_types` as a signal that blast-radius's structured answer is incomplete, not as a safe zero.

## Known Limitations

These gaps are inherent to static regex-based analysis over the REST Table API:

- **Reference dotwalks**: `current.assignment_group.manager` is parsed as a reference to `assignment_group`, not to `sys_user_group.manager`. Dotwalked field changes are not flagged transitively.
- **Dynamic field access**: `gr.setValue(someVar, value)` cannot be resolved because `someVar` is computed at runtime.
- **Dynamic table access**: `new GlideRecord(tableVar)` — global artifacts won't be matched unless the table name appears literally in the script.
- **Legacy workflows** (`wf_workflow`, `wf_activity`) are not scanned — migrating to Flow Designer is recommended anyway.
- **Reports/dashboards** filter conditions are not scanned.
- **Service Portal option schemas / angular providers** beyond `sp_widget` are not scanned.
- **Field-level ACLs without scripts** that also don't match the `name=<table>.<field>` exact pattern (e.g., using a regex-like ACL naming) may be missed.
- **`include_parent_tables`** adds at most three `sys_db_object` lookups; deeper hierarchies (incident_task → task → incident) are capped at depth 3.

If the tool reports "0 references", treat it as "no *static* references found in the artifact types we scan" — not as a proof of safety. For high-risk changes (renaming a widely-used field), combine with grep of the export XML, and consider running a sandboxed test after the change.

## Recommended Workflow

### 1. Instance Overview
Start with `snow_blast_radius_apps` to see which applications have the most configurations:

```
→ snow_blast_radius_apps(include_config_counts: true)
```

### 2. Table Deep-Dive
Pick a table and see everything running on it:

```
→ snow_blast_radius_table_configs(table_name: "incident")
```

### 3. Field Impact Check
Before changing a field, find every artifact that touches it:

```
→ snow_blast_radius_field_references(table_name: "incident", field_name: "assignment_group")
```

### 4. Artifact Analysis
Analyze what a specific artifact depends on:

```
→ snow_blast_radius_artifact_dependencies(artifact_type: "business_rule", artifact_sys_id: "abc123")
```

Returns fields read/written, tables queried, script includes called, and a complexity rating.

### 5. Reverse Dependencies
Find what depends on a specific artifact (e.g., a script include):

```
→ snow_blast_radius_dependents(artifact_type: "script_include", artifact_identifier: "IncidentUtils")
```

## Common Questions and Which Tool to Use

| Question | Tool |
|----------|------|
| "What apps are in this instance?" | `snow_blast_radius_apps` |
| "What business rules run on incident?" | `snow_blast_radius_table_configs` |
| "What touches the state field on change_request?" | `snow_blast_radius_field_references` |
| "What does this business rule do?" | `snow_blast_radius_artifact_dependencies` |
| "What uses the TaskUtils script include?" | `snow_blast_radius_dependents` |
| "Is it safe to remove this field?" | `snow_blast_radius_field_references` |
| "How complex is this business rule?" | `snow_blast_radius_artifact_dependencies` |
| "What's the blast radius of changing this script include?" | `snow_blast_radius_dependents` |

## Script Analysis Patterns

The script analyzer detects these patterns in ServiceNow scripts:

**Field reads**: `current.field`, `gr.getValue('field')`, `g_form.getValue('field')`, `.addQuery('field')`, `.orderBy('field')`

**Field writes**: `current.field = value`, `gr.setValue('field', value)`, `g_form.setValue('field', value)`

**Table queries**: `new GlideRecord('table')`, `new GlideAggregate('table')`

**Script include calls**: `new ClassName()` (excludes Glide built-in classes)

## What blast-radius does NOT cover — and how to communicate it

Every `snow_blast_radius_dependents` result includes two fields the user must understand before acting on the data:

- `scope_caveat` — a single sentence stating that the scan covers script-bearing fields, not the entire instance.
- `out_of_scope_surfaces` — a list of areas that were NOT searched. Common items: row data inside records, saved filters (`sys_filter`) and reports (`sys_report`), pending update sets (`sys_update_xml`), external consumers (MID server, Integration Hub, REST callers), plain-string properties (`sys_property`), inactive records, and inactive plugins.

**You MUST relay these to the user whenever:**

1. The result has zero dependents AND the user is considering deletion — the absence of dependents in script-bearing fields is NOT the same as "safe to delete". Cite `out_of_scope_surfaces` and recommend manual verification of those surfaces.
2. The user explicitly asks "is it safe to delete X" or "can I remove X" — always include the caveat. Even with 50 dependents, the picture may be incomplete.
3. The user is preparing a refactor that renames or removes an artifact. Mention which out-of-scope surfaces are most likely to break and how to check them (e.g. for a field rename, also run an encoded-query check against `sys_filter`).

**Do not bury the caveat.** A one-liner ("Note: this scan does not cover ...") is enough — but it must be visible to the user, not just to you.

## Companion tools — RUN ALL OF THESE for delete / rename decisions

When the user asks any of:
- "is it safe to delete X" / "kan ik X verwijderen"
- "what breaks if I rename X" / "wat breekt als ik X hernoem"
- "can I refactor / remove / drop X"
- "blast radius of changing X"

…do NOT stop at `snow_blast_radius_dependents`. The dependents scan only covers script-bearing fields; three other surfaces silently hold references that gs.getProperty(), saved filters, and pending update sets pull in at runtime. Missing one of them is the difference between a clean refactor and a Monday-morning production incident.

**You MUST run the full set in parallel** (single response, multiple tool calls). Do not serialize. Do not skip a tool because "the user didn't ask for it" — "is this safe" already implies all of them.

### Script include / business rule / widget / scheduled job / processor

```
snow_blast_radius_dependents(artifact_type, artifact_identifier)
snow_blast_radius_update_sets(artifact_identifier)
snow_blast_radius_sys_properties(artifact_identifier)
```

### Field deletion or rename

```
snow_blast_radius_field_references(table_name, field_name, include_filters: true)
snow_blast_radius_update_sets(field_name)
snow_blast_radius_sys_properties(field_name)
```

### Table deletion

```
snow_blast_radius_dependents(artifact_type: "table", artifact_identifier: <table>)
snow_blast_radius_update_sets(<table>)
snow_blast_radius_sys_properties(<table>)
```
…and if the user is also dropping or renaming columns, add one `snow_blast_radius_field_references` per column.

### Synthesizing the answer

After the tools return, present ONE unified picture to the user. Lead with the totals across surfaces ("33 references across scripts, 2 in update sets, 4 in system properties"), call out cross-scope hits, and end with the out-of-scope surfaces that even the full sweep does NOT cover (row data, external consumers — see `out_of_scope_surfaces` on the dependents result). The user shouldn't have to mentally aggregate four tool outputs themselves.

If any of the companion tools returns hits in `in_progress` update sets, in plugin-category sys_properties, or with cross-scope dependents — treat that as a hard "do not delete without addressing these first" and say so in plain language, not buried in a bullet list.
