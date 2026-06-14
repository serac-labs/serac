---
name: event-management
description: Build ServiceNow Event Management — push events to em_event, write event rules with severity transforms, configure alert correlation, dependent-CI rollups, and metric-threshold event generation.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_artifact_manage
  - snow_execute_script
  - snow_create_event
---

# Event Management for ServiceNow

Event Management consolidates events from monitoring tools, correlates them, and creates actionable alerts.

## Event Flow

```
Monitoring Tools (Nagios, SCOM, etc.)
    ↓
Events (em_event)
    ↓ Event Rules
Alerts (em_alert)
    ↓ Alert Management Rules
Incidents/Changes
```

## Key Tables

| Table                       | Purpose                 |
| --------------------------- | ----------------------- |
| `em_event`                  | Raw events from sources |
| `em_alert`                  | Processed alerts        |
| `em_event_rule`             | Event processing rules  |
| `em_alert_correlation_rule` | Alert correlation       |
| `em_connector`              | Event source connectors |

## Events (ES5)

### Create Event Programmatically

```javascript
// Create event (ES5 ONLY!)
var event = new GlideRecord("em_event")
event.initialize()

// Required fields
event.setValue("source", "Custom Monitor")
event.setValue("node", "server01.example.com")
event.setValue("type", "CPU High")
event.setValue("severity", 3) // 1=Critical, 2=Major, 3=Minor, 4=Warning, 5=OK

// Event key for deduplication
event.setValue("event_class", "performance")
event.setValue("message_key", "cpu_high_server01")

// Description
event.setValue("description", "CPU usage exceeded 90% threshold")
event.setValue(
  "additional_info",
  JSON.stringify({
    cpu_percent: 95,
    process: "java",
    duration: "5 minutes",
  }),
)

// CI binding
event.setValue("cmdb_ci", getCISysId("server01"))

// Resource and metric
event.setValue("resource", "CPU")
event.setValue("metric_name", "cpu_usage")

event.insert()
```

### Event via REST API

```javascript
// Push event via REST (External script - ES5 ONLY!)
var request = {
  records: [
    {
      source: "External Monitor",
      node: "app-server-01",
      type: "Application Error",
      severity: "2",
      message_key: "app_error_" + Date.now(),
      description: "Application threw critical exception",
      additional_info: '{"error_code": "E500", "module": "payment"}',
    },
  ],
}

// POST to: /api/global/em/jsonv2
```

## Event Rules (ES5)

### Event Processing Rule

```javascript
// Create event rule (ES5 ONLY!)
var rule = new GlideRecord("em_event_rule")
rule.initialize()

// Rule identification
rule.setValue("name", "High CPU Alert")
rule.setValue("description", "Create alert for high CPU events")
rule.setValue("order", 100)
rule.setValue("active", true)

// Event filter (which events to process)
rule.setValue("filter", "type=CPU High^severity<=3")

// Actions
rule.setValue("create_alert", true)
rule.setValue("alert_severity", 3)

// Transform settings
rule.setValue("transform_type", true)
rule.setValue("new_type", "Performance - CPU")

// CI binding
rule.setValue("ci_binding_type", "node")

rule.insert()
```

### Event Rule Script (ES5)

```javascript
// Event rule advanced script (ES5 ONLY!)
// Table: em_event_rule, field: script

;(function runRule(event, rule) {
  // Get additional info
  var addInfo = {}
  try {
    addInfo = JSON.parse(event.additional_info)
  } catch (e) {
    addInfo = {}
  }

  // Set severity based on CPU percentage
  var cpuPercent = parseFloat(addInfo.cpu_percent) || 0

  if (cpuPercent >= 95) {
    event.severity = 1 // Critical
  } else if (cpuPercent >= 90) {
    event.severity = 2 // Major
  } else if (cpuPercent >= 80) {
    event.severity = 3 // Minor
  }

  // Enrich description
  event.description = event.description + " (Current: " + cpuPercent + "%)"

  // Set time to clear (auto-close if OK event not received)
  event.u_time_to_clear = 900 // 15 minutes

  return true // Continue processing
})(event, rule)
```

