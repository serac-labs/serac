---
name: change-rollback
description: Undo a change already written to a ServiceNow instance — recover the prior payload from sys_update_version, write it back without corrupting it, and know which damage update set back-out, Deleted Records, or nothing at all can reverse.
tools:
  - snow_query_table
  - snow_artifact_manage (action='update')
  - snow_pull_artifact
  - snow_update_set_manage (action='preview')
  - snow_ensure_active_update_set
  - snow_inspect_mutations
  - snow_execute_script
---

# Undoing a Change on a ServiceNow Instance

You overwrote a Business Rule script, or a widget's server script, or a Script Include, and the new version is wrong. **Do not reconstruct the old code from memory.** The instance already kept a copy of the record as it was before you touched it, in the `sys_update_version` table. Recovering it is a read, a copy, and a write — no guessing.

The rest of this guide is about getting that read right, and about the three or four cases where no read will save you.

## Which mechanism undoes what

| Mechanism | Undoes | Driven from |
| --- | --- | --- |
| Version records (`sys_update_version`) | One configuration record, field by field | This MCP (read the payload, write the field back), or the UI's *Revert to this version* |
| Back out an update set | Every change captured in one committed update set, including dictionary changes | ServiceNow UI only — there is no tool for it here |
| Deleted Records (`System Definition > Deleted Records`) | One deleted record plus its cascaded deletes, on audited tables | ServiceNow UI only |
| Nothing | Emails already sent, flows already run, data destroyed by a dropped column | — |

Pick the smallest one that covers the damage. Reverting one field of one record is safe and boring. Backing out an update set touches everything in it.

## Step 0: delete nothing

Two instincts are wrong and both are expensive.

**Deleting the update set does not undo anything.** `sys_update_set` is a container; the changes themselves are rows in `sp_widget`, `sys_script`, `sys_script_include` and friends, and the record of each change is a `sys_update_xml` row pointing at the set. Deleting the set record leaves every changed artifact exactly as it is, and destroys the only inventory of what changed — the inventory a real back-out needs. You are strictly worse off than before.

**Deleting the artifact is not a rollback either.** If the record existed before your change, deleting it turns a bad script into a missing script, plus every reference to its sys_id now dangles.

Setting an update set to state `ignore` is also not an undo: it stops the set from being promoted, and changes nothing on the instance it was built on.

## Step 1: establish exactly what you changed

Before restoring anything, get the list. Two independent sources:

```javascript
// Configuration writes captured while your update set was current.
// Reads sys_update_xml and returns the rows grouped by type:
// name, target, action, updated_at, updated_by.
snow_update_set_manage({ action: "preview", update_set_id: "<sys_id>" })

// Table API writes in a time window, from sys_audit.
snow_inspect_mutations({ since: "30m", tables: ["sp_widget", "sys_script"] })
```

`snow_update_set_manage action="preview"` is the more trustworthy of the two for configuration: it reads what the platform recorded, one row per changed record. Pass `include_payload: true` only when you intend to read a payload — the rows are large. It reads at most 1000 `sys_update_xml` rows and tells you nothing when there are more, so on a big set treat the list as a floor rather than an inventory.

`snow_inspect_mutations` reads `sys_audit`, which stores truncated values (the tool warns you when a value hits the 255-character mark). **An audit row is a diagnostic, never a restore source.** Reconstructing a script from `oldvalue` gives you the first 255 characters of it and no warning that the rest is missing. That is the mistake this guide exists to prevent.

Flow Designer mutations are not recorded in `sys_audit`, so `snow_inspect_mutations` will not show them — see the `debugging-mutations` guide for the verification path that does work.

## Step 2: find the version records

> The Update Versions `[sys_update_version]` table contains records that represent the state of a customizable object at a particular time.
>
> A new version record is created automatically whenever a user changes a customizable record or changes the application file for the customizable record.
>
> — ServiceNow product documentation, *Version records*

That includes changes made through the Table API by this server's service account, and the platform does it without being asked. The row your write created holds the state *after* it and is now `Current`; the state you destroyed is in the row that was `Current` a moment earlier and has been demoted to `Previous`. Nothing was lost — you just have to pick the right row.

Version rows are keyed by **update name**, which for most records is `<table>_<sys_id>`. Query on the sys_id and let `LIKE` handle the prefix:

```javascript
// 1. List the candidates WITHOUT payloads. Cheap, readable.
snow_query_table({
  table: "sys_update_version",
  query: "nameLIKE<record_sys_id>^ORDERBYDESCsys_created_on",
  fields: ["name", "state", "source", "sys_created_on", "sys_created_by"],
  limit: 10,
})
```

