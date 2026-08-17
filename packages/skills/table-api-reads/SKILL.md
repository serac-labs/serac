---
name: table-api-reads
description: What a Table API read through this MCP actually returns — the 200-character truncation in snow_query_table, the three different display_value defaults, reference fields as {link, value} objects, why work_notes come back empty, and which reported totals are real counts and which are guesses.
tools:
  - snow_query_table
  - snow_get_by_sysid
  - snow_record_manage (action='query')
  - snow_record_manage (action='get')
  - snow_get_journal_entries
  - snow_add_comment
  - snow_pull_artifact
  - snow_describe_field
  - snow_discover_table_fields
  - snow_aggregate_metrics
---

# Reading Records Through the Table API

Almost every skill in this collection tells you to call `snow_query_table`. None of them tell you what
comes back. Three tools read the same record from `/api/now/table/{table}` and return three different
shapes with three different content policies, and the most-used of them reports a record total that was
never counted.

Read this before you make a decision based on field content you got out of a query — especially a script
body, a description, a journal entry, or a total.

## The three read tools at a glance

| What it does | `snow_query_table` | `snow_record_manage` (get/query) | `snow_get_by_sysid` |
| --- | --- | --- | --- |
| `sysparm_display_value` | `false` unless you ask | `all` unless you pass `display_value: false` | `false` unless you ask |
| Reference fields | `{link, value}` objects | `query`: `{display_value, value}`, no link. `get`: `{display_value, link, value}` | `{link, value}` objects |
| Every other field | plain string | `{display_value, value}` object | plain string |
| Long values | **truncated at 200 chars by default** | never truncated | never truncated |
| `sys_id` | always injected into `sysparm_fields` | only if you ask for it | not injected — absent from the record if you pass `fields` without it |
| Fields when you omit `fields` | all of them | a hardcoded preset subset | all of them |
| Record total | a guess | real, from `X-Total-Count` | n/a |

The rest of this guide is why each cell says what it says.

## snow_query_table truncates, and the marker is easy to miss

`truncate_output` defaults to **true**. With it on, every field whose value is a *string longer than 200
characters* is checked — nothing at or under 200 is ever touched, whatever it is called:

- If the field name contains any of `template`, `script`, `server_script`, `client_script`, `css`,
  `html`, `xml`, `json`, `payload`, `body`, `content`, `description`, `comments`, `work_notes`,
  `additional_comments`, `close_notes`, `resolution_notes`, `instructions`, `short_description`,
  `long_description` — it is cut at **200 characters**.
- Otherwise, if the value is longer than **400 characters**, it is cut at 200 anyway.
- Otherwise it comes through whole.

The first rule matches on *substring*, against the lowercased column name, not against the list as
written — so a custom `u_request_payload` matches `payload` and a custom `u_error_body` matches `body`.
The second rule has nothing to do with names at all: `condition` on `sys_script` and `text` on
`kb_knowledge` are cut simply for being over 400 characters.

What you get back in place of the value:

```
"script": "(function executeRule(current, previous) {\n\n  // 200 characters of this... [truncated, 4823 chars total]"
```

Nothing is deleted or hidden — the marker is right there and it even tells you the real length. The
failure is that an agent reads past it, treats the fragment as the artifact, and writes a "fixed"
version of a 4823-character business rule from its first 200 characters. Every step after that reports
success, and the update set contains a rule with 95% of its body gone.

**When you intend to read content, turn truncation off.**

```javascript
// Reading a business rule to modify it
await snow_query_table({
  table: "sys_script",
  query: "name=Incident Autoclose",
  fields: ["sys_id", "name", "collection", "when", "script"],
  truncate_output: false,
})
```

The truncation pass only inspects strings. Reference fields arrive as objects (see below), so they are
never touched whatever their size — only plain string columns are at risk.

### `truncated: true` in the result is not a finding

The result object carries `truncated`, and it is a straight echo of the `truncate_output` argument. It
says "truncation was enabled", not "something was truncated". A result with `truncated: true` may
contain nothing that was cut, and a single `... [truncated, N chars total]` inside one field is the only
evidence that anything was. Grep the values, not the flag.

## `total` and `has_more` from snow_query_table are guesses

`snow_query_table` never counts anything. It reports:

- `count` — real. The number of records in this response.
- `total` — `count` if the response came back short of `limit`; otherwise the **literal string `"100+"`**,
  no matter what limit you asked for. Request `limit: 5`, get 5 rows back, and `total` is `"100+"` on a
  table holding exactly five records.
- `has_more` — true whenever the page came back full. On a table with exactly `limit` matching records it
  is true and there is nothing more.

