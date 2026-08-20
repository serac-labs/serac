---
name: classic-workflow
description: Read and change the classic Workflow engine (wf_workflow, wf_workflow_version, wf_activity, wf_transition, wf_context) — the checked-out-version model, running contexts, and when the right answer is to leave the workflow alone and build the new thing in Flow Designer.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_workflow_manage
  - snow_create_workflow
  - snow_create_workflow_activity
  - snow_workflow_transition
  - snow_start_workflow
  - snow_workflow_analyze
  - snow_query_table
---

# The Classic Workflow Engine

Flow Designer is what ServiceNow recommends and `flow-designer` is the skill for it. This is the other
engine — the one that still fulfils catalog items on most instances that have been live more than a few
years. `blast-radius` says outright that legacy workflows are not scanned, so an agent that cannot read
one is blind to a large part of what a record actually does.

Every tool here carries a `⚠️ LEGACY` marker in its description. That is guidance about what to *build*,
not permission to ignore what *exists*.

## The version model — read this before changing anything

This is the part that catches people out, and the tools do not hide it from you:

```
wf_workflow            the workflow's identity. Name, table, description. Almost no content.
   └── wf_workflow_version   THE ACTUAL WORKFLOW. One per checkout. Has `published`.
        ├── wf_activity      steps — belong to a VERSION, not to the workflow
        └── wf_transition    edges between activities — also per version
wf_context             one running instance of a published version against one record
```

**A workflow is not edited in place.** Checking it out creates a new `wf_workflow_version` with
`published = false`; you edit that; publishing flips it to `published = true` and retires the previous
one. Records already running keep executing the version they started on — which is why a fix does not
apply to work in flight, and why `wf_context` rows can point at versions nobody can find in the UI.

So the first question about any classic workflow is *which version*:

```javascript
await snow_query_table({
  table: "wf_workflow_version",
  query: "workflow.name=Standard Change Approval^published=true",
  fields: "sys_id,name,published,sys_updated_on",
})
```

### The trap in the write tools

`snow_create_workflow_activity` and `snow_start_workflow` both set the `workflow_version` field, and
both resolve a name by looking it up in **`wf_workflow`** — which returns a workflow sys_id, not a
version sys_id. `wf_activity.workflow_version` and `wf_context.workflow_version` reference
`wf_workflow_version`. Passing a name therefore points the new row at a version that does not exist.

Both parameters skip the lookup when you give them a 32-character hex sys_id, and that is the way to use
them: **resolve the version yourself and pass its sys_id.**

```javascript
const versions = await snow_query_table({ table: "wf_workflow_version",
                                          query: "workflow=" + workflowSysId + "^published=true",
                                          fields: "sys_id" })
const versionSysId = versions.records[0].sys_id

await snow_create_workflow_activity({ name: "Manager approval", workflowName: versionSysId,
                                      activityType: "approval", order: 100 })
```

Even done correctly, adding an activity to a *published* version edits a live workflow underneath running
contexts. The safe sequence is checkout → edit the unpublished version → publish, and checkout is a UI
operation. If you cannot check out, do not write.

## Reading one

`snow_workflow_manage` is the tool for everything except creation:

```javascript
await snow_workflow_manage({ action: "list", table: "sc_req_item" })     // what runs on this table
await snow_workflow_manage({ action: "get", workflow_id: "Standard Change Approval" })
await snow_workflow_manage({ action: "get_history", context_id: ctxSysId })
```

`get` returns the workflow with its activities and transitions — enough to describe the graph without
opening the UI. `list` filtered by table is the fastest answer to "what else fires on this record", and
the one `blast-radius` cannot give you.

## Running contexts

`wf_context` is one execution. It is where "the request is stuck" lives.

```javascript
// everything currently executing for a workflow
await snow_query_table({ table: "wf_context",
                         query: "workflow_version.workflow.name=Standard Change Approval^state=executing",
                         fields: "id,state,started,workflow_version" })

await snow_workflow_manage({ action: "stop", context_id: ctx })   // cancels the execution
await snow_workflow_manage({ action: "retry", context_id: ctx })  // re-runs the failed activity
```

`stop` cancels the run and leaves the record where it is — approvals already generated are not withdrawn
and the record's state is not rolled back. Cancelling a context is not undoing a workflow; there is no
such operation. Clean up whatever the workflow created separately.

`snow_workflow_analyze({ workflow_name, time_range_hours })` aggregates contexts over a window for error
and duration patterns. Use it before concluding a workflow is broken — "it never completes" is usually
one activity waiting on an approval nobody sees.

## Starting one

```javascript
await snow_start_workflow({ workflow_sys_id: versionSysId, table: "sc_req_item", record_sys_id: ritm })
```

It inserts a `wf_context` and returns. Workflows are asynchronous: a success here means the context was
created, not that anything ran. Poll `wf_context.state` rather than assuming.

Note the same version trap: pass a `wf_workflow_version` sys_id. If the call succeeds and nothing ever
runs, an unresolvable `workflow_version` is the first thing to check.

## When to leave it alone

Classic workflows are a poor place to add behaviour and a fine place to read it. Prefer the honest
answer when it applies:

- **The change is new behaviour.** Build it in Flow Designer, triggered on the same table, and leave the
  workflow untouched. Two engines on one record is normal on real instances.
- **The workflow is not the actual problem.** A catalog item that stalls is more often a missing approver
  or an inactive group than the graph.
- **You cannot check out.** Editing a published version under running contexts is not a change you can
  reason about.

The one case for editing it in place: the workflow is wrong *and* it must keep running for records that
are mid-flight. Then it is checkout → edit the version → publish, and every context started before the
publish keeps the old behaviour by design.

## Related

- `flow-designer` — `sys_hub_*`, the engine to build new automation in.
- `blast-radius` — does not scan classic workflows. `snow_workflow_manage({ action: "list", table })` is
  the manual step that fills that gap.
- `update-set-workflow` — a published workflow version is captured; a running context is not.
