---
name: inbound-email
description: Handle email arriving at a ServiceNow instance — inbound email action ordering and stop-processing, the real sysevent_in_email_action column names, and reading sys_email when a message created no record.
tools:
  - snow_inbound_email_action (action='list')
  - snow_record_manage (action='create')
  - snow_query_table
  - snow_get_email_logs
  - snow_discover_table_fields
  - snow_ensure_active_update_set
  - snow_execute_script
---

# Inbound Email for ServiceNow

This guide is about mail arriving **at** the instance: a message lands, the platform classifies it,
and an inbound email flow or action turns it into a record. Mail leaving the instance —
notifications, templates, mail scripts, weights — is a different subject; see `email-notifications`.

Three things account for most of the time lost here:

1. Inbound email **flows** run before inbound email **actions** and can end processing entirely.
   Debugging the action list on an instance that uses flows is looking at the wrong layer.
2. Inbound actions run in `order`, and `stop_processing` on a matching action suppresses the actions
   that come **after** it. People consistently read that arrow backwards.
3. Several `snow_inbound_email_action` arguments do not write the column their name suggests. The
   column does not exist, so the value never persists, and the tool's `create` response reports only
   `sys_id`, `name` and `type` — nothing in it tells you a field went missing.

Three tables carry all of it: `sys_email` (every message, inbound and outbound, one row each),
`sysevent_in_email_action` (the inbound email actions — condition plus script, evaluated against
received mail) and `sys_email_account` (the mailbox the instance polls over POP3/IMAP or sends
through over SMTP).

## What happens when a message arrives

1. The instance polls the account in `sys_email_account` and inserts a row in `sys_email` with
   `type=received`. Inbound mail sits in the Received mailbox until it is processed.
