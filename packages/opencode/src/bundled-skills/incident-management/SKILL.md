---
name: incident-management
description: Manage ServiceNow incidents — creation with impact/urgency priority calc, auto-assignment by category, reassignment tracking, major incident declaration with bridge calls, time-based escalation, MTTR metrics.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_incidents
  - snow_query_table
  - snow_find_artifact
  - snow_execute_script_with_output
---

# Incident Management for ServiceNow

Incident Management restores normal service operation as quickly as possible while minimizing business impact.

## Incident Lifecycle

```
New (1)
    ↓
In Progress (2)
    ↓ ← On Hold (3)
Resolved (6)
    ↓
Closed (7)

Cancelled (8) ← Can occur from New/In Progress
```

## Key Tables

| Table            | Purpose                 |
| ---------------- | ----------------------- |
| `incident`       | Incident records        |
| `incident_task`  | Sub-tasks for incidents |
| `incident_alert` | Related alerts          |
| `problem`        | Related problems        |

## Creating Incidents (ES5)

### Basic Incident Creation

```javascript
// Create incident (ES5 ONLY!)
var incident = new GlideRecord("incident")
incident.initialize()

// Required fields
incident.setValue("caller_id", callerSysId)
incident.setValue("short_description", "Email not working")
incident.setValue("description", "User cannot send or receive emails since this morning")

// Classification
incident.setValue("category", "software")
incident.setValue("subcategory", "email")
incident.setValue("impact", 2)
incident.setValue("urgency", 2)
// Priority is calculated automatically from impact/urgency

// Assignment
incident.setValue("assignment_group", getGroupSysId("Email Support"))

// Optional: affected CI
incident.setValue("cmdb_ci", emailServerSysId)

var incidentSysId = incident.insert()
gs.info("Created incident: " + incident.getValue("number"))
```

### Priority Matrix

```javascript
// Priority calculation (ES5 ONLY!)
// Priority = Impact x Urgency matrix
var priorityMatrix = {
  "1-1": 1, // High Impact + High Urgency = Critical
  "1-2": 2, // High Impact + Medium Urgency = High
  "1-3": 3, // High Impact + Low Urgency = Moderate
  "2-1": 2, // Medium Impact + High Urgency = High
  "2-2": 3, // Medium Impact + Medium Urgency = Moderate
  "2-3": 4, // Medium Impact + Low Urgency = Low
  "3-1": 3, // Low Impact + High Urgency = Moderate
  "3-2": 4, // Low Impact + Medium Urgency = Low
  "3-3": 5, // Low Impact + Low Urgency = Planning
}

function calculatePriority(impact, urgency) {
  var key = impact + "-" + urgency
  return priorityMatrix[key] || 4
}
```

## Incident Assignment (ES5)

### Auto-Assignment Rules

```javascript
// Assignment rule script (ES5 ONLY!)
// Business Rule: before, insert, incident

;(function executeRule(current, previous) {
  // Skip if already assigned
  if (current.assignment_group) {
    return
  }

  var group = determineAssignmentGroup(current)
  if (group) {
    current.assignment_group = group

    // Optionally assign to on-call
    var onCallUser = getOnCallUser(group)
    if (onCallUser) {
      current.assigned_to = onCallUser
    }
  }
})(current, previous)

function determineAssignmentGroup(incident) {
  var category = incident.getValue("category")
  var subcategory = incident.getValue("subcategory")

  // Category-based assignment
  var mapping = {
    network: "Network Support",
    hardware: "Desktop Support",
    "software-email": "Email Support",
    "software-erp": "ERP Support",
    database: "Database Admins",
  }

  var key = category
  if (subcategory) {
    key = category + "-" + subcategory
  }

  var groupName = mapping[key] || mapping[category] || "Service Desk"

  var group = new GlideRecord("sys_user_group")
  if (group.get("name", groupName)) {
    return group.getUniqueValue()
  }

  return null
}
```

### Reassignment with Tracking

```javascript
// Track reassignments (ES5 ONLY!)
// Business Rule: before, update, incident

;(function executeRule(current, previous) {
  // Check if assignment group changed
  if (current.assignment_group.changes()) {
    // Increment reassignment count
    var count = parseInt(current.getValue("reassignment_count"), 10) || 0
    current.reassignment_count = count + 1

    // Add work note
    current.work_notes =
      "Reassigned from " +
      previous.assignment_group.getDisplayValue() +
      " to " +
      current.assignment_group.getDisplayValue()

    // Alert if excessive reassignments
    if (count >= 3) {
      gs.eventQueue("incident.excessive.reassignments", current, count.toString(), "")
    }
  }
})(current, previous)
```

