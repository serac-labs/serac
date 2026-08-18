---
name: acl-security
description: Create and debug ServiceNow ACLs (record, field, REST, script-include). Covers role/condition/script patterns, which ACL names can apply to a table or field, field-level visibility, and impersonation testing for row- and field-level security.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_acl_explain
  - snow_create_acl
  - snow_create_acl_role
  - snow_record_manage
  - snow_artifact_manage
  - snow_execute_script
  - snow_impersonate_user
  - snow_session_context
---

# ACL Security Patterns for ServiceNow

Access Control Lists (ACLs) are the foundation of ServiceNow security. They control who can read, write, create, and delete records.

## Which ACLs can apply

An ACL applies by name, and the name is literal — `sys_security_acl.name` holds `incident.priority` or `*`, never a glob pattern. For one field on a table that extends another, six names can each carry a rule:

| Name                | Carries the rule for                      |
| ------------------- | ----------------------------------------- |
| `incident.priority` | this field on this table                  |
| `task.priority`     | this field on a parent table              |
| `*.priority`        | a field of this name on any table         |
| `incident.*`        | any field on this table                   |
| `task.*`            | any field on a parent table               |
| `*.*`               | any field on any table                    |

Alongside them are the record-level names: `incident`, then each parent table in the `sys_db_object.super_class` chain, then `*`.

Two of those forms are confirmed against live instances: the record-level `*` (the ACL probe behind `sn-roles.manifest.json` resolved 189 tool primitives through it) and `table.field` (`snow_analyze_form` reads field ACLs with `nameSTARTSWITH<table>.`). The readings above for `*.priority`, `incident.*` and `*.*` follow the same naming scheme but are not sourced to ServiceNow's own documentation — treat them as names worth checking, not as documented behaviour. `snow_acl_explain` checks all of them either way, and a name nobody uses simply returns nothing.

Look at all of them. Stopping at `incident.priority` names the wrong blocker in exactly the case you are debugging — when the rule carrying the roles sits on `task` or on a wildcard.

`snow_acl_explain` collects the whole set in one call: it walks `sys_db_object.super_class` for the parent names, reads each matching rule's required roles out of the `sys_security_acl_role` m2m (there is no `roles` column on `sys_security_acl`, so anything reading one reports no roles at all), and diffs those against the roles a user holds in `sys_user_has_role` — which already includes inherited roles, so there is no need to expand `sys_user_role_contains` yourself.

Read that diff correctly. The roles on one rule are alternatives, so a rule's `roles_not_held` is the leftover half of `requires_roles`, never a list of roles to grant: if `user_holds` on that rule is non-empty, its role check already passes and the blocker is somewhere else — another level, or a condition or script the tool did not evaluate.

What it will not do is decide. Conditions and advanced scripts run inside the platform against one specific record and nothing over the REST Table API evaluates them, so read the output as "here is what applies and here is what the user holds", then confirm by impersonating. `snow_test_acl` claims to return the decision itself: it POSTs a record to `sys_script_execution` and reports the Table API's echo as if it were script output, and it ignores both its `operation` and its `user` argument. Don't use it.

## ACL Types

| Type                               | Controls              | Example                        |
| ---------------------------------- | --------------------- | ------------------------------ |
| **record**                         | Row-level access      | Can user see this incident?    |
| **field**                          | Field-level access    | Can user see assignment_group? |
| **client_callable_script_include** | Script Include access | Can user call this API?        |
| **ui_page**                        | UI Page access        | Can user view this page?       |
| **rest_endpoint**                  | REST API access       | Can user call this endpoint?   |

## Creating ACLs via MCP

`snow_create_acl` creates the ACL shell and nothing else. It takes `name`, `operation`, `type`, `admin_overrides` and `active`; there are no `roles`, `condition` or `script` arguments, and passing them anyway is silently ignored — they never reach `sys_security_acl`. An ACL left at that stage names no roles and carries no condition, which is the most permissive rule you can write. Set `active: false` until the other two steps are done.

```javascript
// 1. The shell — a record-level WRITE ACL on incident, created inactive.
snow_create_acl({
  name: "incident",
  operation: "write",
  type: "record",
  admin_overrides: true,
  active: false,
})

// 2. The roles. They live in the sys_security_acl_role m2m, one row per role, so
//    this is one call per role and each one needs that role's sys_id.
snow_query_table({ table: "sys_user_role", query: "nameINitil,incident_manager", fields: ["sys_id", "name"] })
snow_create_acl_role({ acl: "<acl sys_id>", role: "<itil sys_id>" })
snow_create_acl_role({ acl: "<acl sys_id>", role: "<incident_manager sys_id>" })

// 3. Condition and script are columns on the ACL record itself, with no argument
//    on snow_create_acl. Set them by updating the record, then activate it.
snow_record_manage({
  action: "update",
  table: "sys_security_acl",
  sys_id: "<acl sys_id>",
  data: { script: "answer = current.state < 6;", active: true },
})
```

Two roles on one ACL are alternatives — either one grants access under that rule — so step 2 widens the rule with each row, it does not narrow it.

`condition` and `script` are both real columns on `sys_security_acl` (`snow_analyze_form` reads them back). Write each in the form the ACL form's own Condition and Script fields expect.