## Alerts (ES5)

### Alert Lifecycle

```
Open
    ↓ Acknowledge
Acknowledged
    ↓ Investigate
In Progress
    ↓ Resolution
Resolved
    ↓ Close
Closed

Flapping ← Multiple severity changes
```

### Alert Management Rule

```javascript
// Create alert management rule (ES5 ONLY!)
var amRule = new GlideRecord("em_alert_management_rule")
amRule.initialize()

amRule.setValue("name", "Auto-create Incident for Critical Alerts")
amRule.setValue("description", "Create P1 incident for critical alerts on production CIs")
amRule.setValue("order", 100)
amRule.setValue("active", true)

// Alert filter
amRule.setValue("filter", "severity=1^cmdb_ci.u_environment=production")

// Action: Create incident
amRule.setValue("create_incident", true)
amRule.setValue("incident_priority", 1)
amRule.setValue("incident_assignment_group", getGroupSysId("NOC"))

amRule.insert()
```

### Manual Alert Processing (ES5)

```javascript
// Process alert manually (ES5 ONLY!)
function acknowledgeAlert(alertSysId, notes) {
  var alert = new GlideRecord("em_alert")
  if (!alert.get(alertSysId)) {
    return { success: false, message: "Alert not found" }
  }

  // Validate state
  if (alert.getValue("state") !== "Open") {
    return { success: false, message: "Alert is not in Open state" }
  }

  // Acknowledge
  alert.setValue("state", "Acknowledged")
  alert.setValue("acknowledged_by", gs.getUserID())
  alert.setValue("acknowledged_at", new GlideDateTime())

  // Add notes
  if (notes) {
    alert.work_notes = "Acknowledged: " + notes
  }

  alert.update()

  return { success: true, number: alert.getValue("number") }
}
```

## Alert Correlation (ES5)

### Correlation Rule

```javascript
// Create correlation rule (ES5 ONLY!)
var corrRule = new GlideRecord("em_alert_correlation_rule")
corrRule.initialize()

corrRule.setValue("name", "Server Down Correlation")
corrRule.setValue("description", "Correlate all alerts when a server goes down")
corrRule.setValue("active", true)

// Parent alert filter
corrRule.setValue("parent_filter", "type=Server Down^severity=1")

// Child alert filter
corrRule.setValue("child_filter", "cmdb_ci.u_hosted_on=javascript:parent.cmdb_ci")

// Correlation window
corrRule.setValue("time_window", 300) // 5 minutes

// Action
corrRule.setValue("set_child_severity", true)
corrRule.setValue("new_child_severity", 4) // Warning

corrRule.insert()
```

### Custom Correlation Script (ES5)

