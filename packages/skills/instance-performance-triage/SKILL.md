---
name: instance-performance-triage
description: Answer "the instance is slow" or "my nightly job never ran" from ServiceNow's own telemetry — transaction logs, syslog, sys_trigger, progress workers, execution trackers — instead of ad-hoc scripts that add to the load.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_discover_table_fields
  - snow_get_inbound_http_logs
  - snow_get_logs
  - snow_analyze_query
  - snow_get_scheduled_job_logs (leave state and job_type unset)
  - snow_scheduled_job_manage (action='list', action='get')
---

# Instance Performance Triage

Two questions arrive constantly and both have the same wrong answer: "the instance is slow" and "my
nightly job never ran". The wrong answer is to write a GlideRecord sweep and run it through
`snow_execute_script`. On an instance that is already struggling you have just added a transaction,
and whatever you measure includes yourself. The platform already records what you need. Read it.

This guide is about reading it correctly, because most of the failure modes here are silent — you get a
plausible-looking answer that is not an answer.

## Rule zero: a wrong field name returns everything

The Table API does not reject an encoded query that references a column the table does not have. It
drops the condition, logs `Invalid query detected` / `Unknown field <x> in table <y>` to syslog, and
returns rows up to `sysparm_limit`. Same for `sysparm_fields`: unknown names are simply absent from the
result, so a tool that maps them produces `undefined`, and a tool that counts them produces zero.

The two consequences you must hold in your head for the whole of this guide:

- **A full result set does not mean your filter matched.** It may mean your filter evaporated.
- **An empty result set does not mean the instance is healthy.** It may mean the table is not readable
  by the service account, or the rows were flushed, or you filtered on a value the column never holds.

So before you filter on any column named in this guide, on your instance, confirm it exists:

```javascript
await snow_discover_table_fields({ table_name: "sys_trigger" })
```

The `table-api-reads` skill covers this same behaviour from the read-tool side; what follows is the
part you need in front of you while reading telemetry.

One catch: that tool queries `sys_dictionary` with `name=<table>`, which returns only the columns
**defined on that table**, not inherited ones. `sysauto_script` defines very little of its own — the
scheduling columns live on its parent `sysauto` — so a lookup against the child alone under-reports
what you can actually filter on. When a table extends another, query the dictionary for the whole
chain:

```javascript
await snow_query_table({
  table: "sys_dictionary",
  query: "nameINsysauto,sysauto_script^element!=NULL^ORDERBYelement",
  fields: ["name", "element", "column_label", "internal_type"],
  limit: 200,
})
```

## Where the telemetry actually lives

| Table                  | Holds                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `syslog_transaction`   | One row per transaction, including background/scheduled runs. Timing breakdown lives here.       |
| `syslog`               | `gs.info/warn/error` output: `level`, `source`, `message`, `sys_created_on`.                      |
| `sys_trigger`          | The scheduler queue — every kind of background work, not only scheduled jobs.                     |
| `sysauto` (+ children) | Scheduled job *definitions*. `sysauto_script`, `sysauto_report`, `sysauto_template`, ~16 in all.  |
| `sys_progress_worker`  | Long-running foreground-launched work (update set commits, imports, publishes).                   |
| `sys_execution_tracker`| Trackers for fix scripts, instance scans, other async operations.                                  |
| `sys_db_index`         | Indexes per table.                                                                                |
| `sys_auto_flush`       | The rotation rules that decide how long any of the above survives.                                 |

The timing breakdown in `syslog_transaction` is the single most useful thing on this list, and it is
documented: response time, network time, SQL time, SQL count, business rule time, business rule count,
output length, URL, type, IP address, system ID. Those are the *labels*; column names differ between
releases, and the tools below do not all use the right ones. See rule zero.

Retention matters more than it looks. Every log table above rotates, on rules that admins move around,
and the defaults vary by table and release — none of them are worth carrying in your head. Before you
conclude "there is no record of the run", read the rules off the instance (`sys_auto_flush` on most
instances):

```javascript
await snow_query_table({ table: "sys_auto_flush", limit: 100, display_value: true })
```

## "The instance is slow"

### 1. Bound the question before you query anything

Everyone or one user? Every page or one list? Since when, and what changed then? Without a window and a
scope you will read a thousand rows and learn nothing. Nearly always the useful window is hours, not days.

