---
name: background-script-execution
description: What actually happens when you call snow_execute_script — the Scripted REST endpoint Serac auto-deploys on first use, the scheduled-job fallback, what scheduled_job_pending means, and how to get output back when the call comes home empty.
tools:
  - snow_execute_script
  - snow_get_script_output
  - snow_redeploy_script_endpoint
  - snow_job_status (action='get_history')
  - snow_get_logs
  - snow_session_context
  - snow_query_table
  - snow_record_manage (action='delete')
---

# Background Script Execution

`snow_execute_script` is the most-recommended tool in this catalog and the least explained. It does **not** use ServiceNow's *Scripts - Background* module. It ships its own transport, and knowing which of two paths your call took is the difference between reading a real result and reading a placeholder.

## The two paths

| | Sync path | Fallback path |
|---|---|---|
| `metadata.method` | `sync_rest_api` | `sysauto_script_with_trigger`, or `scheduled_job_pending` |
| How it runs | POST to a Scripted REST endpoint Serac installed; the operation evaluates your script inline and returns the result in the HTTP response | Creates a `sysauto_script` job plus a `sys_trigger` row set to fire two seconds out, then polls `sys_properties` for a marker the job writes when it finishes |
| Typical latency | 1–3s | 4s to the full `timeout` (default 30s) |
| You get output | Yes, in the response | Only if the poll caught the marker before it gave up |

Every call tries the sync path first. It falls back the moment the sync POST does not return a usable body — and that includes the case where your script *ran* and threw, because the endpoint answers a thrown script with HTTP 500 and the client treats any non-2xx as "endpoint didn't work". So a script with a bug in it can be executed up to three times: once by the sync POST, once by the retry after the endpoint is re-verified, once by the scheduled job. Assume **a failing script is not executed exactly once**, and never let a script that mutates data be the thing you debug through this tool. Get it right in a read-only form first.

## The endpoint Serac installs

The first call against an instance deploys a Scripted REST API. Two records, both created through the Table API:

| Record | Table | Key values |
|---|---|---|
| Definition | `sys_ws_definition` | `name` = `Serac Script Executor`, `service_id` = `snow_flow_exec`, `active` = true |
| Operation | `sys_ws_operation` | `name` = `Execute Script`, `http_method` = `POST`, `relative_path` = `/execute`, `requires_authentication` = true |

The live URL is `/api/<namespace>/snow_flow_exec/execute`, and the namespace is not Serac's to choose. For a web service in the global scope ServiceNow derives it from the `glide.appcreator.company.code` property, so the same endpoint is `/api/global/snow_flow_exec/execute` on one instance and `/api/acguk/snow_flow_exec/execute` on the next. That is why the deploy does not compute a URL — it pings candidates in order (the operation's own `operation_uri`, the definition's `base_uri` + `/execute`, namespace-prefixed and unprefixed guesses) and caches the first one that answers with `success: true`. A freshly created resource takes a moment to become routable, so each candidate is tried up to five times, 1.5s apart. A first call on a cold instance is slower than every call after it.

### Rights

Creating and modifying scripted REST APIs requires the **web service administrator** role (`web_service_admin`); admin includes it.
See <https://www.servicenow.com/docs/bundle/yokohama-api-reference/page/integrate/custom-web-services/concept/c_CustomWebServices.html>.

That is not sufficient to *use* the endpoint. The operation script's first statement is `gs.hasRole('admin')`, and it answers everyone else with HTTP 403 and `Forbidden: this endpoint requires the admin role.` The check is deliberately in the script rather than in an ACL so it travels with the record and cannot be unhooked elsewhere.

The consequence is a failure mode worth recognising on sight: an integration user with `web_service_admin` but not `admin` **installs the endpoint successfully and is then refused by it on every call**. The deploy diagnostics report this as

```
no candidate URL responded with success=true; endpoint may not be routable yet or path is wrong
```

which reads like a routing problem and is not one. If you see that line, check the caller's roles before you touch anything else — `snow_session_context` will tell you who Serac is authenticated as and what it holds.

## Reading what comes back

There are two `success` fields and they mean different things.

- The **envelope** `success` is the MCP tool result. It is `true` whenever the tool completed, including when your script threw.
- **`data.success`** is your script. `false` means it threw and `data.error` holds the message. The stack, when Rhino produced one, arrives separately as a `Stack: …` entry in `data.output.error`.