## Major Incident Management (ES5)

### Declare Major Incident

```javascript
// Declare major incident (ES5 ONLY!)
function declareMajorIncident(incidentSysId, reason) {
  var incident = new GlideRecord("incident")
  if (!incident.get(incidentSysId)) {
    return false
  }

  // Set major incident flag
  incident.setValue("major_incident_state", "confirmed")
  incident.setValue("priority", 1)

  // Set major incident fields
  incident.setValue("u_major_incident_start", new GlideDateTime())
  incident.setValue("u_major_incident_reason", reason)

  // Assign to Major Incident team
  var miTeam = new GlideRecord("sys_user_group")
  if (miTeam.get("name", "Major Incident Team")) {
    incident.setValue("assignment_group", miTeam.getUniqueValue())
  }

  // Add work note
  incident.work_notes = "MAJOR INCIDENT DECLARED\nReason: " + reason

  incident.update()

  // Trigger notifications
  gs.eventQueue("incident.major.declared", incident, "", "")

  // Create bridge call record
  createBridgeCall(incident)

  return true
}

function createBridgeCall(incident) {
  var bridge = new GlideRecord("u_bridge_call")
  bridge.initialize()
  bridge.setValue("u_incident", incident.getUniqueValue())
  bridge.setValue("u_dial_in", "1-800-555-0123")
  bridge.setValue("u_pin", generatePin())
  bridge.setValue("u_start_time", new GlideDateTime())
  bridge.insert()
}
```

### Major Incident Communication

```javascript
// Send major incident update (ES5 ONLY!)
function sendMajorIncidentUpdate(incidentSysId, updateText, recipientGroups) {
  var incident = new GlideRecord("incident")
  if (!incident.get(incidentSysId)) {
    return
  }

  // Add to work notes
  incident.work_notes = "MAJOR INCIDENT UPDATE:\n" + updateText
  incident.update()

  // Build recipient list
  var recipients = []
  for (var i = 0; i < recipientGroups.length; i++) {
    var members = getGroupMembers(recipientGroups[i])
    recipients = recipients.concat(members)
  }

  // Send notification
  var eventParams = JSON.stringify({
    update: updateText,
    recipients: recipients,
  })
  gs.eventQueue("incident.major.update", incident, eventParams, "")
}
```

## Incident Escalation (ES5)

### Time-Based Escalation

```javascript
// Escalation script for scheduled job (ES5 ONLY!)
;(function executeScheduledJob() {
  var LOG_PREFIX = "[IncidentEscalation] "

  // Find incidents needing escalation
  var now = new GlideDateTime()

  // P1 not acknowledged in 15 minutes
  escalateUnacknowledged("1", 15)

  // P2 not acknowledged in 30 minutes
  escalateUnacknowledged("2", 30)

  // P1 not resolved in 4 hours
  escalateUnresolved("1", 240)

  // P2 not resolved in 8 hours
  escalateUnresolved("2", 480)

  function escalateUnacknowledged(priority, minutes) {
    var threshold = new GlideDateTime()
    threshold.addSeconds(-minutes * 60)

    var gr = new GlideRecord("incident")
    gr.addQuery("priority", priority)
    gr.addQuery("state", 1) // New
    gr.addQuery("sys_created_on", "<", threshold)
    gr.addNullQuery("assigned_to")
    gr.query()

    while (gr.next()) {
      gs.info(LOG_PREFIX + "Escalating unacknowledged P" + priority + ": " + gr.number)
      gr.escalation = 1
      gr.work_notes = "Auto-escalated: Not acknowledged within " + minutes + " minutes"
      gr.update()
      gs.eventQueue("incident.escalation.unacknowledged", gr, priority, "")
    }
  }

  function escalateUnresolved(priority, minutes) {
    var threshold = new GlideDateTime()
    threshold.addSeconds(-minutes * 60)

    var gr = new GlideRecord("incident")
    gr.addQuery("priority", priority)
    gr.addQuery("state", "IN", "1,2") // New or In Progress
    gr.addQuery("sys_created_on", "<", threshold)
    gr.query()

    while (gr.next()) {
      var currentEsc = parseInt(gr.getValue("escalation"), 10) || 0
      if (currentEsc < 3) {
        gr.escalation = currentEsc + 1
        gr.work_notes = "Auto-escalated: Not resolved within target time"
        gr.update()
        notifyNextLevel(gr)
      }
    }
  }

  function notifyNextLevel(incident) {
    var group = incident.assignment_group.getRefRecord()
    if (group.manager) {
      gs.eventQueue("incident.escalation.manager", incident, group.manager, "")
    }
  }
})()
```

