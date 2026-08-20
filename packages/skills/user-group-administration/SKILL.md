---
name: user-group-administration
description: Manage the principals ACLs apply to — sys_user, sys_user_group, sys_user_grmember and sys_user_has_role. Group before membership, inherited versus direct roles, why removing a role does not always remove the access, and deactivate rather than delete.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_user_manage
  - snow_role_group_manage
  - snow_get_user_roles
  - snow_manage_group_membership
  - snow_query_table
---

# Users, Groups and Roles

`acl-security` teaches the rules. This teaches the things the rules apply to. Without it an agent asked
to "add Sam to the change team" writes a background script against `sys_user_grmember`, which works
right up until it silently creates a second membership row.

## Four tables

| Table               | Holds                                    |
| ------------------- | ---------------------------------------- |
| `sys_user`          | people                                   |
| `sys_user_group`    | groups                                   |
| `sys_user_grmember` | one row per (user, group) membership      |
| `sys_user_has_role` | one row per (user, role) grant — direct **and** inherited |

There is no list of members on the group and no list of roles on the user. Both are join tables, and
both are where the work happens.

## Order of operations

**Group before membership, role before grant.** Every one of these is a reference field with no
auto-create behind it:

```javascript
// 1. the group
const grp = await snow_role_group_manage({ action: "create_group", name: "Database — Change",
                                           manager: managerSysId, description: "Owns DB change approvals" })

// 2. then people into it — takes sys_id, username OR email, so no lookup step
await snow_manage_group_membership({ action: "add", group_identifier: "Database — Change",
                                     user_identifier: "sam.patel@example.com" })

// 3. and a role onto the group, so membership grants it
await snow_role_group_manage({ action: "assign_role", role: roleSysId, group: grp.sys_id })
```

`snow_manage_group_membership` checks for an existing membership before inserting, which a hand-written
`GlideRecord.insert()` does not. Duplicate `sys_user_grmember` rows do not break access — they break
*removal*, because the remove path deletes one row and the user is still a member.

## Inherited versus direct: the part that bites

A role reaches a user two ways, and `sys_user_has_role` holds both:

- **Direct** — a row with `inherited = false`, created when someone grants the role to the person.
- **Inherited** — a row with `inherited = true`, created *by the platform* when the user joins a group
  that has the role, or when a role the user holds contains another role.

`snow_get_user_roles` returns every row on `sys_user_has_role` for the user, with display values. Read
the `inherited` flag on each one before concluding anything:

```javascript
const roles = await snow_get_user_roles({ user_id: userSysId })
const direct = roles.roles.filter((r) => r.inherited === "false")
```

**This is why removing a role does not always remove the access.** Revoke the direct grant and the user
still holds the role, because a group they are in also grants it — the inherited row is untouched and
was never yours to delete. Two rules follow:

1. Before revoking, look at *all* the rows for that role. If any is `inherited=true`, the fix is group
   membership, not the grant.
2. Never delete an `inherited=true` row by hand. The platform maintains those; it will recreate them,
   and in the meantime access does not change.

Role containment compounds this: `itil_admin` contains `itil`, so granting the first produces an
inherited `itil` row as well. Someone who "only has itil_admin" has both.

### One caution on `assign_role` with a group

`snow_role_group_manage({ action: "assign_role", group })` writes its row to **`sys_user_has_role`**.
On a stock instance the group→role join is `sys_group_has_role`, so verify what landed before you rely
on it:

```javascript
await snow_query_table({ table: "sys_group_has_role", query: "group=" + grp.sys_id, fields: "role,inherited" })
```

If that comes back empty after the call, grant the role to the group in the UI (Group → Roles related
list) instead and use the tool only for user grants.

## Deactivate, never delete

`snow_user_manage({ action: "deactivate", user_id })` sets `active = false`. That is the only removal
the tool offers, deliberately.

A `sys_user` record is referenced from every task the person ever touched — `opened_by`,
`assigned_to`, `sys_created_by`, every journal entry, every approval. Deleting it leaves those
references dangling and the history unreadable. Deactivating it blocks login, drops the user out of
assignment lookups, and keeps every reference intact.

Deactivation does **not** remove group memberships or roles. Those rows stay, which is correct — if the
person returns, or if an audit asks what access they had in March, the answer is still there. If access
must be provably gone as well, remove the memberships explicitly:

```javascript
const groups = await snow_query_table({ table: "sys_user_grmember", query: "user=" + userSysId,
                                        fields: "group" })
for (const row of groups.records) {
  await snow_manage_group_membership({ action: "remove", user_identifier: userSysId,
                                       group_identifier: row.group.value })
}
await snow_user_manage({ action: "deactivate", user_id: userSysId })
```

Same for groups: a group with history should be deactivated (`active = false`), not deleted. Deleting
one orphans every `sys_user_grmember` row pointing at it and every assignment that used it.

## Reading before writing

Two queries answer most "who can do X" questions without changing anything:

```javascript
// everyone in a group, with details
await snow_manage_group_membership({ action: "list", group_identifier: "Database — Change" })

// every group a user is in
await snow_query_table({ table: "sys_user_grmember", query: "user=" + userSysId, fields: "group" })
```

## Related

- `acl-security` — what the roles are checked against.
- `instance-security` — instance-level hardening; a different subject from who holds what.
- `domain-separation` — on a domain-separated instance, a group and its members live in a domain, and a
  membership across domains does not do what it looks like.