### 2. Read the transaction log

```javascript
await snow_get_inbound_http_logs({ min_response_time: 5000, since: "2h", limit: 100 })
```

This reads `syslog_transaction` and returns rows sorted newest-first plus avg / max / p95 response time
and a per-endpoint count. Two limits worth knowing before you trust the output:

- Its `status`, `http_method` and `source_ip` filters query columns whose existence on your instance is
  worth confirming first — there is no HTTP *method* among the documented transaction-log fields, and
  the IP column is widely reported as `remote_ip` rather than `client_ip`. If those names are wrong the
  conditions are dropped and you get an unfiltered list with a `filters:` block that claims otherwise.
  `min_response_time`, `url_path` and `since` map onto `response_time`, `url` and `sys_created_on`,
  which are real.
- It does not return the timing breakdown. `response_time` alone tells you *that* it was slow.

### 3. Get the breakdown, because it names the culprit

```javascript
await snow_query_table({
  table: "syslog_transaction",
  query: "response_time>5000^sys_created_on>javascript:gs.hoursAgoStart(2)",
  fields: ["sys_created_on", "url", "type", "response_time", "network_time", "sql_time", "sql_count", "business_rule_time", "business_rule_count", "output_length"],
  order_by: "-response_time",
  limit: 50,
})
```

Those field names are the common ones; a column that comes back missing from every row is named
differently on your release, not empty — check the dictionary rather than concluding the number is zero.
Read the timings against each other:

| Pattern                                    | Read it as                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| High `sql_time`, low `sql_count`           | A few expensive queries. Missing index or a full-table scan. Go to step 4. |
| High `sql_count` (thousands), low per-query | N+1 — a loop doing a query per row, usually in a business rule.            |
| High `business_rule_time`                  | Server-side script cost, not the database. Look at what runs on that table. |
| High `network_time`, low everything else   | The instance was fine. The client's link was not.                          |
| Large `output_length`                      | The list or widget is returning too much. Fix the payload, not the database. |

### 4. Take one slow query apart

```javascript
await snow_analyze_query({ table: "incident", query: "assignment_group.nameLIKEnetwork^active=true" })
```

The `sys_db_index` list in that response is real — a straight query against `sys_db_index`.
`matching_records` comes from the instance too, but read it carefully: the counting request sits in a
`try` whose `catch` only warns, and the field is assigned either way, so a permission failure, a
mistyped table name or a missing `X-Total-Count` header all arrive as `matching_records: 0` —
indistinguishable from a query that genuinely matched nothing. A zero there means "no matches *or* the
count failed", never "I measured zero". What is not real at all: `estimated_performance` and the
anti-pattern list are computed locally from the shape of the string you passed — they never touched the
instance, and `estimated_performance`
is a bucket function of record count and pattern count, not a measurement. Its index coverage compares
raw condition prefixes against indexed column names, so dot-walked conditions and `ORDERBY` clauses
confuse it. Treat the index list as the finding and the grades as commentary.

### 5. About `snow_get_slow_queries` — do not read it as a slow-query report

The name promises the platform's Slow Queries log. It does not read it. What it does:

1. Greps `syslog` for `messageLIKESlow^messageLIKEquery` — an AND of two substrings against free-text
   log messages that may never be written on your instance.
2. Attempts a table named `sys_slow_query_log`, which could not be confirmed to exist in ServiceNow's
   documentation, inside a `try` whose `catch` is empty.
3. Queries `syslog_transaction` for `response_time>min_duration`, also inside a swallowing `catch`.

Only the third leg is dependable, and it is the same data as step 2 above. Its `by_table` grouping is
scraped out of log message text with a regex, not read from a column. Worst of all, when everything
comes back empty it returns `recommendations: ["No major performance issues detected in the analyzed
queries."]` — an inaccessible table and a healthy instance produce the identical sentence. Never quote
that line to a user.

The real store is the platform's **Slow Queries** log, which ServiceNow documents at *All > System
Diagnostics > Stats > Slow Queries*. That page says the log "reports data for similar queries where the
total execution time exceeds 5 seconds", and that queries are similar when they "select from the same
table and query the same field in the where clause, but search for different values in the field". It
names no table and no grouping column, so do not go hunting for either — the module is the interface.
No tool in this MCP reads that store. When the transaction breakdown points at SQL, say so and send the
user there; that is a better answer than a number you invented.