## Incident Resolution (ES5)

### Resolve Incident

```javascript
// Resolve incident with validation (ES5 ONLY!)
function resolveIncident(incidentSysId, resolution) {
  var incident = new GlideRecord("incident")
  if (!incident.get(incidentSysId)) {
    return { success: false, message: "Incident not found" }
  }

  // Validate state transition
  var currentState = incident.getValue("state")
  if (currentState === "6" || currentState === "7") {
    return { success: false, message: "Incident already resolved/closed" }
  }

  // Validate resolution fields
  if (!resolution.code) {
    return { success: false, message: "Resolution code is required" }
  }
  if (!resolution.notes) {
    return { success: false, message: "Resolution notes are required" }
  }

  // Update incident
  incident.setValue("state", 6) // Resolved
  incident.setValue("resolution_code", resolution.code)
  incident.setValue("close_notes", resolution.notes)
  incident.setValue("resolved_at", new GlideDateTime())
  incident.setValue("resolved_by", gs.getUserID())

  // Link to problem/known error if provided
  if (resolution.problem) {
    incident.setValue("problem_id", resolution.problem)
  }
  if (resolution.knowledge) {
    incident.setValue("u_resolution_article", resolution.knowledge)
  }

  incident.update()

  // Notify caller
  gs.eventQueue("incident.resolved", incident, "", "")

  return {
    success: true,
    message: "Incident resolved",
    number: incident.getValue("number"),
  }
}
```

## Incident Metrics (ES5)

### Calculate MTTR

```javascript
// Calculate Mean Time to Resolve (ES5 ONLY!)
function calculateMTTR(startDate, endDate, filters) {
  var ga = new GlideAggregate("incident")
  ga.addQuery("resolved_at", ">=", startDate)
  ga.addQuery("resolved_at", "<=", endDate)
  ga.addQuery("state", "IN", "6,7")

  // Apply optional filters
  if (filters.priority) {
    ga.addQuery("priority", filters.priority)
  }
  if (filters.category) {
    ga.addQuery("category", filters.category)
  }

  ga.addAggregate("AVG", "calendar_duration")
  ga.addAggregate("COUNT")
  ga.query()

  if (ga.next()) {
    var avgDuration = ga.getAggregate("AVG", "calendar_duration")
    var count = ga.getAggregate("COUNT")

    // Convert to hours
    var durationObj = new GlideDuration(avgDuration)
    var hours = durationObj.getNumericValue() / 3600000

    return {
      mttr_hours: Math.round(hours * 100) / 100,
      incident_count: parseInt(count, 10),
    }
  }

  return { mttr_hours: 0, incident_count: 0 }
}
```

## MCP Tool Integration

### Available Tools

| Tool                              | Purpose                    |
| --------------------------------- | -------------------------- |
| `snow_query_incidents`            | Query incident records     |
| `snow_query_table`                | Advanced incident queries  |
| `snow_execute_script_with_output` | Test incident scripts      |
| `snow_create_business_rule`       | Create incident automation |

### Example Workflow

```javascript
// 1. Query open P1 incidents
await snow_query_incidents({
  query: "priority=1^active=true",
  fields: "number,short_description,assigned_to,opened_at",
})

// 2. Check incident metrics
await snow_execute_script_with_output({
  script: `
        var stats = calculateMTTR(gs.beginningOfThisMonth(), gs.endOfThisMonth(), {});
        gs.info('MTTR: ' + stats.mttr_hours + ' hours');
    `,
})

// 3. Find unassigned incidents
await snow_query_table({
  table: "incident",
  query: "active=true^assigned_toISEMPTY",
  fields: "number,short_description,priority,assignment_group",
})
```

## Best Practices

1. **Clear Classification** - Proper category/subcategory
2. **Impact Assessment** - Accurate impact/urgency
3. **Assignment Rules** - Automated routing
4. **Escalation Paths** - Defined procedures
5. **Communication** - Regular updates
6. **Resolution Codes** - Consistent categorization
7. **Knowledge Linking** - Link to KB articles
8. **ES5 Only** - No modern JavaScript syntax