If that returns nothing, the record's updates are not keyed by its sys_id. Open the record in the ServiceNow UI and use its **Versions** related list instead (right-click a version for *Compare to Current* and *Revert to this version*).

### Choosing the right row

- The newest row is the state you just wrote. `state` is `Current`.
- The row below it is the state before your last write — **not** necessarily the state before your session. If you saved three times, you want the fourth row down.
- `state` shows `Current`, `Previous` or `History`. `History` means the version was **never loaded on this instance**. Restoring a `History` payload is not a rollback; it is installing something that never ran here. Read the column rather than filtering on it — the label you see and the value stored in the column are not guaranteed to be the same string.
- `source` says how the version arrived, and has three documented values: `System Upgrade` (the baseline version an upgrade shipped), `Update Set` (created or committed on this instance), `Pull History` (a Team Development pull). It does not tell you *whose* change it was — yours and a colleague's both land as `Update Set`. That is what `sys_created_by` is for, which the query above already selects.
- `sys_created_on` has one-second resolution. Two writes in the same second sort arbitrarily. Confirm with `sys_created_by` and the payload itself before you trust the order.

## Step 3: read the payload, and read it whole

```javascript
// 2. Fetch exactly one payload, untruncated.
snow_query_table({
  table: "sys_update_version",
  query: "sys_id=<version_sys_id>",
  fields: ["payload"],
  truncate_output: false,
})
```

**`truncate_output` defaults to `true`, and `payload` is on this tool's large-content list.** Without `truncate_output: false` you get the first 200 characters followed by `... [truncated, 41216 chars total]`. That stub looks like data. An agent that pastes it into a restore has just replaced a 41k script with a 200-character fragment, and every tool in the chain will report success.

The payload is ServiceNow's update XML:

```xml
<record_update table="sys_script_include">
  <sys_script_include action="INSERT_OR_UPDATE">
    <access>public</access>
    <active>true</active>
    <api_name>global.IncidentUtils</api_name>
    <name>IncidentUtils</name>
    <script><![CDATA[var IncidentUtils = Class.create();
IncidentUtils.prototype = {
    initialize: function() {},
    type: 'IncidentUtils'
};]]></script>
    <sys_id>7f3c9b2a4f8a1200a1b2c3d4e5f6a7b8</sys_id>
    <sys_mod_count>12</sys_mod_count>
    <sys_updated_on>2026-08-14 09:41:22</sys_updated_on>
  </sys_script_include>
</record_update>
```

Three rules for handling it:

1. **Take only the field you broke.** One element, usually `script` / `template` / `client_script` / `css`.
2. **Unwrap it.** Script and other long fields are wrapped in `<![CDATA[ ... ]]>` — strip the wrapper, keep the content verbatim including leading whitespace. Shorter values are XML-escaped instead; decode `&lt;` `&gt;` `&amp;` `&quot;` `&#39;` before writing them back. Writing `&lt;` into a script field ships a broken script that compiles as garbage.
3. **Never turn the whole payload into a field map and write that.** It carries `sys_id`, `sys_mod_count`, `sys_created_on`, `sys_updated_by` — none of which you want in an update body.

## Step 4: write the field back

You will hit two guards before the write lands, and both are working as intended:

- No active update set: `"snow_artifact_manage" is a configuration write but no update set is active for this session…`. Call `snow_ensure_active_update_set({ name: "Fix: revert IncidentUtils to pre-<date> version" })` once, then retry.
- Production instance: `…is a write against a PRODUCTION ServiceNow instance and is blocked by default.` Show the user the exact restore you intend to make, and only after they approve, re-issue the identical call with `"__confirmProd": true`.

```javascript
snow_artifact_manage({
  action: "update",
  type: "script_include",
  sys_id: "<record_sys_id>",
  script: "<decoded contents of the payload's script element, verbatim>",
})
```

Two traps in this tool's update path:

**Only a fixed set of keys is read inline:** `script`, `template`, `server_script`, `client_script`, `css`, `option_schema`, `description`, `active`. Anything else you need to restore — `condition`, `when`, `order`, `filter_condition`, `collection`, `role_conditions` — is ignored unless you put it in `config`:

```javascript
snow_artifact_manage({
  action: "update",
  type: "business_rule",
  sys_id: "<sys_id>",
  config: { script: "<restored script>", condition: "current.state == 6" },
})
```

**For a Service Portal widget, restore `script`, not `server_script`.** On `action: "create"` the tool maps `server_script` onto the widget's `script` column. On `action: "update"` it does not: `server_script` goes into the PATCH body under that name, `sp_widget` has no such column, and you get back `updated: true` with `updated_fields: ["server_script"]` while the widget's server script is untouched. The widget's body columns are `template`, `script`, `client_script`, `css`, `option_schema`.