Also note that when the page comes back short, `total` is the row count of *this page*, so with
`offset: 500` it under-reports the real total by 500.

Never put `total` in a report, a summary to the user, or a branch condition. For a real number use
`snow_aggregate_metrics` **with the same `query` you filtered on** — it hits `/api/now/stats/{table}` and
returns the rolled-up count without fetching rows — or `snow_record_manage({ action: "query" })`, which
reads the `X-Total-Count` response header and reports it as `total_count`.

That second option is not free. The count comes from a *second* GET against the same table, carrying your
query and `sysparm_count` but **no `sysparm_limit` and no `sysparm_fields`**. The Table API's documented
default limit is 10000, so that request asks for every column of up to ten thousand rows, under the
client's 60-second timeout. (`sysparm_count` is not a documented Table API parameter — the documented one
is `sysparm_no_count` — so do not assume it turns the request into a cheap header-only response.) If a
`snow_record_manage` query times out on `cmdb_ci` or `sys_audit` while the same filter works fine in
`snow_query_table`, that second request is why. Narrow the query, or count with `snow_aggregate_metrics`,
passing it the same `query` — called bare it counts the whole table.

## display_value changes what the values mean, not just how they look

`sysparm_display_value` has three settings and this MCP uses all three.

**`false` (snow_query_table and snow_get_by_sysid default).** Stored values. Choice fields are their
stored numbers (`state: "2"`), date/time fields are UTC in `YYYY-MM-DD HH:mm:ss`, and reference fields
are objects:

```json
"assigned_to": {
  "link": "https://dev12345.service-now.com/api/now/table/sys_user/681ccaf9c0a8016400b98a06818d57c7",
  "value": "681ccaf9c0a8016400b98a06818d57c7"
}
```

So `record.assigned_to` is not a username and not a sys_id — it is an object, and string-concatenating it
gives you `[object Object]`. Reach for `record.assigned_to.value`. Note also that `snow_query_table` does
not send `sysparm_exclude_reference_link`, so every reference column carries that full URL. On a
hundred-row query with ten reference columns the links are most of the payload; pass `fields` to keep
columns you do not need out of the response.

**`true` (what `display_value: true` sends).** Display values *replace* stored values. `state` becomes
`"In Progress"`, references become `{display_value: "Beth Anglin", link: "..."}`, and date/time fields
are rendered in the **calling user's time zone and date format** rather than UTC. Values read this way
cannot be fed back into an update or into an encoded query — `state=In Progress` matches nothing. Use it
to show a human what a record says, not to compute with.

**`all` (what `snow_record_manage` sends by default).** Every field arrives as
`{display_value, value}`, including `sys_id`, `sys_created_on` and plain strings. Nothing in the record
is a bare string. On `action: "query"` — and only there — `snow_record_manage` also sends
`sysparm_exclude_reference_link=true`, so a reference is `{display_value, value}` with no link. On
`action: "get"` it sends only `sysparm_fields` and `sysparm_display_value`, and the documented default
for `sysparm_exclude_reference_link` is `false`, so the same reference field comes back as
`{display_value, link, value}` — the link is there.

## snow_record_manage silently narrows your field list

`snow_record_manage` actions `get` and `query` take `fields` as a **comma-separated string**, not an
array. When you omit it, the tool does not fall back to "all fields" — it substitutes a hardcoded
default list for the table, and says nothing about it.

- For a preset name (`incident`, `change`, `user`, `ci`, `asset`, `hr_case`, …) you get that preset's
  field list. The `incident` preset returns `number, short_description, description, state, priority,
  urgency, impact, assigned_to, assignment_group, caller_id, category, subcategory, opened_at,
  resolved_at, closed_at` — **and no `sys_id`**.
- For any other table you get exactly `sys_id, sys_created_on, sys_updated_on`. A `query` against
  `sys_script` without `fields` returns three timestamps per row and no name, no script, no table.

Two consequences worth internalising:

1. **The sys_id you get back can be an empty string.** `result.sys_id` is extracted from the returned
   record; if `sys_id` was not in the field list, there is nothing to extract and the field comes back
   as `""`. Downstream, that becomes a lookup for a record that does not exist.
2. **Do not trust the `url` field on `action: "get"`.** It concatenates the raw record value, which under
   `display_value: "all"` is an object — the link ends in `sys_id=[object Object]`, or `sys_id=undefined`
   when `sys_id` was never requested. Build the link from `result.sys_id` yourself.

   `action: "query"` has no top-level `sys_id` at all, and each row is assembled as
   `{sys_id: <extracted value>, ...record}` — the spread puts the raw column back on top, so under the
   default `display_value` the **per-row** `sys_id` is a `{display_value, value}` object, not a string.
   The per-row `_url` is built from the extracted value and is fine (it merely ends in an empty `sys_id=`
   when you did not ask for the column), but a link you assemble yourself out of `row.sys_id` will not
   be. Take `row.sys_id.value`.

