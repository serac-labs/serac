---
name: gliderecord-patterns
description: Write efficient ServiceNow GlideRecord queries — addQuery vs addEncodedQuery, setLimit, GlideAggregate for counts, avoiding N+1 in loops, query operators, and safe CRUD with workflow control.
version: 1.0.0
tools:
  - snow_query_table
  - snow_execute_script_with_output
  - snow_discover_table_fields
---

# GlideRecord Best Practices for ServiceNow

GlideRecord is the primary API for database operations in ServiceNow. Following these patterns ensures efficient and secure queries.

## Basic Query Patterns

### Get Single Record by sys_id

```javascript
var gr = new GlideRecord("incident")
if (gr.get("sys_id_here")) {
  gs.info("Found: " + gr.getValue("number"))
}
```

### Get Single Record by Field

```javascript
var gr = new GlideRecord("sys_user")
if (gr.get("user_name", "admin")) {
  gs.info("Found user: " + gr.getValue("name"))
}
```

### Query Multiple Records

```javascript
var gr = new GlideRecord("incident")
gr.addQuery("active", true)
gr.addQuery("priority", "1")
gr.orderByDesc("sys_created_on")
gr.setLimit(100)
gr.query()

while (gr.next()) {
  gs.info(gr.getValue("number"))
}
```

## Encoded Queries (Faster)

Use encoded queries for complex conditions - they're more efficient than multiple addQuery calls:

```javascript
var gr = new GlideRecord("incident")
// Encoded query from list view URL or Query Builder
gr.addEncodedQuery("active=true^priority=1^assigned_toISEMPTY")
gr.query()

while (gr.next()) {
  // Process records
}
```

## Performance Tips

### 1. Always Use setLimit()

```javascript
// When you only need X records
var gr = new GlideRecord("incident")
gr.addQuery("active", true)
gr.setLimit(10) // Don't fetch more than needed
gr.query()
```

### 2. Use getValue() for Strings

```javascript
// CORRECT - Returns string value
var number = gr.getValue("number")

// ALSO WORKS but returns GlideElement
var element = gr.number
var numberStr = gr.number.toString()
```

### 3. Use getDisplayValue() for References

```javascript
// Get the display value of a reference field
var assignedToName = gr.getDisplayValue("assigned_to")

// Get the sys_id of a reference field
var assignedToId = gr.getValue("assigned_to")
```

### 4. Avoid Queries in Loops

```javascript
// BAD - Query inside loop
for (var i = 0; i < userIds.length; i++) {
  var gr = new GlideRecord("sys_user")
  gr.get(userIds[i]) // N queries!
}

// GOOD - Single query with IN clause
var gr = new GlideRecord("sys_user")
gr.addQuery("sys_id", "IN", userIds.join(","))
gr.query()
while (gr.next()) {
  // Process all users at once
}
```

### 5. Use GlideAggregate for Counts

```javascript
// BAD - Counting with GlideRecord
var count = 0
var gr = new GlideRecord("incident")
gr.addQuery("active", true)
gr.query()
while (gr.next()) {
  count++
}

// GOOD - Use GlideAggregate
var ga = new GlideAggregate("incident")
ga.addQuery("active", true)
ga.addAggregate("COUNT")
ga.query()
if (ga.next()) {
  var count = ga.getAggregate("COUNT")
}
```

## CRUD Operations

### Insert

```javascript
var gr = new GlideRecord("incident")
gr.initialize()
gr.setValue("short_description", "New incident")
gr.setValue("caller_id", gs.getUserID())
gr.setValue("priority", "3")
var sysId = gr.insert()
```

### Update

```javascript
var gr = new GlideRecord("incident")
if (gr.get("sys_id_here")) {
  gr.setValue("state", "6") // Resolved
  gr.setValue("close_notes", "Issue fixed")
  gr.update()
}
```

### Delete (Use with Caution!)

```javascript
var gr = new GlideRecord("incident")
if (gr.get("sys_id_here")) {
  gr.deleteRecord()
}
```

### Bulk Update

```javascript
var gr = new GlideRecord("incident")
gr.addQuery("state", "6") // Resolved
gr.addQuery("resolved_at", "<", gs.daysAgoStart(30))
gr.query()

while (gr.next()) {
  gr.setValue("state", "7") // Closed
  gr.update()
}
```

## Query Operators

| Operator     | Example                                                | Description           |
| ------------ | ------------------------------------------------------ | --------------------- |
| `=`          | `addQuery('active', true)`                             | Equals                |
| `!=`         | `addQuery('active', '!=', true)`                       | Not equals            |
| `>`, `<`     | `addQuery('priority', '<', '3')`                       | Greater/Less than     |
| `>=`, `<=`   | `addQuery('sys_created_on', '>=', gs.daysAgoStart(7))` | Greater/Less or equal |
| `CONTAINS`   | `addQuery('short_description', 'CONTAINS', 'error')`   | Contains string       |
| `STARTSWITH` | `addQuery('number', 'STARTSWITH', 'INC')`              | Starts with           |
| `ENDSWITH`   | `addQuery('email', 'ENDSWITH', '@company.com')`        | Ends with             |
| `IN`         | `addQuery('state', 'IN', '1,2,3')`                     | In list               |
| `NOT IN`     | `addQuery('state', 'NOT IN', '6,7')`                   | Not in list           |
| `ISEMPTY`    | `addQuery('assigned_to', 'ISEMPTY', '')`               | Field is empty        |
| `ISNOTEMPTY` | `addQuery('assigned_to', 'ISNOTEMPTY', '')`            | Field is not empty    |

## Security Considerations

1. **setWorkflow(false)** - Skip business rules for bulk operations
2. **setLimit()** - Prevent runaway queries
3. **Check canRead()/canWrite()** - Verify ACL permissions
4. **Never trust user input** - Validate before using in queries