A thrown script does not come back as `method: sync_rest_api`. The endpoint answers it with HTTP 500, the client reads any non-2xx as "endpoint unusable", and the error you finally read is the one the *scheduler* produced re-running the same script. That is the tell for a script error here: the method quietly changes.

The fields worth reading:

| Field | Meaning |
|---|---|
| `metadata.method` | Ground truth for which path ran. Read this first. |
| `data.executed` | `false` only when `method` is `scheduled_job_pending`, and there it means *not confirmed*, not *did not run* |
| `data.result` | The script's return value, subject to the trap below. |
| `data.output` | `{ print, info, warn, error }`, each an array of strings, captured from `gs.print` / `gs.info` / `gs.warn` / `gs.error` |
| `data.execution_id` | The handle you need if the call comes back pending |
| `data.fallback_warning` | Present whenever the sync path was not used |

`data.fallback_warning` says the sync REST endpoint "could not be reached". Read that as "was not used", not as a diagnosis — a script that threw produces the same message even though the endpoint answered perfectly.

## Write the script so both paths agree

The two paths wrap your script differently, and the difference bites exactly at the return value.

- **Sync path**: the whole script is handed to `GlideEvaluator.evaluateString` and evaluated as a program. There is no function around your code to `return` from. `evaluateString` is not a documented public API — the usual reading, that it hands back the value of the last expression evaluated, is inference from Rhino rather than anything ServiceNow states. Treat `data.result` here as unreliable, not as a contract.
- **Fallback path**: your script is pasted inside `(function() { ... })()`. Here a `return` is required, and a trailing bare expression is thrown away.

So a script written for the sync path — one that ends in a bare expression — comes back with `result: null` on the fallback path. The other direction is not symmetrical: a top-level `return` is a syntax error in a program, so a fallback-shaped script sent down the sync path most likely throws rather than returning nothing, which puts you in the 500-then-reschedule path described above. Either way, do not depend on the return value. Print what you need and read it out of `data.output`:

```javascript
// Portable: works identically on both paths
var gr = new GlideRecord("sys_user_role")
gr.addQuery("name", "admin")
gr.query()

var out = []
while (gr.next()) {
  out.push({ sys_id: gr.getValue("sys_id"), name: gr.getValue("name") })
}
gs.info("ROLES=" + JSON.stringify(out))
```

Then read `data.output.info` and parse the line you prefixed. A prefix matters: on the fallback path the wrapper injects its own `gs.info` lines (`=== Serac Script Execution Started ===`, `Description: ...`, `Script returned: ...`) into the same array.

Other rules that hold on both paths:

- **ES5 only.** ServiceNow's server side is Rhino. `validate_es5` (default true) only adds a string to `data.warnings`; it never blocks the call, so an arrow function reaches the instance and fails there. See the `es5-compliance` guide.
- **Only those four `gs` methods are captured.** Anything logged another way (`gs.log`, `gs.debug`, a `console` call) does not appear in `data.output`. What reaches syslog is still retrievable afterwards with `snow_get_logs`.
- **Keep `data.result` JSON-shaped.** The endpoint serialises it into the HTTP response. Return strings, numbers and plain objects; `JSON.stringify` anything else yourself rather than handing back a GlideRecord.

## `scheduled_job_pending` — what it means and what not to do

This is the outcome to understand, because the payload's own advice is a trap.

Pending means: the sync path was unavailable, the `sysauto_script` job was created, the `sys_trigger` row was created, and the poll loop ran out of `timeout` without finding the completion marker. The tool then returns

```
action_required: "Navigate to System Scheduler > Scheduled Jobs and run: Serac Exec - exec_1731…"
manual_url:      "<instance>/sysauto_script.do?sys_id=<scheduled_job_sys_id>"
```

**Do not follow that first.** The trigger to run the job already exists; if the job merely finished after the poll gave up, running it by hand executes your script a second time. That matters a great deal when the script writes.

The job writes its result to a system property named `SNOW_FLOW_EXEC_<execution_id>` on completion. That is what `snow_get_script_output` reads, and it is the safe recovery route:

```javascript
// After a pending result — wait, then look for the marker
snow_get_script_output({ execution_id: "exec_1731…", cleanup: true })
```

Read `metadata.source` before you believe a word of the result — this tool has two lookups behind it and only one of them is about your execution.