## "My nightly job never ran"

### The two-layer model, which is the whole reason this is confusing

`sysauto` (and its children — `sysauto_script` for script jobs, `sysauto_report` for scheduled reports,
`sysauto_template`, and about a dozen more) holds the **definition**: what runs, how often, as whom.
`sys_trigger` holds the **queue entry**: when it runs next, and what state it is in right now.

`sys_trigger` is shared by the entire platform. Scheduled jobs, SLA calculations, inactivity monitors,
event processing, metric jobs and upgrades all queue there. So `nameLIKEnightly` against `sys_trigger`
will match things that have nothing to do with the job you were asked about, and "500 active triggers"
is not a finding.

### Work it in this order

**1. Does the definition exist and is it active?**

```javascript
await snow_scheduled_job_manage({ action: "list", active_only: true, limit: 100 })
await snow_scheduled_job_manage({ action: "get", job_id: "Nightly Cleanup" })
```

`action: "get"` accepts a name or a sys_id and returns the script, `run_type`, `run_time`, condition and
`active`. Two things it will not do for you: it only ever looks at `sysauto_script`, so a scheduled
*report* or import is invisible to it (`snow_query_table` on `sysauto` finds those), and its `next_run`
block resolves the queue entry with `document=<the job sys_id>` while `snow_trigger_scheduled_job`
writes that link the other way round — `document` holding the table name and `document_key` the sys_id.
The two disagree, so a `next_run: null` from that tool is not evidence that the job has no schedule.
Check `sys_trigger` yourself, on both columns.

**2. Is there a queue entry, and what does it say?**

```javascript
await snow_query_table({
  table: "sys_trigger",
  query: "nameLIKENightly Cleanup",
  fields: ["name", "state", "next_action", "claimed_by", "system_id", "trigger_type", "document", "document_key", "sys_updated_on"],
  display_value: true,
  limit: 20,
})
```

`state` is stored as an integer. `display_value: true` sets `sysparm_display_value=true`, which returns
the label *instead of* the number, not alongside it — so run the query twice, or read the numbers and
use the table below. This is the mapping community and support material report most often, and no more
than that:

| Value | Label             | Means                                        |
| ----- | ----------------- | -------------------------------------------- |
| 0     | Ready             | Waiting for `next_action` to arrive           |
| 1     | Running           | Executing now                                |
| 2     | Queued            | Due, waiting for a scheduler thread           |
| -1    | Error             | Failed, will be retried                       |
| -2    | Permanently Error | Failed, will not be retried                   |

Treat that mapping as a starting hypothesis, not a fact: it is not in ServiceNow's product
documentation, and it is contested inside this repo — `snow_trigger_scheduled_job` polls for
"State 2 = Executed, State 3 = Error", `snow_job_status` for 1=ready/2=running. At most one of the
three can be right. Confirm on the instance in one call:

```javascript
await snow_query_table({
  table: "sys_choice",
  query: "name=sys_trigger^element=state",
  fields: ["value", "label", "inactive"],
  limit: 20,
})
```

If that comes back empty the field carries no choice list on your instance; fall back to
`display_value: true` on real rows.

**3. Read the signature**

| What you see                                          | What it means                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Ready, `next_action` in the future                     | Healthy. The job simply has not been due yet.                                 |
| **Ready, `next_action` in the past**                   | The classic stuck job. This is the symptom you were called about.             |
| Running, `sys_updated_on` hours old                    | Stalled mid-run, or the node that claimed it died.                            |
| `claimed_by` set to a node that no longer exists       | Claimed by a dead node — it will never be picked up until the claim is cleared.|
| No `sys_trigger` row at all                            | The definition never produced a queue entry. Re-save the `sysauto` record.     |
| Queued, and hundreds of others are too                 | Scheduler thread starvation, not a problem with this job.                     |

Find all of the stuck ones at once, without naming a job:

```javascript
await snow_query_table({
  table: "sys_trigger",
  query: "state=0^next_action<javascript:gs.nowDateTime()^ORDERBYnext_action",
  fields: ["name", "state", "next_action", "claimed_by", "system_id"],
  limit: 100,
})
```

**4. Did it in fact run?**

Each background run produces a transaction. Filter `syslog_transaction` by its `type` — do not guess the
constant, read it off your own instance first:

```javascript
await snow_query_table({
  table: "syslog_transaction",
  query: "sys_created_on>javascript:gs.hoursAgoStart(24)",
  fields: ["sys_created_on", "type", "url", "response_time"],
  display_value: true,
  limit: 50,
})
```

Roughly the same data is what the UI shows under *System Logs > Transactions (Background)*. Instances
also carry a slow-job view filtered to long runs, but its module path and its threshold are not in
ServiceNow's product documentation — check both on the instance before you read a job's absence from
that view as evidence of anything. Not every job type lands in the transaction log, which is why the
next step is not optional.

**5. What did it say while it ran?**

```javascript
await snow_get_logs({ level: "error", since: "24h", limit: 100 })
await snow_get_logs({ search: "Nightly Cleanup", since: "24h", limit: 100 })
```

A job that ran and threw leaves an `error` row in `syslog` with `source` set by the caller. A job that
never started leaves nothing — which is why silence in step 5 plus a past `next_action` in step 3 is a
scheduler problem, and silence in step 5 plus a fresh `next_action` means it ran and did nothing, which
is a *condition* problem (check the `conditional` / `condition` fields on the `sysauto` record).

## The long-running-operation tables nobody looks at

When the complaint is "the import has been at 40% for an hour" or "the fix script never finished", the
answer is not in `sys_trigger` at all.

```javascript
await snow_query_table({ table: "sys_progress_worker", query: "ORDERBYDESCsys_updated_on", limit: 20, display_value: true })
await snow_query_table({ table: "sys_execution_tracker", query: "ORDERBYDESCsys_created_on", limit: 20, display_value: true })
```

The columns the tooling in this repo expects — confirm them with `snow_discover_table_fields` before
you filter on any of them — are `message`, `error_message`, `output_summary`, `state_code`,
`queued_time`, `total_run_time`, `total_execute_time` on `sys_progress_worker`, and `percent_complete`,
`start_time`, `completion_time`, `result`, `message`, `detail_message` on `sys_execution_tracker`. The
tooling here also assumes `sys_progress_worker` carries no `start_time`, and that elapsed time has to
come off `total_run_time` instead; that assumption is uncited and sits among comments its own author
marked unverified, so use it to steer the dictionary lookup, not as a fact. A worker whose
`total_run_time` keeps climbing while `message` never changes is stalled; a tracker sitting at the same
`percent_complete` with a
`start_time` an hour old is the same story.

Both tables have a `state` column whose numeric encoding is not documented and is **not** the same as
`sys_trigger`'s — the labels seen in the wild are word-like (`running`, `complete`, `cancelled`). Read
the rows with `display_value: true` and filter on what you actually see. Do not carry `state=1` over
from the table above.

## Tools in this MCP that will mislead you here

- **`snow_job_status`** looks like the obvious tool for this whole section and is not safe for the
  decisive query. Its `list_active` filters `sys_trigger` with `state!=0`, which excludes Ready — and
  Ready-with-a-past-`next_action` is exactly the stuck job you are hunting. The file admits the
  uncertainty: two of its TODOs read "verify state codes against a live instance", and the comment above
  that filter claims 1=ready/2=running, which is not the mapping above. `list_active` and `get_errors`
  also window-filter on `sys_updated_on` — 24 hours by default, 168 for `get_history` — so a trigger
  stuck untouched since Tuesday falls outside the default; only `get_status`, a direct fetch by sys_id,
  has no window at all. That clause is built with `gs.beginningOfLastXHours(N)`, which is not in
  ServiceNow's product documentation, so whether a stale trigger is quietly filtered out or the whole
  clause fails is itself unconfirmed. Its `get_errors` action filters triggers on `error_count` and
  `last_error`; if neither column is on your instance's `sys_trigger`, rule zero applies and you get
  every trigger in
  the window presented as an error. Use `snow_query_table` for anything you intend to act on.
