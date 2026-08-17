---
name: debugging-mutations
description: Verify what changed on a ServiceNow instance after a tool call — sys_audit inspection, syslog/transaction logs, session context, Flow Designer execution logs, outbound HTTP traces.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_inspect_mutations
  - snow_get_logs
  - snow_get_script_output
  - snow_trace_execution
  - snow_get_flow_execution_logs
  - snow_get_inbound_http_logs
  - snow_get_outbound_http_logs
  - snow_audit_trail_analysis
  - snow_manage_flow
  - snow_session_context
---

# Debugging & Mutation Inspection

When you've executed a tool against a ServiceNow instance and need to verify what actually happened — or diagnose why something didn't — these tools answer "what really changed and why". Use them after the fact, never as a substitute for picking the right tool in the first place.

## Available debugging tools

| Tool | Purpose |
|---|---|
| `snow_inspect_mutations` | Inspect record changes (INSERT/UPDATE/DELETE) since a timestamp via `sys_audit` |
| `snow_get_logs` | Query platform logs with a time filter. Pass `log_table` to switch source: `syslog` (default), `syslog_app_scope` (scoped-app log), `syslog_transaction` (HTTP transactions), `sys_script_execution_history` (background-script traces) |
| `snow_session_context` | Dump the authenticated user, roles, current update set, domain. Use before ACL-sensitive debugging — "is this failing because I lack a role?" |
| `snow_get_script_output` | Output of previously executed scripts |
| `snow_trace_execution` | Server-side script execution tracing |
| `snow_get_flow_execution_logs` | Flow Designer execution history |
| `snow_get_inbound_http_logs` | Inbound REST API call logs |
| `snow_get_outbound_http_logs` | Outbound REST API call logs |
| `snow_audit_trail_analysis` | Audit trail analysis with anomaly detection |
| `snow_manage_flow` (with `verify=true`) | Verify a Flow Designer mutation immediately after running it |

## Self-debugging workflows

### Table API / REST changes (captured by sys_audit)

1. Note the current timestamp before the action — or use a relative window like `"30s"`
2. Execute the tool you want to verify
3. Call `snow_inspect_mutations` with `since=<timestamp>` or `since="30s"`
4. Review which records were INSERT/UPDATE/DELETE, which fields changed, old → new values
5. Compare expected vs. actual and adjust the calling code

### Flow Designer (NOT captured by sys_audit)

Flow Designer uses GraphQL mutations against `sys_hub_*` tables, which `sys_audit` does not record. Use the Flow Designer tool's own verification path instead:

1. Pass `verify=true` to any `snow_manage_flow` mutation action — you get automatic post-mutation verification
2. After publishing, call `snow_manage_flow action=check_execution flow_id=<id>` to inspect execution contexts, runs, and outputs
3. `check_execution` returns state, status, timing, errors, and output values from `sys_flow_context`, `sys_hub_flow_run`, and `sys_hub_flow_output`

## Picking the right tool

| Symptom | Tool to reach for |
|---|---|
| Script error | `snow_get_logs` with `level="error"` |
| Scoped-app log output | `snow_get_logs` with `log_table="syslog_app_scope"` |
| `snow_execute_script` ran, output lost | `snow_get_script_output` with the `execution_id` — see `background-script-execution` |
| A human's *Scripts - Background* run, output lost | `snow_get_logs` with `log_table="sys_script_execution_history"` (only holds runs where "Record for rollback?" was ticked; never holds a Serac execution) |
| Permission-denied / unexpected 403 | `snow_session_context` to verify caller's roles + update set |
| Did the flow mutation work? | `snow_manage_flow` with `verify=true` |
| What's the flow execution status? | `snow_manage_flow action=check_execution` |
| What did the Table API actually change? | `snow_inspect_mutations` with a time window |
| Operation FAILED — what happened? | `snow_inspect_mutations` with `include_syslog=true` and `include_transactions=true` |
| Flow never started? | `snow_get_flow_execution_logs` |
| Outbound REST call failed? | `snow_get_outbound_http_logs` |
| Who did what when? | `snow_audit_trail_analysis` |

## Important caveats

- **GraphQL mutations** (Flow Designer) are NOT captured by `sys_audit` — never expect to see them via `snow_inspect_mutations`. Use `verify=true` and `check_execution` instead.
- `sys_audit` only captures **successful** Table API / REST record changes. Failed operations leave no audit trail.
- For failed operations, check syslog (errors) and `sys_transaction_log` (HTTP 4xx/5xx responses).
- `sys_audit` field values are limited to **255 characters** — `snow_inspect_mutations` warns when values appear truncated.
- Use `snapshot_record` to fetch the current state of a record alongside the audit trail when you need the full picture.
- Use the `tables` filter to focus on specific tables and reduce noise when there's a lot of activity on the instance.

## Don't use these tools as a crutch

Debugging tools verify, they don't replace getting it right the first time. If you find yourself reaching for `snow_inspect_mutations` after every call, the underlying issue is usually:

- Picking `snow_execute_script` with raw GlideRecord instead of a dedicated tool
- Using placeholders (`"pending"`, `"TBD"`) where real sys_ids are required
- Skipping the Update Set, so changes were tracked into the wrong place

Fix the upstream pattern, then use these tools sparingly for the genuinely unclear cases.
