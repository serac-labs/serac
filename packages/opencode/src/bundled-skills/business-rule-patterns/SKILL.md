---
name: business-rule-patterns
description: Write ServiceNow business rules (before/after/async/display) — current vs previous, changesTo/changesFrom, recursion avoidance, setAbortAction, and async dispatch for heavy work.
version: 1.0.0
tools:
  - snow_create_business_rule
  - snow_find_artifact
  - snow_edit_artifact
  - snow_execute_script_with_output
---

# Business Rule Best Practices for ServiceNow

Business Rules are server-side scripts that execute when records are displayed, inserted, updated, or deleted.

## When to Use Each Type

| Type        | Timing                    | Use Case                              | Performance Impact |
| ----------- | ------------------------- | ------------------------------------- | ------------------ |
| **Before**  | Before database write     | Validate, modify current record       | Low                |
| **After**   | After database write      | Create related records, notifications | Medium             |
| **Async**   | Background (after commit) | Heavy processing, integrations        | None (background)  |
| **Display** | When form loads           | Modify form display, set defaults     | Low                |

## Available Objects

```javascript
// In Business Rules, these are always available:
current // The record being operated on
previous // The record BEFORE changes (update/delete only)
gs // GlideSystem utilities
```

## Before Business Rules

Use for validation and field manipulation:

```javascript
// Prevent update if condition not met
;(function executeRule(current, previous) {
  if (current.state == 7 && previous.state != 6) {
    current.setAbortAction(true)
    gs.addErrorMessage("Must resolve before closing")
  }
})(current, previous)
```

```javascript
// Auto-populate fields
;(function executeRule(current, previous) {
  if (current.isNewRecord()) {
    current.setValue("caller_id", gs.getUserID())
    current.setValue("opened_by", gs.getUserID())
  }
})(current, previous)
```

**Never do in Before rules:**

- Call `current.update()` (causes recursion!)
- Query other tables (keep it fast)
- External API calls

## After Business Rules

Use for related record operations:

```javascript
// Create child record when priority is P1
;(function executeRule(current, previous) {
  if (current.priority.changesTo(1)) {
    var task = new GlideRecord("task")
    task.initialize()
    task.setValue("short_description", "P1 Follow-up: " + current.number)
    task.setValue("parent", current.sys_id)
    task.insert()
  }
})(current, previous)
```

```javascript
// Update parent record
;(function executeRule(current, previous) {
  var parent = new GlideRecord("problem")
  if (parent.get(current.problem_id)) {
    parent.setValue("related_incidents", parent.related_incidents + 1)
    parent.update()
  }
})(current, previous)
```

## Async Business Rules

Use for heavy processing that shouldn't block the transaction:

```javascript
// External integration
;(function executeRule(current, previous) {
  var integrator = new ExternalSystemIntegration()
  integrator.syncIncident(current.sys_id)
})(current, previous)
```

```javascript
// Send custom notification
;(function executeRule(current, previous) {
  gs.eventQueue("incident.priority.high", current, current.assigned_to, gs.getUserID())
})(current, previous)
```

## Useful Methods

### current Methods

```javascript
current.isNewRecord() // True if insert
current.isValidRecord() // True if record exists
current.getValue("field") // Get field value
current.setValue("field", val) // Set field value
current.setAbortAction(true) // Cancel the operation
current.operation() // 'insert', 'update', 'delete'
current.isActionAborted() // Check if aborted
```

### Field Change Detection

```javascript
current.priority.changes() // Field changed (any value)
current.priority.changesTo(1) // Changed TO this value
current.priority.changesFrom(3) // Changed FROM this value
current.priority.nil() // Field is empty
```

### previous Comparisons

```javascript
// Check if field was modified
if (current.state != previous.state) {
  gs.info("State changed from " + previous.state + " to " + current.state)
}

// Check specific change
if (current.assigned_to.changes() && !previous.assigned_to.nil()) {
  gs.info("Reassignment occurred")
}
```

## Condition Examples

Use conditions to limit when the rule runs:

| Condition                        | Meaning                    |
| -------------------------------- | -------------------------- |
| `current.active == true`         | Only active records        |
| `current.isNewRecord()`          | Only on insert             |
| `current.priority.changes()`     | Only when priority changes |
| `gs.hasRole('admin')`            | Only for admins            |
| `current.assignment_group.nil()` | Only when unassigned       |

## Performance Best Practices

1. **Use conditions** - Limit when the rule runs
2. **Keep Before rules fast** - No queries if possible
3. **Use Async for integrations** - Don't block transactions
4. **Avoid Display rules** - Slows form load
5. **Set Order** - Lower numbers run first (100-500 range)
6. **Check "when to run"** - insert, update, delete, query

## Common Patterns

### Auto-Assignment

```javascript
// Before Insert/Update
if (current.assignment_group.changes() && !current.assignment_group.nil()) {
  var members = new GroupMembers(current.assignment_group)
  current.assigned_to = members.getNextAvailable()
}
```

### Cascade Updates

```javascript
// After Update
if (current.state.changesTo(7)) {
  // Closed
  var tasks = new GlideRecord("task")
  tasks.addQuery("parent", current.sys_id)
  tasks.addQuery("state", "!=", 7)
  tasks.query()
  while (tasks.next()) {
    tasks.setValue("state", 7)
    tasks.update()
  }
}
```