### Verify, do not trust the success object

```javascript
snow_query_table({
  table: "sp_widget",
  query: "sys_id=<sys_id>",
  fields: ["script"],
  truncate_output: false,
})
```

Compare the first and last lines against the payload you extracted. Character counts can differ legitimately: the update path runs every string through a sanitiser first, which folds CRLF and lone CR to LF and strips C0/C1 control characters and zero-width characters. A payload with Windows line endings comes back shorter by one byte per line and is still a correct restore. A payload that comes back with *different lines* is not.

If you pulled the artifact to disk before editing (stdio only), `snow_artifact_manage({ action: "verify", ... })` does the comparison for you and reports the first differing line — but pass the files explicitly as `script_file` / `template_file`. `artifact_directory` looks for `server.js` and `template.html`, while `snow_pull_artifact` writes `<name>.server.js` and `<name>.html`, so pointing verify at a pulled widget directory resolves nothing and errors out. Verify also trims both sides before comparing, so a difference in leading or trailing whitespace is reported as a match.

Your restore is itself a tracked change: it creates a new version row and lands in the currently active update set. That is correct and desirable — if the bad change was already promoted, the target instance needs the same undo, and now it can be shipped the same way.

### When the Table API will not take the field

A few reference fields are silently dropped by the Table API (`sys_ui_policy_action.ui_policy` is the known one) — the write returns 200 and the field is unchanged. For those, `snow_execute_script` runs real ES5 server-side and a `GlideRecord` write goes through. Use it only after a plain update has demonstrably failed, and keep the script ES5.

### The UI's own revert

For anything you would rather not reassemble by hand, the platform does it: open the record's **Versions** related list, right-click the version, **Revert to this version**, confirm. The current version becomes a previous version and a new version duplicating the selected one is created. Documented limitation: you can revert to the most recent baseline version, but not to an older baseline version. There is no REST endpoint for this action and no tool here wraps it — when the record is a flow, hand the user this path rather than writing `sys_hub_*` rows yourself.

## Do not use snow_rollback_deployment

It reads like the tool for this job. It is not: every way it fails is silent, and you find out when someone runs the code.

- **`action: "revert"` can corrupt the record and report success.** It parses the version payload with `/<(\w+)>([^<]*)<\/\1>/g`. That pattern cannot cross a `<`, so a CDATA-wrapped field (`<script><![CDATA[…`) never matches at all and is silently dropped from the update — you PUT a record with the broken script still on it. If the payload escapes the value as entities instead, the match succeeds and the entities come back undecoded, so you write `&lt;` into a script field. Which of the two you get depends on how that payload encoded that field; both are corruption and neither is reported. It then PUTs the flat result, the record's own `sys_id` and `sys_mod_count` included, and returns `action: "reverted"` either way.
- **It picks the version blindly.** It queries `name=<table>_<sys_id>` exactly, takes the second row ordered by `sys_created_on` descending, and checks neither `state` nor who wrote it. When the update name is not built from the sys_id, the query matches nothing and you get "No previous version found to revert to" for a record that has a dozen versions.
- **`action: "delete"` is a hard Table API delete** of the record you named, with no dependency check and no soft-delete option.
- **`update_set_id` issues a DELETE on `/api/now/table/sys_update_set/<id>`.** It destroys the container record without backing out a single change (see Step 0), and if the delete fails the tool reports `update_set_rollback_failed` alongside an otherwise successful-looking result.
- **The four-value `table` enum is advice, not validation.** Nothing on the server checks arguments against a tool's `inputSchema`; whatever string you pass goes into the URL path.
- Passing `reason` also POSTs a synthetic row into `sys_audit`, so the audit trail you later read with `snow_inspect_mutations` contains an entry the platform did not write.

Use Step 2 through Step 4 instead. They are three calls.

## `create_backup: true` is not a backup

`snow_artifact_manage` accepts `create_backup` on updates. It POSTs to `sys_update_xml_backup`, a table with no ServiceNow documentation behind it. If the POST fails — because the table is missing, or the service account cannot write it — the failure is swallowed into a `warnings` entry, `backup_id` comes back `null`, and the update proceeds. The result object still says `updated: true`. Do not plan a rollback around it.

Similarly, `snow_update_set_manage({ action: "add_artifact" })` creates a `sys_update_xml` row whose payload is the literal comment `<!-- Artifact tracked: … -->`. The update set will *list* the artifact. It does not carry it, so it cannot restore or deploy it.

