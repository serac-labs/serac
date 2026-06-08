---
name: acl-security
description: Create and debug ServiceNow ACLs (record, field, REST, script-include). Covers role/condition/script patterns, evaluation order, field-level visibility, and impersonation testing for row- and field-level security.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_review_access_control
  - snow_query_table
  - snow_find_artifact
  - snow_execute_script_with_output
  - snow_impersonate_user
  - snow_session_context
---

# ACL Security Patterns for ServiceNow

Access Control Lists (ACLs) are the foundation of ServiceNow security. They control who can read, write, create, and delete records.

## ACL Evaluation Order

ACLs are evaluated in this order (first match wins):

1. **Table.field** - Most specific (e.g., `incident.assignment_group`)
2. \*_Table._` - Table-level field wildcard
3. **Table** - Table-level record ACL
4. **Parent table ACLs** - If table extends another
5. `*` - Global wildcard (catch-all)

## ACL Types

| Type                               | Controls              | Example                        |
| ---------------------------------- | --------------------- | ------------------------------ |
| **record**                         | Row-level access      | Can user see this incident?    |
| **field**                          | Field-level access    | Can user see assignment_group? |
| **client_callable_script_include** | Script Include access | Can user call this API?        |
| **ui_page**                        | UI Page access        | Can user view this page?       |
| **rest_endpoint**                  | REST API access       | Can user call this endpoint?   |

## Creating ACLs via MCP

```javascript
// Table-level READ ACL
snow_create_acl({
  name: "incident",
  operation: "read",
  admin_overrides: true,
  active: true,
  roles: ["itil", "incident_manager"],
  condition: "current.active == true",
  script: "",
})

// Field-level WRITE ACL
snow_create_acl({
  name: "incident.priority",
  operation: "write",
  roles: ["incident_manager"],
  condition: "",
  script: "answer = current.state < 6;", // Only if not resolved
})
```

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