A field-level rule is the same three steps with `name: "incident.priority"`.

Then check your work with `snow_acl_explain({ table: "incident", operation: "write", user: "<someone>" })` — it reads the roles back out of the m2m, which is the step most likely to have been skipped.

## Common ACL Patterns

### Pattern 1: Role-Based Access

```javascript
// Condition: (empty - role check only)
// Roles: itil, incident_manager
// Script: (empty)

// Users with itil OR incident_manager role can access
```

### Pattern 2: Ownership-Based Access

```javascript
// Condition:
current.caller_id == gs.getUserID() || current.assigned_to == gs.getUserID() || current.opened_by == gs.getUserID()

// User can access their own records
```

### Pattern 3: Group-Based Access

```javascript
// Script:
;(function () {
  var userGroups = gs.getUser().getMyGroups()
  answer = userGroups.indexOf(current.assignment_group.toString()) >= 0
})()

// User can access records assigned to their groups
```

### Pattern 4: Manager Chain Access

```javascript
// Script:
;(function () {
  var callerManager = current.caller_id.manager
  var currentUser = gs.getUserID()

  // Check if current user is in caller's management chain
  while (callerManager && !callerManager.nil()) {
    if (callerManager.toString() == currentUser) {
      answer = true
      return
    }
    callerManager = callerManager.manager
  }
  answer = false
})()
```

### Pattern 5: Time-Based Access

```javascript
// Script:
;(function () {
  var now = new GlideDateTime()
  var hour = parseInt(now.getLocalTime().getHourOfDayLocalTime())

  // Only allow access during business hours (8 AM - 6 PM)
  answer = hour >= 8 && hour < 18
})()
```

### Pattern 6: Data Classification

```javascript
// Script:
;(function () {
  var classification = current.u_data_classification.toString()
  var userClearance = gs.getUser().getRecord().getValue("u_security_clearance")

  var levels = { public: 0, internal: 1, confidential: 2, secret: 3 }
  answer = levels[userClearance] >= levels[classification]
})()
```

## Field-Level Security Patterns

### Hide Sensitive Fields

```javascript
// ACL: incident.u_ssn (Social Security Number)
// Operation: read
// Script:
answer = gs.hasRole("hr_admin")

// Only HR admins can see SSN field
```

### Read-Only After State Change

```javascript
// ACL: incident.short_description
// Operation: write
// Script:
answer = current.state < 6 // Can't edit after Resolved

// Prevent editing after resolution
```

### Conditional Field Visibility

```javascript
// ACL: incident.u_internal_notes
// Operation: read
// Condition:
gs.hasRole("itil") || current.caller_id == gs.getUserID()

// ITIL users see all, callers see their own
```

## Security Best Practices

### 1. Principle of Least Privilege

```javascript
// ❌ BAD - Too permissive
// Roles: (empty) - allows everyone

// ✅ GOOD - Explicit roles
// Roles: itil, incident_manager
```

### 2. Deny by Default

```javascript
// Create a catch-all deny ACL at lowest priority
// Name: *
// Operation: read
// Condition: false
// This ensures anything not explicitly allowed is denied
```

### 3. Avoid Complex Scripts

```javascript
// ❌ BAD - Complex script ACL (slow)
;(function () {
  var gr = new GlideRecord("sys_user_grmember")
  gr.addQuery("user", gs.getUserID())
  gr.query()
  while (gr.next()) {
    // Complex logic...
  }
})()

// ✅ GOOD - Use conditions when possible
// Condition: gs.getUser().isMemberOf(current.assignment_group)
```

### 4. Test ACLs Thoroughly

```javascript
// Use "Impersonate User" to test ACLs as different users
// Check: Navigation, List views, Forms, Related lists
// Verify: Fields hidden, buttons disabled, records filtered
```

Use `snow_impersonate_user` to generate an audited impersonation deep-link (admin-only, writes to `~/.serac/audit/impersonations.jsonl`). Use `snow_session_context` to confirm the caller's current roles and update set before diagnosing an ACL failure.

## Debug ACLs

### Enable ACL Debugging

```javascript
// In a background script or temporarily in your code:
gs.setProperty("glide.security.debug", "true")
gs.log("ACL Debug enabled")

// Check System Logs for ACL evaluation details
```

### Check User Permissions

```javascript
// Check if current user can read a record
var gr = new GlideRecord("incident")
gr.get("sys_id_here")

gs.info("Can Read: " + gr.canRead())
gs.info("Can Write: " + gr.canWrite())
gs.info("Can Delete: " + gr.canDelete())

// Check field-level
gs.info("Can read assignment_group: " + gr.assignment_group.canRead())
gs.info("Can write assignment_group: " + gr.assignment_group.canWrite())
```

## Common Mistakes

| Mistake                  | Problem               | Solution                            |
| ------------------------ | --------------------- | ----------------------------------- |
| No ACLs on custom tables | Anyone can access     | Create ACLs immediately             |
| Only role-based ACLs     | No row-level security | Add conditions for data segregation |
| Scripts that query DB    | Performance issues    | Use conditions or cache results     |
| Testing only as admin    | Admin bypasses ACLs   | Test as actual end users            |
| Forgetting REST APIs     | APIs bypass UI ACLs   | Create specific REST ACLs           |