```javascript
// Alert correlation script (ES5 ONLY!)
// Correlate database alerts with application alerts

var AlertCorrelation = Class.create()
AlertCorrelation.prototype = {
  initialize: function () {},

  /**
   * Find related alerts for correlation
   */
  findRelatedAlerts: function (parentAlertSysId) {
    var parent = new GlideRecord("em_alert")
    if (!parent.get(parentAlertSysId)) {
      return []
    }

    var relatedAlerts = []
    var parentCI = parent.getValue("cmdb_ci")
    var parentTime = new GlideDateTime(parent.getValue("sys_created_on"))

    // Time window: 5 minutes before/after parent
    var windowStart = new GlideDateTime(parentTime)
    windowStart.addSeconds(-300)
    var windowEnd = new GlideDateTime(parentTime)
    windowEnd.addSeconds(300)

    // Find alerts on dependent CIs
    var dependents = this._getDependentCIs(parentCI)

    var alert = new GlideRecord("em_alert")
    alert.addQuery("cmdb_ci", "IN", dependents.join(","))
    alert.addQuery("sys_created_on", ">=", windowStart)
    alert.addQuery("sys_created_on", "<=", windowEnd)
    alert.addQuery("sys_id", "!=", parentAlertSysId)
    alert.addQuery("parent_alert", "") // Not already correlated
    alert.query()

    while (alert.next()) {
      relatedAlerts.push({
        sys_id: alert.getUniqueValue(),
        number: alert.getValue("number"),
        cmdb_ci: alert.cmdb_ci.getDisplayValue(),
        severity: alert.getValue("severity"),
      })
    }

    return relatedAlerts
  },

  _getDependentCIs: function (parentCISysId) {
    var dependents = []

    var rel = new GlideRecord("cmdb_rel_ci")
    rel.addQuery("parent", parentCISysId)
    rel.addQuery("type.name", "Depends on::Used by")
    rel.query()

    while (rel.next()) {
      dependents.push(rel.getValue("child"))
    }

    return dependents
  },

  /**
   * Correlate alerts under parent
   */
  correlate: function (parentAlertSysId, childAlertSysIds) {
    for (var i = 0; i < childAlertSysIds.length; i++) {
      var child = new GlideRecord("em_alert")
      if (child.get(childAlertSysIds[i])) {
        child.setValue("parent_alert", parentAlertSysId)
        child.work_notes = "Correlated with parent alert"
        child.update()
      }
    }
  },

  type: "AlertCorrelation",
}
```

## Metrics (ES5)

### Create Metric Event

```javascript
// Create metric event for threshold monitoring (ES5 ONLY!)
function createMetricEvent(ciSysId, metricName, value, thresholds) {
  var severity = 5 // OK by default

  // Determine severity based on thresholds
  if (value >= thresholds.critical) {
    severity = 1
  } else if (value >= thresholds.major) {
    severity = 2
  } else if (value >= thresholds.minor) {
    severity = 3
  } else if (value >= thresholds.warning) {
    severity = 4
  }

  // Only create event if not OK
  if (severity < 5) {
    var event = new GlideRecord("em_event")
    event.initialize()
    event.setValue("source", "Metric Monitor")
    event.setValue("cmdb_ci", ciSysId)
    event.setValue("type", metricName + " Threshold")
    event.setValue("severity", severity)
    event.setValue("metric_name", metricName)
    event.setValue("message_key", metricName + "_" + ciSysId)
    event.setValue("description", metricName + " is at " + value + " (Threshold: " + getThresholdName(severity) + ")")
    event.insert()
  }

  return severity
}

function getThresholdName(severity) {
  var names = { 1: "Critical", 2: "Major", 3: "Minor", 4: "Warning", 5: "OK" }
  return names[severity]
}
```

## MCP Tool Integration

### Available Tools

| Tool                   | Purpose                                  |
| ---------------------- | ---------------------------------------- |
| `snow_query_table`     | Query events, alerts, and event rules    |
| `snow_artifact_manage` | Find related artifacts (`action='find'`) |
| `snow_execute_script`  | Test event scripts                       |
| `snow_create_event`    | Trigger system events                    |

### Example Workflow

```javascript
// 1. Query open alerts
await snow_query_table({
  table: "em_alert",
  query: "state=Open^severity<=2",
  fields: "number,description,cmdb_ci,severity,source",
})

// 2. Find unprocessed events
await snow_query_table({
  table: "em_event",
  query: "state=Ready",
  fields: "source,node,type,severity,description",
})

// 3. Create test event
await snow_execute_script({
  script: `
        var event = new GlideRecord('em_event');
        event.initialize();
        event.source = 'Test';
        event.type = 'Test Event';
        event.severity = 4;
        event.node = 'test-server';
        gs.info('Created: ' + event.insert());
    `,
})
```

## Best Practices

1. **Event Deduplication** - Use message_key properly
2. **CI Binding** - Bind events to CIs for impact
3. **Severity Mapping** - Consistent severity levels
4. **Correlation** - Reduce alert noise
5. **Time Windows** - Configure appropriate windows
6. **Auto-closure** - Set time-to-clear for transient issues
7. **Monitoring** - Track event processing health
8. **ES5 Only** - No modern JavaScript syntax
