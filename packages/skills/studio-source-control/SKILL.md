---
name: studio-source-control
description: Drive a scoped application's linked git repository from the instance — what has to be true before Source Control works at all, the commit-then-push order, stashes and branches over /api/sn_source_control, and when this replaces update sets rather than sitting next to them.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_source_control
  - snow_track_deployment
  - snow_velocity_tracking
  - snow_get_devops_insights
  - snow_create_devops_pipeline
  - snow_create_devops_change
  - snow_query_table
---

# Studio Source Control

A scoped application can be linked to a git repository, after which its records are committed and pushed
like code. `snow_source_control` drives that over `/api/sn_source_control`.

This is not the Fluent toolchain. The `fluent-*` skills are about building an app from a local SDK
project; this is the platform's own git integration, reached from inside the instance. Both end up in a
repository and they are different routes.

## Before it works at all

Source Control fails in ways that look like tool bugs when any of these is missing. Check them first:

1. **The app is scoped.** Global-scope artefacts cannot be linked. `sys_app` with a scope like
   `x_company_module`.
2. **The app is linked to a repository.** Done once, in Studio (`Source Control → Link to Source
   Control`). Nothing here creates the link.
3. **Credentials exist on the instance.** A `sys_repo_credential` record holding the repo credential —
   a PAT for GitHub/GitLab, not a password. Pass its alias as `credentials_alias` when the remote needs
   auth.
4. **The Source Control plugin is active** and the instance can reach the remote outbound. On a
   restricted network that means a MID server, and the failure is a timeout rather than a 401.

Confirm the link before anything else:

```javascript
await snow_query_table({ table: "sys_app", query: "scope=x_acme_ops",
                         fields: "sys_id,name,scope,sys_class_name" })
await snow_source_control({ action: "status", app_scope: "x_acme_ops" })
```

`status` on an unlinked app is the fastest way to find out you are not where you think you are.

## Commit, then push — they are separate

The order is git's, not ServiceNow's, and the tool does not merge the two:

```javascript
// 1. what changed in the working copy
await snow_source_control({ action: "status", app_scope: "x_acme_ops" })

// 2. commit it locally, with a message
await snow_source_control({ action: "commit", app_scope: "x_acme_ops",
                            commit_message: "fix: widen the assignment lookup" })

// 3. and only then send it to the remote
await snow_source_control({ action: "push", app_scope: "x_acme_ops", credentials_alias: "acme-github" })
```

A commit that is never pushed lives only on that instance. This is the most common confusion: the change
looks committed, the repository does not have it, and a second developer's `pull` overwrites it.

`pull` applies remote changes onto the working copy. Pull before you start, not after you have edited —
a conflict here is resolved record by record in the UI, not by the tool.

## Branches and stashes

```javascript
await snow_source_control({ action: "branch", branch_action: "list", app_scope: "x_acme_ops" })
await snow_source_control({ action: "branch", branch_action: "create",
                            branch_name: "feature/wider-lookup", from_branch: "main",
                            app_scope: "x_acme_ops" })
await snow_source_control({ action: "branch", branch_action: "switch",
                            branch_name: "feature/wider-lookup", app_scope: "x_acme_ops" })
```

**Switching a branch changes the records on the instance.** This is the part that has no local-git
equivalent: there is one working copy and it *is* the application on that instance. Switching branches
mid-session changes what every other user of that instance sees. Do it on a development instance, never
on one anybody is testing against.

`stash` is the escape hatch when a switch refuses because the working copy is dirty:

```javascript
await snow_source_control({ action: "stash", stash_action: "create", stash_name: "wip",
                            stash_message: "half-done lookup change", app_scope: "x_acme_ops" })
// … switch, do something else, switch back …
await snow_source_control({ action: "stash", stash_action: "apply", stash_name: "wip",
                            app_scope: "x_acme_ops" })
```

`diff` takes an optional `record_sys_id` for one record, or nothing for the whole working copy. Read it
before committing — the working copy contains every change any user made on that instance since the last
commit, not only yours.

## Source control or update sets

Not both for the same artefacts. Pick per application:

| | Source control | Update sets |
| --- | --- | --- |
| Scope | one scoped app | anything, including global |
| Unit | a commit | a set of `sys_update_xml` rows |
| History | the repository's | the instance's |
| Merging | git merge, per branch | last write wins on retrieve |
| Rollback | check out an earlier commit | back out the set |

An app under source control should not also be moved by update sets — you get two histories that disagree
about what shipped, and an update set applied over a linked app leaves the working copy dirty against a
commit nobody made.

Global-scope work stays on update sets regardless; it cannot be linked. Most real instances therefore run
both, on different artefacts. `update-set-workflow` covers that half.

## The DevOps tools around it

`snow_track_deployment`, `snow_create_devops_pipeline`, `snow_create_devops_change`,
`snow_get_devops_insights` and `snow_velocity_tracking` sit on the `sn_devops_*` tables. They record and
report on deployments — they do not perform them, and they are independent of whether the app is linked
to a repository. Reach for them when the question is "what shipped and when", not "put this code
somewhere".

## Verify before you trust it

The tool's own description says its paths are best-effort against the published Source Control REST docs
and want live-instance verification. That is accurate, and it shows in the implementation: `status`,
`branch list` and `stash list` fall back to reading `sys_repo_status`, `sys_repo_branch` and
`sys_repo_stash` directly when the REST path 404s, because some releases expose them as records instead.

Practically: run `status` first on any instance you have not used this on. If it comes back from the
fallback path, the read actions work and the write actions are the ones to try carefully — commit
something trivial and check the repository before relying on `push` in a pipeline.

## Related

- `update-set-workflow` — the other way to move changes, and the right one for global scope.
- `scoped-apps` — what makes an application scoped in the first place.
- `fluent-development` — building an app from a local SDK project, a different route to the same repo.
