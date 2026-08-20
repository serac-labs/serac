---
name: oncall-scheduling
description: Read and change ServiceNow on-call rotations — the cmn_rota → cmn_rota_roster → cmn_rota_member chain, how "who is on call right now" is resolved from a member window plus the schedule's time zone, and how escalation from an incident reaches it.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_oncall_manage
  - snow_create_schedule
  - snow_add_schedule_entry
  - snow_query_table
---

# On-Call Scheduling

"Who is on call for the database team?" is one question and four tables. Answering it by guessing at
table names is how agents end up querying `sys_user_group.manager` and reporting the wrong person.

## The chain

```
sys_user_group          the team being covered
   └── cmn_rota          a rotation on that group ("Database — primary")
        ├── cmn_schedule the hours the rotation covers, and its TIME ZONE
        └── cmn_rota_roster   a rotation pattern: weekly, 7 days, starting <date>
             └── cmn_rota_member   one person, with a from/to window
                  └── sys_user
```

Read it as: **a group has rotations, a rotation has rosters, a roster has members.** The roster is the
*pattern* (rotate weekly, one week each). The member row is one person's *turn* — it carries `from` and
`to` as `glide_date`, and `member` referencing `sys_user`.

A group can have several rotations at once — primary, secondary, escalation — and they are unrelated
records. "The on-call person" is never a property of the group.

## Who is on call right now

`snow_oncall_manage({ action: "get_current_oncall", rotation_sys_id })` resolves it in three steps, and
knowing them tells you what a wrong answer means:

1. Read `cmn_rota_roster` where `rota=<rotation>^active=true`.
2. Find the `cmn_rota_member` rows belonging to those rosters whose `from`/`to` window covers today.
3. Resolve `member` to a `sys_user`.

Two consequences worth having in front of you:

- **A rotation with no member window covering today returns nothing.** That is not an error; it is a
  rotation whose roster has run past its generated windows. The tool says so explicitly rather than
  guessing at the next person.
- **The dates are dates, and coverage is hours.** `cmn_rota_member.from`/`.to` are days. Whether the
  person is on call *at 03:00* is decided by the rotation's `cmn_schedule` — including its
  **time zone**, which is a field on the schedule and not on the rotation. A rotation whose schedule is
  in `US/Pacific` hands over at a different UTC moment than the same rotation in `Europe/Amsterdam`.
  Never convert on-call times yourself without reading `cmn_schedule.time_zone` first.

Full ServiceNow resolution goes through the `OnCallRotation` script include, which also applies
escalation order and time-off records. The tool's answer is the coverage row; if an instance has time-off
overrides in play, cross-check with that script include via `snow_execute_script` before paging anyone.

## Listing and swapping

```javascript
// Rotations for a group, by name or sys_id
await snow_oncall_manage({ action: "list_rotations", assignment_group: "Database" })

// Shifts in a window. Defaults to now → now + 7 days.
// Times are ServiceNow datetime format, UTC: "YYYY-MM-DD HH:MM:SS"
await snow_oncall_manage({ action: "list_shifts", rotation_sys_id: rota, end_time: "2026-09-01 00:00:00" })

// A one-off swap: reassign a member row from one person to another
await snow_oncall_manage({
  action: "swap_shift",
  roster_sys_id: memberRowSysId,     // a cmn_rota_member sys_id, despite the parameter name
  from_member_sys_id: currentUser,   // guard: refuses if the row does not hold this user
  to_member_sys_id: replacement,
})
```

Two traps in that last call:

- `roster_sys_id` takes a **`cmn_rota_member`** sys_id — the per-window assignment row, not a
  `cmn_rota_roster` sys_id. Take it from `list_shifts`, do not go looking for a roster.
- `reason` is accepted and **not persisted**. `cmn_rota_member` has no reason or override column; the
  tool echoes it back in the response and nothing on the instance records why the swap happened. If an
  audit trail matters, write a work note on whatever record prompted the swap.

A swap edits one window. It does not change the pattern — next rotation the original person is back on.

## Schedules underneath

`cmn_schedule` is shared machinery: SLAs, business-hours calculations and on-call rotations all point at
it. Build it before the thing that uses it.

```javascript
const sched = await snow_create_schedule({ name: "Follow the sun — EMEA", type: "weekly", time_zone: "Europe/Amsterdam" })

// Spans include or exclude time on top of the base schedule
await snow_add_schedule_entry({ schedule_sys_id: sched.sys_id, name: "Kings Day", type: "exclude",
                                start_date_time: "2026-04-27 00:00:00", end_date_time: "2026-04-27 23:59:59" })
```

`type: "exclude"` is how holidays and blackout windows are modelled — as a span that removes time, not by
editing the weekly pattern. `include` adds coverage the base pattern does not have. A schedule with no
spans covers nothing.

Changing a schedule changes every SLA that references it. Check before editing:

```javascript
await snow_query_table({ table: "contract_sla", query: "schedule=" + sched.sys_id, fields: "name,active" })
```

## Why anyone asks: escalation from an incident

The usual path is: a P1 lands on a group, nobody picks it up, and something has to page a human. That
"something" reads the group's rotation, not the group.

```javascript
// 1. the incident's assignment group
const inc = await snow_query_table({ table: "incident", query: "number=INC0012345",
                                     fields: "assignment_group,priority,state" })
// 2. its rotations
const rotas = await snow_oncall_manage({ action: "list_rotations",
                                         assignment_group: inc.records[0].assignment_group.value })
// 3. who is covering the primary one right now
const who = await snow_oncall_manage({ action: "get_current_oncall", rotation_sys_id: rotas.rotations[0].sys_id })
```

If step 2 comes back empty, the group has no rotation and there is no on-call person to find — the
honest answer is "this group is not on call", not the group's manager.

## Related

- `sla-management` — the other consumer of `cmn_schedule`, for business-hours SLA calculation.
- `incident-management` — what escalation does once it has the name.
