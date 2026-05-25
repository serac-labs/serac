---
name: notification-events
description: Use ServiceNow events (sysevent) — gs.eventQueue dispatch, sysevent_register definitions, sysevent_script_action handlers, delayed events with process_on, and reminder/state-change patterns.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_create_event
  - snow_query_table
  - snow_find_artifact
  - snow_execute_script_with_output
---

# Notification Events for ServiceNow

Events trigger notifications, scripts, and workflows in ServiceNow.

## Event Architecture

```
gs.eventQueue() → Event Queue (sysevent)
    ↓
Event Registry (sysevent_register)
    ↓
Script Actions (sysevent_script_action)
Notifications (sysevent_email_action)
```

## Key Tables

| Table                    | Purpose             |
| ------------------------ | ------------------- |
| `sysevent`               | Event queue         |
| `sysevent_register`      | Event registry      |
| `sysevent_script_action` | Script actions      |
| `sysevent_email_action`  | Email notifications |

## Creating Events (ES5)

### Register Event

```javascript
// Register event in sysevent_register (ES5 ONLY!)
var event = new GlideRecord("sysevent_register")
event.initialize()

event.setValue("event_name", "x_myapp.incident.escalated")
event.setValue("table", "incident")
event.setValue("description", "Fired when an incident is escalated")
event.setValue("fired_by", "Business Rules, Scripts")

// Parameters
event.setValue("parm1", "escalation_level")
event.setValue("parm2", "previous_group")

event.insert()
```

### Queue Event

```javascript
// Queue event from script (ES5 ONLY!)
// gs.eventQueue(event_name, gr, parm1, parm2)

// In a Business Rule
;(function executeRule(current, previous) {
  // Check if escalated
  if (current.escalation.changesTo("1")) {
    gs.eventQueue(
      "x_myapp.incident.escalated",
      current,
      current.getValue("escalation"),
      previous.assignment_group.getDisplayValue(),
    )
  }
})(current, previous)
```

### Event Parameters

```javascript
// Access event parameters in script action (ES5 ONLY!)
// event.parm1 = first parameter
// event.parm2 = second parameter

// In Script Action
;(function executeEvent(event) {
  var escalationLevel = event.parm1
  var previousGroup = event.parm2

  var incident = event.getGlideRecord()

  gs.info(
    "Incident " + incident.getValue("number") + " escalated to level " + escalationLevel + " from " + previousGroup,
  )

  // Perform action based on event
  if (escalationLevel === "1") {
    notifyManager(incident)
  } else if (escalationLevel === "2") {
    notifyDirector(incident)
  } else if (escalationLevel === "3") {
    notifyVP(incident)
  }
})(event)
```

## Script Actions (ES5)

### Create Script Action

```javascript
// Create script action for event (ES5 ONLY!)
var action = new GlideRecord("sysevent_script_action")
action.initialize()

action.setValue("name", "Handle Incident Escalation")
action.setValue("event_name", "x_myapp.incident.escalated")
action.setValue("active", true)

// Condition (optional)
action.setValue("condition", "event.parm1 >= 2")

// Script (ES5 ONLY!)
action.setValue(
  "script",
  "(function executeEvent(event) {\n" +
    "    var incident = event.getGlideRecord();\n" +
    "    var escalationLevel = event.parm1;\n" +
    "    \n" +
    "    // Create escalation task\n" +
    '    var task = new GlideRecord("task");\n' +
    "    task.initialize();\n" +
    "    task.parent = incident.getUniqueValue();\n" +
    '    task.short_description = "Review escalated incident";\n' +
    "    task.assignment_group = getEscalationGroup(escalationLevel);\n" +
    "    task.insert();\n" +
    "    \n" +
    '    gs.info("Created escalation task for " + incident.number);\n' +
    "})(event);",
)

action.insert()
```

### Delayed Event

```javascript
// Queue event with delay (ES5 ONLY!)
// Will be processed after specified time

var delay = new GlideDateTime()
delay.addSeconds(3600) // 1 hour delay

var event = new GlideRecord("sysevent")
event.initialize()
event.setValue("name", "x_myapp.reminder.send")
event.setValue("instance", recordSysId)
event.setValue("table", "incident")
event.setValue("parm1", "first_reminder")
event.setValue("parm2", "")
event.setValue("claimed", false)
event.setValue("process_on", delay)
event.insert()
```

## Email Notifications (ES5)

### Create Email Action

```javascript
// Create notification for event (ES5 ONLY!)
var notification = new GlideRecord("sysevent_email_action")
notification.initialize()

notification.setValue("name", "Incident Escalation Notification")
notification.setValue("event_name", "x_myapp.incident.escalated")
notification.setValue("active", true)

// Recipients
notification.setValue("recipient_users", "")
notification.setValue("recipient_groups", getGroupSysId("IT Management"))
notification.setValue("send_self", false)

// Use event.parm1 to get escalation manager
notification.setValue("recipient_fields", "assignment_group.manager")

// Email content
notification.setValue("subject", "Incident ${number} Escalated - Level ${event.parm1}")
notification.setValue(
  "message_html",
  "<p>Incident <b>${number}</b> has been escalated.</p>" +
    "<p>Short Description: ${short_description}</p>" +
    "<p>Escalation Level: ${event.parm1}</p>" +
    "<p>Previous Group: ${event.parm2}</p>" +
    '<p><a href="${URI_REF}">View Incident</a></p>',
)

notification.insert()
```

