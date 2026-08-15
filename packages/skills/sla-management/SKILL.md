---
name: sla-management
description: Configure ServiceNow SLAs — contract_sla definitions with start/stop/pause/cancel conditions, task_sla status checks, breach escalation, business-hours schedules, and compliance-rate aggregation.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_create_sla_definition
  - snow_query_table
  - snow_artifact_manage
  - snow_execute_script
---

# SLA Management for ServiceNow

SLA (Service Level Agreement) Management tracks and ensures service commitments are met.

## SLA Components

| Component          | Table        | Purpose                   |
| ------------------ | ------------ | ------------------------- |
| **SLA Definition** | contract_sla | SLA rules and conditions  |
| **Task SLA**       | task_sla     | SLA instance on a task    |
| **SLA Workflow**   | wf_workflow  | SLA breach notifications  |
| **SLA Schedule**   | cmn_schedule | Business hours definition |

## SLA Flow

```
Task Created
    ↓
SLA Definition Conditions Match
    ↓
Task SLA Record Created
    ↓
Timer Starts (based on schedule)
    ↓
SLA Stages: In Progress → Breached (if not met)
    ↓
Task Resolved/Closed
    ↓
SLA Achieved or Breached
```

## SLA Definition (ES5)

### Create SLA Definition

```javascript
// Create SLA Definition (ES5 ONLY!)
var sla = new GlideRecord("contract_sla")
sla.initialize()

// Basic info
sla.setValue("name", "P1 Incident Response Time")
sla.setValue("type", "SLA") // SLA, OLA, UC
sla.setValue("table", "incident")

// Target duration
sla.setValue("duration_type", "response") // response or resolution
sla.setValue("duration", "PT15M") // 15 minutes (ISO 8601)

// Conditions - when SLA attaches
sla.setValue("start_condition", "priority=1^active=true")
sla.setValue("stop_condition", "work_notes.changesTo()")
sla.setValue("pause_condition", "state=3") // Pause when On Hold
sla.setValue("cancel_condition", "state=8") // Cancel when Cancelled

// Schedule (business hours)
sla.setValue("schedule", getScheduleSysId("8-5 M-F"))

// Enable
sla.setValue("active", true)

sla.insert()
```

### SLA Conditions Explained

```javascript
// Start Condition: When SLA timer begins
// Example: P1 incidents when created
var startCondition = "priority=1^active=true^sys_created_onRELATIVEGT@minute@ago@0"

// Stop Condition: When SLA is achieved
// Example: When work notes are added (response) or resolved (resolution)
var responseStop = "work_notes.changes()"
var resolutionStop = "state=6^ORstate=7" // Resolved or Closed

// Pause Condition: Timer pauses
// Example: On Hold or Awaiting User Info
var pauseCondition = "state=3^ORstate=-5"

// Cancel Condition: SLA cancelled without breach
// Example: Incident cancelled or duplicate
var cancelCondition = "state=8^ORclose_code=Duplicate"
```

## Task SLA Operations (ES5)

### Query Task SLAs

```javascript
// Find SLAs for an incident (ES5 ONLY!)
var incidentSysId = "incident_sys_id"

var taskSla = new GlideRecord("task_sla")
taskSla.addQuery("task", incidentSysId)
taskSla.query()

while (taskSla.next()) {
  gs.info(
    "SLA: " +
      taskSla.sla.getDisplayValue() +
      " | Stage: " +
      taskSla.stage.getDisplayValue() +
      " | Breached: " +
      taskSla.getValue("has_breached") +
      " | Planned End: " +
      taskSla.getValue("planned_end_time"),
  )
}
```

### Check SLA Status

```javascript
// SLA Status Helper (ES5 ONLY!)
var SLAHelper = Class.create()
SLAHelper.prototype = {
  initialize: function () {},

  /**
   * Get SLA status for a task
   * @param {string} taskSysId - Task sys_id
   * @returns {Array} - Array of SLA status objects
   */
  getSLAStatus: function (taskSysId) {
    var slaStatuses = []

    var taskSla = new GlideRecord("task_sla")
    taskSla.addQuery("task", taskSysId)
    taskSla.addQuery("active", true)
    taskSla.query()

    while (taskSla.next()) {
      var now = new GlideDateTime()
      var plannedEnd = new GlideDateTime(taskSla.getValue("planned_end_time"))
      var timeLeft = GlideDateTime.subtract(now, plannedEnd)

      slaStatuses.push({
        name: taskSla.sla.getDisplayValue(),
        stage: taskSla.stage.getDisplayValue(),
        hasBreached: taskSla.getValue("has_breached") === "true",
        percentageComplete: taskSla.getValue("percentage"),
        plannedEnd: taskSla.getValue("planned_end_time"),
        timeLeft: this._formatDuration(timeLeft),
        isAtRisk: this._isAtRisk(taskSla),
      })
    }

    return slaStatuses
  },

  /**
   * Check if any SLA is at risk (>75% elapsed)
   */
  _isAtRisk: function (taskSla) {
    var percentage = parseFloat(taskSla.getValue("percentage"))
    return percentage >= 75 && taskSla.getValue("has_breached") !== "true"
  },

  _formatDuration: function (duration) {
    var totalSeconds = duration.getNumericValue() / 1000
    var hours = Math.floor(totalSeconds / 3600)
    var minutes = Math.floor((totalSeconds % 3600) / 60)
    return hours + "h " + minutes + "m"
  },

  type: "SLAHelper",
}
```

### Pause/Resume SLA