What an actual pre-change snapshot looks like:

- `snow_pull_artifact({ sys_id, table })` — returns a fixed per-table set of body fields as a `{filename: content}` map, and on stdio also writes them to disk. The set is hard-coded, not "whatever the record has": `sp_widget` gives you `template`, `script`, `client_script`, `css` and `option_schema`; `sys_script_include` gives you `script`; `sys_ux_page` gives you `html` and `client_script`. Everything else on the record — including a widget's `link` and demo data if it has them — is not in the map, so treat this as a snapshot of the body and nothing more. The tool also accepts `sys_hub_flow`, but there it only dumps the single `sys_hub_flow` record as JSON, which is a descriptor and not a restorable flow (see the last section).
- For anything else, `snow_query_table` with `truncate_output: false` on the fields you are about to change, and keep the text.
- And in the general case: you do not need one. The platform makes the version row for you. That is the whole point of Step 2.

## When the undo is bigger than one record

If a committed update set introduced the problem, back the set out rather than reverting twenty records by hand. This is a UI operation: **All > System Update Sets > Local Update Sets**, open the set, back it out. It applies to any committed update set, creates delete updates in the current update set, and reverses both record-level updates and dictionary changes.

The documentation's warnings, all of which matter:

- **Never back out the Default update set.** It can damage the instance configuration.
- Some changes caused by a back-out result in data loss.
- Backing out a set that belongs to an update set batch may affect other sets in the batch.
- If you commit, back out, and then reapply a remote update set, the previewer reports collisions, because the delete updates count as the more recent change.

What you get back, by change type: new tables and fields are dropped and their data deleted; deleted fields are restored but their original data is not; resized fields are reversed and data may be truncated; inserted records are deleted; deleted records are restored with their original data.

Because there is no documented REST entry point for back-out, no tool here performs it. Give the user the navigation path and the warnings above.

## What update sets never held in the first place

Update sets capture *tracked objects*: when one is customized, the platform adds or updates a row for it in `sys_update_xml`. When an untracked one changes, nothing is written and there is nothing to back out. The platform decides which objects are tracked; the common shorthand is "records extending `sys_metadata`, plus tables flagged with the `update_synch` dictionary attribute", but that rule is not stated on a current ServiceNow documentation page, so confirm against your own instance rather than betting a rollback on it. Either way, do not try to widen the net by flagging a data table — moving data between instances is an import set or an XML export, not an update set.

Not captured, and therefore not recoverable by any update set operation: incidents, changes, requests, CIs, users, groups, and every other process record; attachments; and the results of anything you ran, such as ordered catalog items.

## What genuinely cannot be undone

- **Side effects that already fired.** Restoring a Business Rule does not un-send the notifications it triggered, un-call the outbound REST messages, un-start the flows, or delete the approval records it generated. Roll back the code, then clean up the records it produced as a separate, deliberate task.
- **Data destroyed by a schema change.** Dropping a column and restoring the dictionary entry gives you the column back, empty. There is no version record for row data.
- **Process data mangled by a bad rule.** Not in update sets, not in `sys_update_version`. If the table is audited you have `sys_audit`, with truncated values; if it is not, the previous values are gone.
- **Deleted records on unaudited tables.** `System Definition > Deleted Records` restores from audited tables only — *Undelete Record* for one record, *Undelete With Related* for the record plus its cascaded deletes. One record at a time. Deletions are not tracked on tables carrying the `no_audit_delete=true` dictionary attribute, and references using an Image field are not restored. Retention is finite, so check whether the row is still listed before promising anyone a restore.
- **Flows rebuilt through the Table API.** A flow's definition spans several `sys_hub_*` tables; writing one row back produces a flow that looks restored and is not. Use Flow Designer's own version history.

## Checklist

1. Delete nothing.
2. List what changed: `snow_update_set_manage action="preview"`, plus `snow_inspect_mutations` for a time window.
3. Find versions: `snow_query_table` on `sys_update_version`, `nameLIKE<sys_id>`, ordered by `sys_created_on` descending, no payload yet.
4. Pick the row that predates *your session*, not just your last save. Check `state`, `source` and `sys_created_by`.
5. Fetch that one payload with `truncate_output: false`.
6. Extract the one field, unwrap CDATA or decode entities, change nothing else.
7. Ensure a named update set, get prod approval if it is prod, write the field back with `snow_artifact_manage action="update"` — `config` for anything outside the inline key list, `script` not `server_script` for widgets.
8. Read the record back and compare. `updated: true` proves nothing.
9. If the damage spans a whole update set, hand the user the UI back-out path and its warnings instead.