- **`snow_get_scheduled_job_logs`** does query `sys_trigger`, but read its output narrowly. Leave
  `state` and `job_type` unset: `state` pushes a word (`state=running`) at a column that stores
  integers, so it returns zero rows while jobs are plainly running, and `job_type` pushes
  `run_type=...`, a `sysauto` column. `include_inactive` defaults to false, so every call silently adds
  `active=true` — there is no "just show me the queue" mode. And its field selection asks `sys_trigger`
  for `run_type`, `run_count`, `error_count`, `run_as`, `script`, `run_dayofweek` and `run_time`, which
  is the same `sysauto`-column mistake again; it then builds `statistics.total_errors`, `has_errors` and
  `error_prone_jobs` out of `parseInt(job.error_count) || 0`. If `error_count` is not on your instance's
  `sys_trigger`, that block reports zero errors across every job while jobs are failing. Never repeat
  those counts to a user. Its `since` filter and its sort both use `last_run`; confirm that column
  exists before you believe either.
- **`snow_trigger_scheduled_job`** writes a `sys_trigger` row to make a job run now. Its own description
  calls it unreliable, and it is: creating the row is not running the job, `wait_for_completion` polls a
  record the scheduler may delete or reschedule out from under it, and on a slow instance you are adding
  work to the queue you are investigating. Triage is a read-only activity. If the user genuinely wants
  the job run now, say that the UI's *Execute Now* on the `sysauto` record is the honest path.
- **`snow_execute_script`** deploys and calls a Scripted REST executor. It really runs your code — which
  is the problem. A `GlideRecord` sweep over `syslog` on a struggling instance is another slow
  transaction, and it will show up in your own results.

## Three quirks of these tools that cost people afternoons

**Relative `since` is not a precise window.** `snow_get_logs`, `snow_get_slow_queries`,
`snow_get_inbound_http_logs` and `snow_get_scheduled_job_logs` all convert `"2h"` with JavaScript's
`toISOString()` and compare with `sys_created_on><that>`. The formats ServiceNow's encoded queries
document for date comparison are `yyyy-MM-dd[ HH:mm:ss]` and `javascript:gs.dateGenerate(...)`; an
ISO-8601 string with `T` and `Z` is not one of them, and the comparison is evaluated in the *service
account's* timezone, not yours. Use them for a rough recent slice. When the window is load-bearing —
"did it run between 02:00 and 03:00" — build it yourself with `snow_query_table` and
`javascript:gs.hoursAgoStart(N)`, `javascript:gs.daysAgoStart(N)` or
`javascript:gs.dateGenerate('2026-08-17','02:00:00')`.

**`snow_get_logs` only applies `level`, `source` and `search` to `syslog` and `syslog_app_scope`.** Pass
`log_table: "syslog_transaction"` and those three arguments are ignored by design — only `since` and
`limit` survive. It is not broken; it is that the other tables have no such columns. For a filtered
transaction query, use `snow_query_table`.

**`snow_query_table` truncates by default.** `truncate_output` defaults to `true`, and it applies two
rules to any string longer than 200 characters. If the column name contains `script`, `description`,
`comments`, `short_description`, `work_notes`, `body`, `content`, `payload` or about a dozen more, it is
cut at 200 with a marker. Everything else survives until 400, then is also cut at 200. So a
250-character `description` came back clipped and a 250-character `condition` came back whole — and so
did the stack trace you were reading, if it was long enough. The `table-api-reads` skill lists both
rules in full. Pass `truncate_output: false` when the message is the evidence.

## What to report back

Answer with the measurement and its window, not an adjective. "p95 over the last two hours is 8.4s on
`/api/now/table/incident`, `sql_time` is 90% of it, `incident` has no index on `u_region`" is a finding.
"The instance seems slow" is what you were told at the start. And when the telemetry is not there —
table not readable, rows flushed, no tool reads that store — say that instead of filling the gap. An
honest "I cannot see this from here, it is in System Diagnostics > Stats > Slow Queries" is worth more
than a generated recommendation.

## Verified against

- Transaction log fields — <https://www.servicenow.com/docs/r/washingtondc/platform-security/r_TransactionLogs.html>
- Reviewing transaction logs and response times — <https://www.servicenow.com/docs/r/yokohama/platform-administration/platform-performance/c_TransactionLogResponseTimes.html>
- Slow query log — navigation path, the 5-second threshold and the grouping wording quoted above (no table or column names appear on that page) — <https://www.servicenow.com/docs/bundle/yokohama-platform-administration/page/administer/platform-performance/task/t_UseASlowQueryLog.html>
- "Invalid query detected" / unknown field in a table, KB0863715 — <https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0863715>