```javascript
// Pause SLAs when incident goes On Hold (ES5 ONLY!)
// Business Rule: after, update, incident

;(function executeRule(current, previous) {
  // Check if state changed to On Hold
  if (current.state.changesTo("3")) {
    pauseIncidentSLAs(current.getUniqueValue())
  }

  // Check if state changed from On Hold
  if (previous.state == "3" && current.state != "3") {
    resumeIncidentSLAs(current.getUniqueValue())
  }
})(current, previous)

function pauseIncidentSLAs(incidentId) {
  var taskSla = new GlideRecord("task_sla")
  taskSla.addQuery("task", incidentId)
  taskSla.addQuery("active", true)
  taskSla.addQuery("stage", "!=", "breached")
  taskSla.query()

  while (taskSla.next()) {
    var slaDef = new GlideRecord("contract_sla")
    if (slaDef.get(taskSla.getValue("sla"))) {
      // Only pause if SLA has pause condition
      if (slaDef.getValue("pause_condition")) {
        taskSla.pause = true
        taskSla.pause_time = new GlideDateTime()
        taskSla.update()
      }
    }
  }
}
```

## SLA Workflows

### Breach Notification Script (ES5)

```javascript
// SLA Workflow Activity: Send breach notification (ES5 ONLY!)
;(function executeActivity() {
  var taskSla = current
  var task = taskSla.task.getRefRecord()

  // Get escalation recipients
  var recipients = []

  // Add assigned user
  if (task.assigned_to) {
    recipients.push(task.assigned_to.getValue("email"))
  }

  // Add assignment group manager
  if (task.assignment_group) {
    var group = task.assignment_group.getRefRecord()
    if (group.manager) {
      recipients.push(group.manager.email)
    }
  }

  // Send notification
  if (recipients.length > 0) {
    gs.eventQueue("sla.breach.notification", task, recipients.join(","), taskSla.sla.getDisplayValue())
  }
})()
```

### SLA Escalation Rules

```javascript
// SLA Escalation Script Include (ES5 ONLY!)
var SLAEscalation = Class.create()
SLAEscalation.prototype = {
  initialize: function () {},

  /**
   * Escalate breached SLA
   */
  escalateBreached: function (taskSlaSysId) {
    var taskSla = new GlideRecord("task_sla")
    if (!taskSla.get(taskSlaSysId)) {
      return false
    }

    var task = taskSla.task.getRefRecord()

    // Increase priority
    var currentPriority = parseInt(task.getValue("priority"), 10)
    if (currentPriority > 1) {
      task.setValue("priority", currentPriority - 1)
    }

    // Set escalation flag
    task.setValue("escalation", 1)

    // Add work note
    task.work_notes = "SLA Breached: " + taskSla.sla.getDisplayValue() + "\nAutomatic escalation applied."

    task.update()

    // Notify on-call
    this._notifyOnCall(task)

    return true
  },

  _notifyOnCall: function (task) {
    // Get on-call schedule
    var oncall = new OnCallRotation()
    var onCallUser = oncall.getOnCallUser(task.assignment_group)

    if (onCallUser) {
      gs.eventQueue("sla.oncall.notification", task, onCallUser.sys_id, "")
    }
  },

  type: "SLAEscalation",
}
```

## SLA Reports

### SLA Compliance Query (ES5)

```javascript
// Calculate SLA compliance rate (ES5 ONLY!)
function getSLAComplianceRate(slaName, startDate, endDate) {
  var ga = new GlideAggregate("task_sla")
  ga.addQuery("sla.name", slaName)
  ga.addQuery("end_time", ">=", startDate)
  ga.addQuery("end_time", "<=", endDate)
  ga.addQuery("active", false) // Completed SLAs only
  ga.addAggregate("COUNT")
  ga.addAggregate("COUNT", "has_breached")
  ga.groupBy("has_breached")
  ga.query()

  var total = 0
  var breached = 0

  while (ga.next()) {
    var count = parseInt(ga.getAggregate("COUNT"), 10)
    total += count
    if (ga.getValue("has_breached") === "true") {
      breached = count
    }
  }

  if (total === 0) {
    return { compliance: 100, total: 0, breached: 0 }
  }

  var achieved = total - breached
  var compliance = Math.round((achieved / total) * 100 * 10) / 10

  return {
    compliance: compliance,
    total: total,
    achieved: achieved,
    breached: breached,
  }
}

// Usage
var stats = getSLAComplianceRate("P1 Incident Response", gs.beginningOfThisMonth(), gs.endOfThisMonth())
gs.info("P1 Response SLA Compliance: " + stats.compliance + "%")
```

## MCP Tool Integration

### Available Tools

| Tool                                    | Purpose                |
| --------------------------------------- | ---------------------- |
| `snow_artifact_manage` (action='find')  | Find SLA definitions   |
| `snow_query_table`                      | Query task_sla records |
| `snow_execute_script`                   | Test SLA scripts       |
| `snow_create_business_rule`             | Create SLA triggers    |

### Example Workflow

```javascript
// 1. Find existing SLAs
await snow_artifact_manage({
  action: "find",
  type: "contract_sla",
  query: "P1",
})

// 2. Query SLA breaches
await snow_query_table({
  table: "task_sla",
  query: "has_breached=true^end_time>=javascript:gs.beginningOfThisMonth()",
  fields: "sla,task,end_time,business_duration",
})

// 3. Check SLA compliance
await snow_execute_script({
  script:
    'var stats = getSLAComplianceRate("P1 Response", gs.beginningOfThisMonth(), gs.endOfThisMonth()); gs.info(JSON.stringify(stats));',
})
```

## Best Practices

1. **Clear Names** - "P1 Incident Response 15min"
2. **Business Hours** - Use appropriate schedules
3. **Pause Conditions** - Pause for external waits
4. **Escalation** - Notify before breach
5. **Metrics** - Track compliance rates
6. **Testing** - Test with various scenarios
7. **Documentation** - Document SLA terms
8. **ES5 Only** - No modern JavaScript syntax