- `source: "sys_properties"` → this is your script. You get `result`, `output`, `error`, `execution_time_ms`, and `cleanup: true` deletes the property.
- `source: "execution_history"` → **discard it.** When the marker is absent the tool makes a second lookup — `sys_script_execution_history` filtered `script_nameLIKE<execution_id>` — and returns the first row it gets as a success. Nothing Serac executes is ever written to that table (see *Where the output is not*), and whether the table even has a `script_name` column is unconfirmed; if it does not, the Table API drops the condition and hands you an unrelated row wearing your execution's ID. Only a `sys_properties` result is your output.
- `NOT_FOUND` after a reasonable wait → the job probably never got picked up. Now go look at the trigger before running anything.

```javascript
snow_job_status({ action: "get_history", sys_id: "<scheduled_job_sys_id>" })
```

Read `trigger_runs` from that response and nothing else. The query behind it matches `sys_trigger` on `document_key`, which is where the `sysauto_script` sys_id lives — but with `sys_id` and no `job_name` the same call also fires an unfiltered `sys_execution_tracker` query (`nameLIKE` an empty string), so `execution_trackers` is a slice of whatever the instance was doing lately and has nothing to do with your script. The `instance-performance-triage` guide argues this tool is not safe for trigger questions at all; if the answer matters, read the row yourself with `snow_query_table` on `sys_trigger`.

On `sys_trigger`, `trigger_type: 0` is run-once and `state: 0` is Ready. Treat that as strong but instance-checkable — it is not in ServiceNow's product documentation, and this repo carries two conflicting versions of the mapping in its own comments. `instance-performance-triage` gives the `sys_choice` query that settles it on your instance. `system_id` names the node that should claim the job and is normally blank; Serac writes the literal string `snow-flow` into it. A trigger pinned to a node name that no node matches is the first thing to rule out when the records exist and nothing ran.

A pending result leaves three things behind, and nobody cleans them up for you:

```javascript
snow_record_manage({ action: "delete", table: "sysauto_script", sys_id: "<scheduled_job_sys_id>" })
```

the `sys_trigger` row named `Serac Exec - <execution_id>`, and the `SNOW_FLOW_EXEC_<id>` property if it appeared and you did not read it with `cleanup: true`. Serac deletes the job record on a successful fallback and deletes nothing at all on the pending path; the trigger row it never deletes on any path. Delete that one last, and only once you are satisfied the job is not still queued — removing a Ready trigger turns "late" into "never".

**Do not call `snow_get_script_output` after a call that already returned output.** On the sync path nothing is ever written to `sys_properties`, and on a successful fallback the property is read and deleted immediately. So the marker lookup finds nothing, and what comes back is either `NOT_FOUND` for a script that ran fine or — worse — the `execution_history` branch above, answering confidently with somebody else's row.

## When the endpoint goes stale

The resolved URL is cached in the server process, keyed by tenant and instance. The cache is checked before anything else and is never re-verified — so if the endpoint is deleted, renamed or deactivated after a URL was cached, every subsequent call in that process quietly degrades to the scheduler fallback and pays the full `timeout` for it. Nothing in the payload names the cause; you just notice `method` stopped being `sync_rest_api`.

`snow_redeploy_script_endpoint` exists for exactly this. Clearing that cache is the first thing it does, before it re-runs the deploy and hands back every step it tried:

```javascript
snow_redeploy_script_endpoint({})                    // soft: clear cache, re-verify, redeploy if needed
snow_redeploy_script_endpoint({ hard_reset: true })  // delete definition + operations, then deploy fresh
```

Reach for the soft form when `method` degrades or when a UI-policy tool starts failing. Reach for `hard_reset` only when the soft form's diagnostics show a definition that exists but cannot be made to answer. The `diagnostics` array is the actual value of this tool — it names which record was found or created, whether an old operation was rewritten, and which candidate URLs were pinged.

One more repair happens silently inside the deploy: an operation installed by an older Serac that lacks the `SERAC_EXEC_GUARD_V1` marker in its script is rewritten in place with the role check. An instance that received the endpoint before the guard shipped is hardened the next time any tool touches it.

## Parameters that do less than they look like

| Parameter | What it actually does |
|---|---|
| `runAsUser` | Read, echoed into the confirmation prompt, and **never sent anywhere**. Your script always runs as the account Serac authenticated with. If identity matters, assert it in the script: `gs.info(gs.getUserName())`. |
| `scope` | Accepted (`global` / `rhino`) and ignored by the executor. |
| `timeout` | Bounds the fallback's polling loop only. It does not cap a long sync execution — the ceiling there is the HTTP client's 60s timeout. |
| `validate_es5` | Adds a warning string. Never blocks. |
| `allowDataModification` | Feeds the wording of the security analysis. Nothing is blocked either way. |