### Conditional Notification

```javascript
// Notification with advanced condition (ES5 ONLY!)
var notification = new GlideRecord("sysevent_email_action")
notification.initialize()
notification.setValue("name", "VIP Incident Alert")
notification.setValue("event_name", "incident.created")

// Advanced condition script
notification.setValue("advanced_condition", true)
notification.setValue("condition", "current.caller_id.vip == true && current.priority <= 2")

// Send to specific recipients for VIP
notification.setValue("recipient_groups", getGroupSysId("VIP Support"))

notification.insert()
```

## Common Event Patterns (ES5)

### Reminder Event

```javascript
// Schedule reminder events (ES5 ONLY!)
function scheduleReminder(tableName, recordSysId, reminderType, delayMinutes) {
  var eventTime = new GlideDateTime()
  eventTime.addSeconds(delayMinutes * 60)

  var reminder = new GlideRecord("sysevent")
  reminder.initialize()
  reminder.setValue("name", "x_myapp.reminder")
  reminder.setValue("instance", recordSysId)
  reminder.setValue("table", tableName)
  reminder.setValue("parm1", reminderType)
  reminder.setValue("process_on", eventTime)
  reminder.insert()

  return reminder.getUniqueValue()
}

// Cancel scheduled reminder
function cancelReminder(eventSysId) {
  var reminder = new GlideRecord("sysevent")
  if (reminder.get(eventSysId)) {
    reminder.deleteRecord()
    return true
  }
  return false
}
```

### Batch Processing Event

```javascript
// Queue batch processing (ES5 ONLY!)
// Business Rule: after, insert, u_import_batch

;(function executeRule(current, previous) {
  // Queue processing for each record in batch
  var record = new GlideRecord("u_import_record")
  record.addQuery("batch", current.getUniqueValue())
  record.query()

  while (record.next()) {
    gs.eventQueue("x_myapp.import.process_record", record, current.getUniqueValue(), "")
  }

  // Queue completion check
  var delay = new GlideDateTime()
  delay.addSeconds(300) // Check in 5 minutes

  var event = new GlideRecord("sysevent")
  event.initialize()
  event.setValue("name", "x_myapp.import.check_complete")
  event.setValue("instance", current.getUniqueValue())
  event.setValue("table", "u_import_batch")
  event.setValue("process_on", delay)
  event.insert()
})(current, previous)
```

### State Change Event

```javascript
// Generic state change event (ES5 ONLY!)
// Business Rule: after, update

;(function executeRule(current, previous) {
  if (current.state.changes()) {
    gs.eventQueue(
      "x_myapp." + current.getTableName() + ".state_change",
      current,
      previous.getValue("state"),
      current.getValue("state"),
    )
  }
})(current, previous)
```

## Event Debugging (ES5)

### Check Event Queue

```javascript
// Query pending events (ES5 ONLY!)
function getPendingEvents(eventName) {
  var events = []

  var event = new GlideRecord("sysevent")
  event.addQuery("name", eventName)
  event.addQuery("claimed", false)
  event.orderByDesc("sys_created_on")
  event.setLimit(100)
  event.query()

  while (event.next()) {
    events.push({
      sys_id: event.getUniqueValue(),
      name: event.getValue("name"),
      instance: event.getValue("instance"),
      parm1: event.getValue("parm1"),
      parm2: event.getValue("parm2"),
      process_on: event.getValue("process_on"),
      created: event.getValue("sys_created_on"),
    })
  }

  return events
}
```

## MCP Tool Integration

### Available Tools

| Tool                              | Purpose                   |
| --------------------------------- | ------------------------- |
| `snow_create_event`               | Queue events              |
| `snow_query_table`                | Query event queue         |
| `snow_find_artifact`              | Find event configurations |
| `snow_execute_script_with_output` | Test event scripts        |

### Example Workflow

```javascript
// 1. Queue an event
await snow_create_event({
  name: "x_myapp.test.event",
  table: "incident",
  instance: incidentSysId,
  parm1: "test_value",
})

// 2. Check event queue
await snow_query_table({
  table: "sysevent",
  query: "name=x_myapp.test.event^claimed=false",
  fields: "name,instance,parm1,parm2,process_on",
})

// 3. Find script actions
await snow_query_table({
  table: "sysevent_script_action",
  query: "event_nameLIKEx_myapp",
  fields: "name,event_name,active,condition",
})
```

## Best Practices

1. **Namespace Events** - Use app prefix (x_myapp.\*)
2. **Register Events** - Document in sysevent_register
3. **Meaningful Names** - Clear event purpose
4. **Parameters** - Use parm1/parm2 wisely
5. **Conditions** - Filter before processing
6. **Async Processing** - Don't block transactions
7. **Error Handling** - Handle script failures
8. **ES5 Only** - No modern JavaScript syntax