Always pass `fields` explicitly on `snow_record_manage`, and always include `sys_id` in it:

```javascript
await snow_record_manage({
  action: "query",
  table: "incident",
  query: "active=true^priority=1",
  fields: "sys_id,number,short_description,state,assigned_to",
  limit: 50,
})
```

`snow_query_table` has the opposite behaviour: omitting `fields` returns every column, and when you *do*
pass `fields` it prepends `sys_id` for you. That is the one place it is friendlier than
`snow_record_manage`.

## Journal fields come back empty, and half a fix does not work

`comments` and `work_notes` are journal fields. The text is not stored on the record — it lives in
`sys_journal_field`, one row per entry. The Table API does not return journal content by default, so a
plain read gives you an empty string and no error:

```javascript
// Returns work_notes: ""  — and the record has forty work notes
await snow_query_table({ table: "incident", query: "number=INC0010023", fields: ["number", "work_notes"] })
```

`sysparm_display_value=true` makes the Table API return the whole accumulated journal as one string. But
`work_notes`, `comments`, `additional_comments` and `close_notes` are all in this MCP's truncation list,
so with `truncate_output` at its default you get the first 200 characters of that string — one entry's
timestamp-and-author header and about two lines of text. **Both halves or nothing:**

```javascript
await snow_query_table({
  table: "incident",
  query: "number=INC0010023",
  fields: ["number", "work_notes", "comments"],
  display_value: true,
  truncate_output: false,
})
```

The alternative, and the better one when you want entries rather than a blob, is
`snow_get_journal_entries`, which queries `sys_journal_field` directly on
`name=<table>^element_id=<record sys_id>`. Each row carries `element` (`comments` or `work_notes` —
both come back mixed, filter yourself), `value` (the entry text), `sys_created_on` and `sys_created_by`.

Three things about that tool that will cost you time otherwise:

- **It does not order the results.** No `ORDERBY` is sent and there is no order parameter, so do not
  assume the newest entry is first or last. Sort on `sys_created_on` after you get them.
- **It filters on `name=<table>`, and old rows may not carry your table.** Journal entries used to be
  written against the base `task` table rather than the child table they came from; ServiceNow changed
  this in the Jakarta release, but rows written before then — including anything carried across a
  clone or migration — still say `task`. If a record visibly has work notes and the tool returns zero
  entries, re-run the read yourself against `element_id` alone, which is a sys_id and therefore unique:

  ```javascript
  await snow_query_table({
    table: "sys_journal_field",
    query: "element_id=sys_id_here^ORDERBYDESCsys_created_on",
    fields: ["element", "value", "sys_created_by", "sys_created_on"],
    truncate_output: false,
  })
  ```

- **It sends `sysparm_display_value=true`,** so `sys_created_on` on each entry comes back in the calling
  user's time zone and date format, not UTC. Don't compare those strings against a UTC timestamp you got
  from a `snow_query_table` read.

`snow_get_journal_entries` itself applies no truncation, so entry text arrives whole. The fallback query
above does not get that for free: `value` is a plain string column, so `snow_query_table`'s 400-character
rule cuts long entries unless you pass `truncate_output: false`.

Writing is a separate path: `snow_add_comment` PATCHes `comments` (or `work_notes` when
`work_note: true`) on the record, which appends an entry — journal fields never overwrite. It returns
`{added: true}` built locally after a successful PATCH; it does not read the entry back, so if you need
to confirm what landed, read it with `snow_get_journal_entries` afterwards.

## Reading a full artifact body

For a widget, script include, UX page or flow, `snow_pull_artifact` GETs the record with no `sysparm_*`
parameters at all — no truncation, no display values — and hands back the body fields as a
`{filename: content}` map. Which columns become which files depends on the table, and only these four
are covered:

| Table | Files it emits |
| --- | --- |
| `sp_widget` | `<name>.html` (`template`), `<name>.server.js` (`script`), `<name>.client.js` (`client_script`), `<name>.css` (`css`), `<name>.options.json` (`option_schema`) |
| `sys_script_include` | `<name>.js` (`script`) |
| `sys_ux_page` | `<name>.html` (`html` — *not* `template`), `<name>.client.js` (`client_script`) |
| `sys_hub_flow` | `<name>.flow.json` — a `JSON.stringify` of the **whole record**, not one column |

Two more things before you reach for it:

- **The map always carries an extra generated `README.md`** — a summary the tool writes itself, not
  artifact content. If you iterate the `files` map, skip that key.
- **It is classified `permission: "write"`, and on the stdio transport it also writes every file to
  disk**, under `output_dir` (default `<tmpdir>/serac-artifacts/<table>/<name>`). On HTTP `output_dir`
  is rejected and you only get the inline map. Nothing is written to ServiceNow either way, but your
  filesystem is not left alone — if you only want to *look* at a body, `snow_get_by_sysid` leaves no
  trace.

For anything else — a business rule, a UI action, an ACL script, a transform script — use
`snow_get_by_sysid`. By default it sends no display-value parameter, and it applies no truncation of any
kind, which makes it the rawest read available here and the right default once you already have a sys_id.

```javascript
await snow_get_by_sysid({
  table: "sys_security_acl",
  sys_id: "sys_id_here",
  fields: ["name", "operation", "type", "admin_overrides", "condition", "script"],
})
```

Note its one asymmetry: a 404 comes back as `success: true` with `found: false`, not as an error. Check
`found` before you read `record`.

## What a failed read looks like

When an HTTP error carries an error body — the `{"error": {"message": ..., "detail": ...}, "status":
"failure"}` shape — the shared HTTP client re-throws it with a `ServiceNow: ` prefix, so what reaches you
is the platform's own wording rather than `Request failed with status code 403`. Two cases are handled
before that: a `502` or `503` is converted into an explicit "instance is hibernating" message naming the
URL to open, and a `401` triggers one silent token refresh and retry before it is allowed to fail.

The prefix is not a reliable tell, though. ServiceNow also returns that error body on a **200**
sometimes, and the client throws on those too — with the platform's own message and *no* prefix. So an
unprefixed failure means one of two things: no error body on an HTTP error, or an error body that
arrived on a success status. Read the message, not the prefix.

The reads that hurt are the ones that *don't* fail:

- **ACLs filter rows silently.** The Table API enforces the same ACLs as the UI, evaluated as the OAuth
  service account, which is usually not your admin UI user. Rows you cannot read are absent from
  `records`; nothing tells you they were removed, and `count` and `X-Total-Count` reflect only what you
  were allowed to see. A query returning fewer rows than the list view shows is a permissions result,
  not an empty table.
- **Field-level ACLs remove columns the same way** — the key is simply missing from the record object.
- **A misspelled column in `fields` is ignored.** The Table API reference says of `sysparm_fields`:
  "Invalid fields are ignored." You get a record without that key and no error. `assigned_too` and
  `assignment_grp` fail this way and look like empty data.

## Know the columns before you query

`sys_dictionary` holds a row only for the table that **declares** a column — inherited columns are not
repeated on the child. So a `sys_dictionary` read filtered on `name=incident` returns the
incident-specific columns and omits what `task` declares, `short_description` and `state` among them.
The field is real, your query works, and the schema output does not list it. The same gap applies to
`sc_req_item` and `sc_task` (parent `task`), `alm_hardware` (parent `alm_asset`) and every `cmdb_ci_*`
class.

`snow_discover_table_fields` and `snow_table_schema_discovery` both query `sys_dictionary` by table name
alone, so both have that gap. When you need one field's real definition, use **`snow_describe_field`**:
it walks `sys_db_object.super_class` to the root class, applies the `sys_dictionary_override` rows it
finds anywhere on that chain, and resolves the field's `sys_choice` list — so it answers
`incident` / `short_description` instead of returning nothing.

If you do use `snow_discover_table_fields` for a table-wide listing, **read `name` and `label` off it and
nothing else.** It queries `sys_dictionary` without `sysparm_display_value`, so `internal_type` and
`reference` arrive as `{link, value}` objects: `fields[].type` and `fields[].reference` are objects, not
strings. And because the tool builds `relationships` by filtering `type === "reference"` — a comparison
that can never match an object — `relationships` is always `[]`, even though `include_relationships`
defaults to true. An empty `relationships` from that tool is not evidence the table has no reference
fields.

## Checklist before you act on a read

1. Am I reading content — a script, a description, a journal entry — or just identifiers? Content needs
   `truncate_output: false` or `snow_get_by_sysid`.
2. Did I scan the values for `... [truncated,`? The `truncated` flag will not tell me.
3. Is the number I am about to report a count, or is it `snow_query_table`'s `total`?
4. If I am about to write a value back, was it read with `display_value` off? A display value is not a
   storable value.
5. Did I pass `fields` to `snow_record_manage`, with `sys_id` in it?
6. Is a reference field I am treating as a string actually `{link, value}`?
