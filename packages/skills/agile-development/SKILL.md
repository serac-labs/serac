---
name: agile-development
description: ServiceNow Agile Development 2.0 — the rm_team → rm_sprint → rm_story → rm_epic model, the state and point values ServiceNow actually accepts, how a story is attached to a sprint, and the reporting tools (board, burndown, velocity, capacity, standup, retrospective).
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_agile_sprint_manage
  - snow_agile_sprint_query
  - snow_agile_sprint_board
  - snow_agile_sprint_burndown
  - snow_agile_story_manage
  - snow_agile_epic_manage
  - snow_agile_backlog_query
  - snow_agile_backlog_groom
  - snow_agile_team_manage
  - snow_agile_capacity_plan
  - snow_agile_velocity_report
  - snow_agile_standup_report
  - snow_agile_retrospective
  - snow_agile_release_manage
  - snow_create_project
  - snow_create_project_task
---

# Agile Development 2.0

Sixteen tools on `rm_*` and `pm_*`. This is the plugin-provided Agile module
(`com.snc.sdlc.agile.2.0`), not a generic task tracker — the tables are its own and the state values
are numbers behind friendly labels.

## Is the plugin even on?

Every table here comes from the plugin. If it is not activated, calls fail with "Invalid table", and the
tools say so with the plugin id rather than passing the raw error through. Cheapest check — a read that
needs no ids:

```javascript
await snow_agile_sprint_query({ limit: 1 })   // touches rm_sprint
```

An instance without the plugin has none of this and no amount of retrying helps.

## The model

```
rm_team          a scrum team, with a default velocity
  └── rm_team_member    one person on it, with a role
rm_sprint        a time box, optionally assigned to a team
rm_epic          a body of work spanning sprints
  └── rm_story        the unit of work. Points, state, assignee.
       └── rm_scrum_task   optional breakdown under a story
rm_release       groups sprints and epics for a ship date
```

Separately, `pm_project` / `pm_project_task` is **PPM**, a different product: waterfall-ish projects with
a manager and dates. `snow_create_project` and `snow_create_project_task` write there. Do not mix them
with the `rm_*` tables — a story is not a project task and nothing joins them.

## Order of operations

**Team → sprint → story.** Every link is a reference lookup that fails if the target is not there yet.

```javascript
// 1. team
const team = await snow_agile_team_manage({ action: "create", name: "Platform", velocity: 30 })
await snow_agile_team_manage({ action: "add_member", sys_id: team.sys_id,
                               member: "sam.patel", role: "scrum_master" })

// 2. sprint — the team is resolved by name or sys_id
await snow_agile_sprint_manage({ action: "create", name: "Sprint 24", team: "Platform",
                                 start_date: "2026-09-01", end_date: "2026-09-14", story_points: 30 })

// 3. stories, attached at creation or later
await snow_agile_story_manage({ action: "create", title: "Widen the assignment lookup",
                                story_points: 5, sprint: "Sprint 24", state: "Ready" })
```

Two things the schema does not tell you:

- **A sprint's name is written to `short_description`.** `rm_sprint` has no `name` column; the tool maps
  it. Query on `short_description`, not `name`.
- **`team` is stored as `assignment_group`.** The tool resolves the team through `rm_team` and writes the
  sys_id into the sprint's `assignment_group`. A sprint with no team is legal — omit the parameter.

## The values ServiceNow accepts

Story state is a friendly label in the tool and a number on the record:

| Label | `rm_story.state` |
| --- | --- |
| `Draft` | `-6` |
| `Ready` | `-5` |
| `Work In Progress` | `2` |
| `Testing` | `-2` |
| `Closed Complete` | `3` |
| `Closed Incomplete` | `4` |

Pass the label — a raw number is not translated and lands as-is. Anything not in that table is dropped
silently rather than rejected, so a typo means the state simply does not change.

Sprint state is not a parameter at all. `action: "start"` writes `2`, `action: "close"` writes `3`.
There is no "reopen".

**Story points are a Fibonacci-ish scale**: 1, 2, 3, 5, 8, 13, 21. The field is a plain number and will
take 7; every report that buckets by points then has an off-scale bucket. Estimate on the scale.

**Priority is 1–4**, Critical through Low, on both stories and epics — the ITSM 1–5 convention does not
apply here.

## Attaching a story to a sprint

`sprint` on `snow_agile_story_manage` accepts a **sprint sys_id or number**, and the tool resolves it
through `rm_sprint` before writing. Same for `epic`. That means:

- A sprint that does not exist yet is a failed lookup, not an auto-create.
- Moving a story between sprints is an `update` with the new `sprint`, not a delete and recreate — the
  points history stays with the story, which is what burndown reads.

For more than one story, use the grooming tool instead of a loop:

```javascript
await snow_agile_backlog_groom({ action: "assign_sprint", sprint: "Sprint 24",
                                 stories: [{ sys_id: storyA }, { sys_id: storyB }, { sys_id: storyC }] })
await snow_agile_backlog_groom({ action: "estimate",
                                 stories: [{ sys_id: storyA, story_points: 8 }] })
```

`stories` is always an array of **objects** with `sys_id` required, even for the actions that carry their
target in a separate parameter — a bare array of sys_ids is rejected. `priority`, `story_points` and
`order` go on the item; `sprint` and `epic` go on the call.

Its four actions are `reprioritize`, `estimate`, `assign_sprint` and `move_epic` — the four things
grooming actually is. Each story is patched independently and the response carries a per-story
`updated` / `skipped` / `error` status, so a partial failure is visible rather than fatal.

## Reading a board

```javascript
// stories grouped by state column; falls back to the team's active sprint
await snow_agile_sprint_board({ team: "Platform", include_tasks: true })

// the backlog: unassigned or unestimated work is the useful filter
await snow_agile_backlog_query({ unassigned_only: true, has_points: false, limit: 50 })
```

`snow_agile_backlog_query` paginates with `limit`/`offset` and defaults to 25. A backlog is usually
longer than that — a result of exactly 25 means truncated.

## Reporting

Five tools that read and never write. They differ in what they need:

| Tool | Needs | Answers |
| --- | --- | --- |
| `snow_agile_sprint_burndown` | a sprint | ideal vs actual points per day, scope changes |
| `snow_agile_velocity_report` | a team | committed vs completed per sprint, last 6 |
| `snow_agile_capacity_plan` | a team | availability vs commitment, recommended capacity |
| `snow_agile_standup_report` | a team | who did what since yesterday, and blockers |
| `snow_agile_retrospective` | a sprint or team | planned vs completed, carry-over, defect rate |

`capacity_plan` averages velocity over `velocity_sprints` (3 by default), so on a team with fewer than
three closed sprints its recommendation is an average of very little. `retrospective` defaults to the
last *closed* sprint when no sprint is given — running it mid-sprint reports on the previous one, which
is usually what you want and occasionally a surprise.

Blockers come from the story: `blocked` and `blocked_reason` on `rm_story`. If standup reports no
blockers on a visibly stuck team, nobody is setting the flag — the report is accurate and the data is
not.

## Releases

```javascript
await snow_agile_release_manage({ action: "readiness", sys_id: releaseSysId })
```

`readiness` is the useful one: it reports story completion across the sprints and epics linked to the
release. `create`/`update` take a state from `Draft`, `Planning`, `In Progress`, `Released`, `Cancelled`.

## Related

- `update-set-workflow` — none of this is configuration. Stories and sprints are data; they are not
  captured in an update set and do not move between instances that way.
- `request-management` — the other place work items live, and a different set of tables entirely.