`security_analysis` in the response is a regex scan of the script text (`.insert()`, `.update()`, `eval(`, and friends) producing a LOW/MEDIUM/HIGH label. It is a summary aid for a human, not a gate.

### The confirmation flow

`requireConfirmation: true` returns a prompt instead of executing and points you at `snow_confirm_script_execution`. Prefer not to use it: the prompt payload contains no `execution_id` for the follow-up call to reuse, `snow_confirm_script_execution` always takes the scheduled-job path (never the fast endpoint), and it writes its marker as `SNOW_FLOW_CONFIRM_<id>` — which `snow_get_script_output` does not look for, so its pending branch has no recovery route. Get the user's approval in conversation, then call `snow_execute_script` normally.

## Five other tools deploy the same endpoint

Script execution is shared machinery. These also install and use the endpoint:

`snow_create_ui_policy` · `snow_create_ui_policy_action` · `snow_elevate_role` · `snow_sir_evidence_manage` · `snow_kms_manage`

Two consequences. If a UI-policy create fails in a way that looks like a permissions problem, the failing thing may be the executor endpoint rather than the policy — `snow_redeploy_script_endpoint` is the check. And on an instance where you never called `snow_execute_script`, a `sys_ws_definition` named *Serac Script Executor* may still appear; one of these tools put it there.

## Update sets, and the guard that does not fire

`snow_execute_script` is classified `subcategory: script-execution`, which is exempt from the update-set guard — running a script is an action, not a configuration change, so the tool never asks you for an update set.

The endpoint deploy underneath it is a different matter. `sys_ws_definition` and `sys_ws_operation` are application files, and they are created with whatever update set is current for the integration user at that moment. So:

- If a named update set is active, **the Serac executor endpoint is now inside the customer's update set** and will be promoted along with their change unless you take it out.
- If none is active, the two records land in Default, where the promotion you think you are managing cannot see them.

Check it before you complete a set:

```javascript
snow_query_table({
  table: "sys_update_xml",
  query: "update_set=<update set sys_id>^nameSTARTSWITHsys_ws_",
  fields: ["name", "target_name", "type"],
})
```

On production there is a separate, working gate: `snow_execute_script` is a write tool, so a production-classified instance blocks it until you have surfaced the script to the user and re-issued the identical call with `__confirmProd: true`.

## Where the output is not

No Serac *execution* is recorded in `sys_script_execution_history`. That table is populated by the *Scripts - Background* module, and only when **Record for rollback?** was ticked in that UI ([ServiceNow docs](https://www.servicenow.com/docs/bundle/yokohama-platform-administration/page/administer/table-administration/task/background-script-recovery.html)). Nothing Serac runs goes through that module, so `snow_get_logs` with `log_table="sys_script_execution_history"` is the right call for a human's background script and the wrong call for anything you executed.

You may still find rows there with Serac's fingerprints on them: `snow_test_integration` POSTs records *into* that table through the Table API. Writing a row to a log table executes nothing — those rows record that a tool inserted a record, not that a script ran. Do not read them as output, and do not let `snow_get_script_output` read them as output either.

For Serac's own runs the order is `data.output` from the call itself, then `snow_get_script_output` for a pending fallback, then `snow_get_logs` on `syslog` for whatever the script logged outside the four captured methods.

## Failure quick reference

| What you see | What it means | Move |
|---|---|---|
| `data.success: false`, `method: sysauto_script_with_trigger` | The script threw in the scheduler. The sync path was either skipped or answered 500 by running it first, so it **may** have run more than once. | Fix the script, and check whether a partial write landed. |
| `data.success: true`, `method: sysauto_script_with_trigger` | The endpoint was skipped; the job ran and the poll caught it. Output is real. | Find out why the sync path was skipped — `snow_redeploy_script_endpoint` first. |
| `method: scheduled_job_pending` | Records created, poll expired. Execution status unknown. | `snow_get_script_output({ execution_id })` before anything else. |
| `fallback_warning` mentions "lacks web_service_admin / admin rights" | Neither the endpoint nor the job could be created. | Check the integration user's roles; nothing ran. |
| Every call is slow and `method` is never `sync_rest_api` | Cached URL points at an endpoint that is gone, or the caller is not admin. | `snow_redeploy_script_endpoint({})` and read `diagnostics`. |
| Deploy says "no candidate URL responded with success=true" | Either genuinely unroutable, or the endpoint answered 403 because the caller lacks `admin`. | Check roles first; `hard_reset: true` only after that. |