2. The platform classifies it as **forward**, **reply** or **new**, stored in `sys_email.receive_type`.
3. **Inbound email flows run first.** ServiceNow: "Inbound email flows take priority over inbound
   email actions. If you create flows with inbound email triggers, emails are first processed by the
   inbound email triggers before they are processed by inbound email actions." If a flow issues stop
   processing, the email is finished; only an email matching no flow falls through to actions.
   (<https://www.servicenow.com/docs/r/platform-administration/processing-inbound-emails.html>)
4. The instance walks the active inbound email actions in `order`, lowest first.
5. An action runs when `sys_email.receive_type` matches the action's `type` and its condition matches.
6. If a matching action has `stop_processing=true`, the actions **after** it never run — provided
   orders are unique, see below.
7. The `sys_email` row's `state` moves off Ready. Nothing is retried: if nothing matched, the message
   is consumed and no record is created, with no error anywhere. That is why this is hard to debug.

## Classification: new, reply, forward

- **Forward** — a forward prefix such as `FW:` in the subject **and** a forward string such as `From:`
  in the body. Both must hold, and forward wins even over a watermark.
- **Reply** — not a forward, plus any one of: a recognised watermark; a reply prefix such as `RE:` with
  a record number the instance recognises; (Outlook only) a matching thread-index header.
- **New** — everything else.

A client that strips the `Ref:MSG…` watermark and rewrites the subject turns a reply into a **new**
message: the Reply action never fires and a duplicate incident appears instead of a comment on the
original. When someone reports "replies open new tickets", read `receive_type` on the actual
`sys_email` row before touching any action.

## Order and stop processing point forward

The two documentation pages describe Order differently, and the difference matters.
`t_CreatingAnInboundEmailAction` says: "Enter a number that specifies when this inbound action runs
relative to other inbound actions **that use the same target table**." But the ordered-email-processing
reference works an example straight across tables — `change_request` at 100, `problem` at 200,
`incident` at 300, where stop processing at 100 keeps the incident action at 300 from running. Assume
the blast radius is instance-wide, not per-table.

Stop processing is documented as preventing "the system from running additional inbound email actions
after this action runs". So `stop_processing=true` at order 100 does nothing to an action at order 50
and silences every matching action at 101 and above — including base-system ones.
`snow_inbound_email_action` defaults `order` to 100 **and** `stop_processing` to true, and writes both
on every create.

Orders must also be **unique** for any of that to hold: "Ensure each inbound action has a unique Order
value… If multiple inbound actions have the same Order value, the system might evaluate all of the
inbound actions, even if one of them contains the `event.state="stop_processing";` script or has the
Stop processing option selected."
(<https://www.servicenow.com/docs/r/platform-administration/r_OrderedEmailProcessingPlugin.html>) The
tool defaults to 100 and shipped actions commonly sit at 100 too, so a collision is the default
outcome, not an edge case.

So read the field before writing to it — `snow_inbound_email_action({ action: "list", limit: 200 })`
returns the actions sorted by order ascending, which is evaluation order. Raise `limit`: it defaults
to 50, and you want the whole ordered list, not its first page. `active_only: true` narrows it to the
ones that can fire. Then pick an order **no other action already uses**, and pass `stop_processing`
explicitly, never by omission.

`target_table` comes back `undefined` for every row in that list. That is not an empty field; see the
next section.

## The columns this tool writes are not the columns you think

The real columns on `sysevent_in_email_action`, taken from record exports (including ServiceNow's own
`devtraining-needit` sample application):

| Column             | Holds                                                                         |
| ------------------ | ----------------------------------------------------------------------------- |
| `table`            | **The target table.** There is no `target_table` column.                      |
| `type`             | The message classification: `new`, `reply` or `forward`. Lowercase.           |
| `action`           | The "Action type" on the form. Every export carries `record_action`; the stored value behind the Reply Email label is unconfirmed. |
| `filter_condition` | Encoded query evaluated **against `sys_email`**, stored with a trailing `^EQ`. |
| `condition_script` | A script condition, separate from `filter_condition`.                         |
| `script`           | The action body.                                                              |
| `template`         | The **field actions** (e.g. `state=3^EQ`), not an email template.             |
| `reply_email`      | The reply body, for the Reply Email action type.                              |
| `stop_processing` / `order` / `event_name` | Boolean; integer; and `email.read` on every action in the wild. |

And this is what `snow_inbound_email_action` does with its arguments on `create` and `update`:

| Argument                                                              | Column     | Result                                       |
| --------------------------------------------------------------------- | ---------- | -------------------------------------------- |
| `target_table`                                                        | `target_table` | ❌ No such column, so the value never persists. **The action ends up with no target table.** |
| `action_type`                                                         | `type`     | ❌ Wrong column. Defaults to `"record"`, which is not a classification. |
| `template`                                                            | `template` | ⚠️ Real column, wrong meaning — field actions, not a reply template. |
| `name` `order` `stop_processing` `active` `filter_condition` `script` | same name  | ✅ Correct.                                  |

The `action_type` argument is the sharpest one. Its enum is `record | forward | reply | ignore`, which
reads like the Action type field — but the value lands in `type`, the New/Reply/Forward slot.
`"record"` (the default) and `"ignore"` are not classifications at all, and there is no way through
this argument to say `new`. The real Action-type column, `action`, is never written. `"reply"` and
`"forward"` are legal in both vocabularies, so those two appear to work — for the wrong reason.

**So: do not create inbound email actions with `snow_inbound_email_action`.** Create them with
`snow_record_manage`, which passes `data` through to the table as given:

```javascript
snow_record_manage({
  action: "create",
  table: "sysevent_in_email_action",
  data: {
    name: "Create incident from support mailbox",
    table: "incident",              // the target table
    type: "new",                    // classification this action handles
    action: "record_action",
    order: 250,                     // confirmed unused by any other action
    stop_processing: false,         // decide this, do not inherit it
    active: true,
    filter_condition: "recipientsLIKEsupport@example.com^EQ",
    script: "current.short_description = email.subject;\ncurrent.insert();",
  },
})
```

Watch the two `action`s in that call: the outer one is the tool's own verb, the one inside `data` is
the `sysevent_in_email_action` column. Then read the record back with `snow_query_table`, asking for
`table`, `type`, `action`, `order`, `stop_processing` and `filter_condition` — a column that did not
persist looks identical to a successful write from the response alone.

`snow_inbound_email_action` is still right for `list`, `get`, `enable`, `disable` and `delete`, but
`get` reports `target_table` (always empty) and never shows `table`, `action` or `condition_script`.

`snow_discover_table_fields({ table_name: "sysevent_in_email_action" })` reads `sys_dictionary` to
confirm the column list on your instance, but it queries `name=<table>` only, so parent-table columns
are missing. `sysevent_in_email_action` extends the Rules table (`sysrule`), which is where the
ordered email processing plugin puts `order` — so `order` itself will not show up.

## `update` rewrites fields you did not pass

`snow_inbound_email_action({ action: "update" })` applies defaults to `action_type`, `stop_processing`,
`order` and `active` before it decides which fields changed, so those four are never absent. A call
meaning "just change the script" also sets `type="record"`, `order=100`, `stop_processing=true` and
`active=true` on the record:

```javascript
// ❌ Also resets type, order, stop_processing and active on an OOB action.
snow_inbound_email_action({ action: "update", action_id: "Create Incident", script: "..." })
```

The response's `fields_updated` array tells you the truth: if it lists more fields than you passed, it
wrote more than you passed. Either read the record first and echo the current values back in the same
call, or update through `snow_record_manage` with an explicit `data` object. `enable` and `disable`
are safe — they patch `active` and nothing else. One more edge: `action_id` is treated as a sys_id
whenever it is 32 characters long with no whitespace, so an action whose *name* is 32 characters gets
looked up as an ID and reported as not found.

## Writing the condition

`filter_condition` is an encoded query **against `sys_email`**, not against the target table, and the
stored value ends in `^EQ`. Shapes taken from shipped applications (addresses replaced):

```
subjectSTARTSWITHRE:^EQ
recipientsLIKEsupport@example.com^EQ
userLIKE@^user_idISEMPTY^EQ
directLIKEhotline@example.com^ORdirectLIKEsupport@example.com^EQ
```

**`sys_email` has no `from`, `cc` or `bcc` column.** Naming one is the commonest way to write a
condition that silently never matches — as is naming a target-table field such as `priority=1`.

| To match on      | Column                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Subject / body   | `subject`, `body`, `body_text`                                                             |
| Sender           | `user` (matched user's name) and `user_id` — both empty when the sender is not a known user |
| To / Cc / Bcc    | `direct`, `copied`, `blind_copied`                                                         |
| All recipients   | `recipients`                                                                               |
| Classification   | `receive_type`                                                                             |
| Inbound/outbound | `type`                                                                                     |

ServiceNow's email-log field reference documents `subject`, `body`, `recipients`, `state`,
`receive_type`, `type`, `user`, `error_string`, `headers`, `content_type`, `mailbox`, `uid`, `weight`,
`importance`, `deleted` (<https://www.servicenow.com/docs/r/platform-administration/r_EmailLogs.html>).
`direct`, `copied`, `blind_copied`, `body_text` and `user_id` are real columns in every record export
but absent from that reference — confirm the To/Cc/Bcc split on your instance before betting on it.

The tool's schema describes this argument as `"subject:incident"`. That is not encoded-query syntax;
ServiceNow will not parse it. Use `subjectLIKEincident`. For anything the condition builder cannot
express, use `condition_script` — a separate column, not reachable through the tool at all.

## Writing the script

In a scoped application the script is wrapped; in global scope it is bare. Both get the same objects.
ServiceNow's current template takes four arguments:

```javascript
(function runAction(
  /*GlideRecord*/ current,
  /*GlideRecord*/ event,
  /*EmailWrapper*/ email,
  /*ScopedEmailLogger*/ logger
) {
  current.short_description = email.subject;
  current.description = email.body_text;
  current.caller_id = email.from_sys_id;
  current.insert();
})(current, event, email, logger);
```

Older scoped-app exports carry a fifth `classifier` argument; both run, but write new actions with the
four-argument form.

`email.body.<name>` reads a `name: value` pair out of the message body — `email.body.watermark`,
`email.body.feedback` — while `email.body_text` is the raw text. `current` is a GlideRecord on the
action's target table: for a reply it is the record the watermark resolved to, so you set fields and
`current.update()`; for a new message it is an empty record you populate and `current.insert()`.

**ES5 only.** Inbound action scripts run on Rhino: no `const`, `let`, arrow functions, template
literals, and no trailing comma after the last parameter or argument. See `es5-compliance`. A syntax
error here does not surface as a failed tool call; it surfaces as mail that silently stops creating
records.

## Update sets

`sysevent_in_email_action` is metadata — real records carry `sys_package`, `sys_scope`, `sys_policy`
and `sys_update_name` — so inbound actions **are** captured in update sets. But the MCP's update-set
guard treats subcategory `email` as data-shaped, so `snow_inbound_email_action` is not gated, and
`snow_record_manage` sits in `core-operations` and is not gated either. Neither will stop you writing
an action into whatever update set happens to be current, including Default, where it is lost. Open
one yourself first:

```javascript
snow_ensure_active_update_set({ name: "Feature: support mailbox intake" })
```

## When the mail arrived and nothing happened

Work down this list. Stop at the first step that fails — later steps assume the earlier ones held.

**1. Is there a `sys_email` row at all?**

```javascript
snow_get_email_logs({ type: "received", subject: "part of the subject", limit: 20 })
```

No row means the message never reached the instance: check `sys_email_account` and the
`glide.email.read.active` property before looking at any action. Four traps in this tool, three silent:

- Its `type` enum offers `"failed"`, which is **not** a `sys_email` type value — it builds `type=failed`
  and returns zero rows every time. The documented values are `received`, `received-ignored`,
  `send-ready`, `send-ignored`, `send-failed`, `send-translation-ready`, `sent`.
- Its `sender` argument builds `fromLIKE<value>` and there is no `from` column, so the filter constrains
  nothing: you get unfiltered results that look filtered.
- Its field list requests `from`, `cc` and `bcc`, so those three are null on every row. This tool will
  never show you who sent a message; use `snow_query_table` for that.
- Its `since` argument converts `"24h"` into an ISO-8601 string with a `T` and a `Z`, while encoded
  queries expect `yyyy-MM-dd HH:mm:ss` in UTC. What the instance does with the mismatched value is not
  established; if a `since`-filtered call looks wrong, drop it and query `sys_email` directly with an
  explicit `sys_created_on>2026-08-17 08:00:00`.

**2. What is the row's `state`?**

| State (label) | Means                                           | Do next                                                          |
| ------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| Ready         | Queued, not yet processed.                       | A queue/scheduler problem. Stop looking at actions.               |
| Processed     | The instance ran it through inbound processing.  | Processing happened; matching is what failed. Go to step 3.       |
| Ignored       | A filter dropped it before actions ran.          | Look at the account and any ignore filters, not at your action.   |
| Error         | Processing threw.                                | Check the system log. `error_string` is documented as logged only when the email is send-failed, so do not expect it on a received row. |

Stored values are lowercase; `ready` and `processed` are confirmed from real exports, the other two are
not, so read the value off the row rather than hard-coding it in a query. And `state=processed` is not
a claim that anything useful happened — a message that matched no action at all still ends up
processed. It is the single most misread signal in inbound email.

**3. Is a flow handling this, not an action?**

Check the flows with inbound email triggers before reading the action list at all. Flows run first,
and one that issues stop processing ends the email's life before any action is evaluated — so a
perfectly correct action never fires and nothing in `sys_email` says why. No tool here lists inbound
email triggers; look in Flow Designer.

**4. Which action should have matched?**

```javascript
snow_inbound_email_action({ action: "list", active_only: true, limit: 200 })
```

Compare in this order: does any action's `type` equal the row's `receive_type`; does an earlier `order`
with `stop_processing: true` sit above the one you expect; do two actions share an order (in which case
stop processing may not have fired); is the action `active`; does its `filter_condition` match the row.

**5. Read the raw message.**

`snow_get_email_logs` returns a fixed field list, three fields of which are always null. Query
`sys_email` directly instead:

```javascript
snow_query_table({
  table: "sys_email",
  query: "type=received^subjectLIKEsupport",
  fields: ["sys_id", "sys_created_on", "type", "receive_type", "state", "subject", "user", "user_id", "direct", "recipients", "target_table", "body_text"],
  truncate_output: false,
})
```

`truncate_output` defaults to **true** in `snow_query_table`, clipping `body`, `body_text` and
`description` at 200 characters and any other string over 400 — which hides the very watermark line you
are looking for. Turn it off when reading message bodies. And do not go looking for a per-email
processing log: nothing here reads one, and `snow_get_email_logs` reads `sys_email` despite its name.

## Testing

No tool in this server injects a received message or replays one through inbound processing. The
instance does it in the UI: **Reprocess email** on the record, or **Reprocess received emails** on a
list selection, both valid for rows of type `received` and `received-ignored`
(<https://www.servicenow.com/docs/r/platform-administration/reprocess-received-emails.html>). That is
the replay loop — fix the action, reprocess the message, read the row again. First coverage still
needs real mail sent to the instance's inbound address.

From here you can dry-run the script body against a real `sys_email` row with `snow_execute_script`:
useful for a parsing bug, useless for a matching bug, since it exercises none of the classification,
flow precedence, ordering or condition evaluation that decides whether your action runs at all. Say
which one you tested when you report back.

## Common mistakes

| Symptom                                      | Cause                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| Action created, nothing ever fires           | `target_table` never persisted; the action has no target table.        |
| Correct-looking action never evaluated       | An inbound email flow handled the message first and stopped processing. |
| Replies create duplicate tickets             | Watermark stripped in transit, so `receive_type` came out `new`.        |
| Base-system mail handling stopped working    | A new action at order 100 with the default `stop_processing: true`.     |
| `stop_processing` set but later actions ran  | Another action shares the same `order`.                                 |
| Condition ignored, action matches everything | Condition written against target-table fields, or against `from`/`cc`/`bcc`, which do not exist on `sys_email`. |
| An unrelated OOB action changed              | `snow_inbound_email_action` `update` rewriting its four defaulted fields. |
| `snow_get_email_logs` results look wrong     | `type: "failed"` is not a real value; `sender` filters on a column that does not exist. |
