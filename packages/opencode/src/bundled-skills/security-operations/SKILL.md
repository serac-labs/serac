---
name: security-operations
description: Build ServiceNow Security Operations — sn_si_incident with NIST-aligned state transitions, sn_vul_vulnerable_item with CVSS/risk scoring, sn_ti_indicator IOC matching, and containment playbooks.
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

# Security Operations for ServiceNow

Security Operations (SecOps) integrates security tools and automates incident response.

## SecOps Architecture

```
Security Sources (SIEM, EDR, Vuln Scanners)
    ↓
Security Events/Vulnerabilities
    ↓
Security Incidents / Vuln Items
    ↓
Investigation & Response
    ↓
Remediation & Closure
```

## Key Tables

| Table                    | Purpose                  |
| ------------------------ | ------------------------ |
| `sn_si_incident`         | Security incidents       |
| `sn_vul_vulnerable_item` | Vulnerable items         |
| `sn_si_alert`            | Security alerts          |
| `sn_ti_indicator`        | Threat indicators (IOCs) |
| `sn_si_task`             | Security tasks           |

## Security Incidents (ES5)

### Create Security Incident

```javascript
// Create security incident (ES5 ONLY!)
var incident = new GlideRecord("sn_si_incident")
incident.initialize()

// Incident details
incident.setValue("short_description", "Suspected malware infection on workstation")
incident.setValue("description", "EDR detected suspicious process execution matching known malware signatures")

// Classification
incident.setValue("category", "malware")
incident.setValue("subcategory", "trojan")
incident.setValue("attack_vector", "email")

// Severity
incident.setValue("severity", 1) // 1=Critical, 2=High, 3=Medium, 4=Low
incident.setValue("priority", 1)

// Affected resources
incident.setValue("affected_user", affectedUserSysId)
incident.setValue("cmdb_ci", workstationCISysId)

// Source
incident.setValue("source", "EDR System")
incident.setValue("source_id", "EDR-2024-001234")

// Assignment
incident.setValue("assignment_group", getGroupSysId("Security Operations"))

incident.insert()
```

### Security Incident Workflow

```javascript
// Security incident state transitions (ES5 ONLY!)
var SECURITY_STATES = {
  DRAFT: 1,
  ANALYSIS: 2,
  CONTAIN: 3,
  ERADICATE: 4,
  RECOVER: 5,
  REVIEW: 6,
  CLOSED: 7,
  CANCELLED: 8,
}

function transitionSecurityIncident(incidentSysId, newState, notes) {
  var incident = new GlideRecord("sn_si_incident")
  if (!incident.get(incidentSysId)) {
    return { success: false, message: "Incident not found" }
  }

  var currentState = parseInt(incident.getValue("state"), 10)

  // Validate transition
  var validTransitions = {
    1: [2, 8], // Draft -> Analysis, Cancelled
    2: [3, 6, 8], // Analysis -> Contain, Review, Cancelled
    3: [4, 6, 8], // Contain -> Eradicate, Review, Cancelled
    4: [5, 6, 8], // Eradicate -> Recover, Review, Cancelled
    5: [6, 8], // Recover -> Review, Cancelled
    6: [7], // Review -> Closed
  }

  if (!validTransitions[currentState] || validTransitions[currentState].indexOf(newState) === -1) {
    return { success: false, message: "Invalid state transition" }
  }

  incident.setValue("state", newState)

  // Set timestamps
  if (newState === SECURITY_STATES.CONTAIN) {
    incident.setValue("contained_at", new GlideDateTime())
  } else if (newState === SECURITY_STATES.CLOSED) {
    incident.setValue("closed_at", new GlideDateTime())
  }

  if (notes) {
    incident.work_notes = notes
  }

  incident.update()

  return { success: true, state: newState }
}
```

## Vulnerability Management (ES5)

### Create Vulnerable Item

```javascript
// Create vulnerable item (ES5 ONLY!)
var vulnItem = new GlideRecord("sn_vul_vulnerable_item")
vulnItem.initialize()

// Vulnerability details
vulnItem.setValue("vulnerability", vulnerabilitySysId) // Link to CVE
vulnItem.setValue("cmdb_ci", serverCISysId)

// Severity
vulnItem.setValue("severity", "critical") // critical, high, medium, low
vulnItem.setValue("cvss_score", 9.8)

// Detection
vulnItem.setValue("first_found", new GlideDateTime())
vulnItem.setValue("last_found", new GlideDateTime())
vulnItem.setValue("scanner", "Qualys")

// Risk calculation
vulnItem.setValue("risk_score", calculateRiskScore(vulnItem))

// State
vulnItem.setValue("state", "open")

vulnItem.insert()
```

### Vulnerability Risk Scoring

```javascript
// Calculate vulnerability risk score (ES5 ONLY!)
function calculateRiskScore(vulnItem) {
  var cvss = parseFloat(vulnItem.getValue("cvss_score")) || 0
  var score = cvss * 10 // Base on CVSS

  // Adjust for CI criticality
  var ci = vulnItem.cmdb_ci.getRefRecord()
  if (ci.isValidRecord()) {
    var criticality = ci.getValue("business_criticality")
    if (criticality === "1 - most critical") {
      score *= 1.5
    } else if (criticality === "2 - somewhat critical") {
      score *= 1.25
    }
  }

  // Adjust for exposure
  if (vulnItem.getValue("external_facing") === "true") {
    score *= 1.3
  }

  // Cap at 100
  return Math.min(Math.round(score), 100)
}
```

### Vulnerability Remediation

```javascript
// Create remediation task (ES5 ONLY!)
function createRemediationTask(vulnItemSysId) {
  var vulnItem = new GlideRecord("sn_vul_vulnerable_item")
  if (!vulnItem.get(vulnItemSysId)) {
    return null
  }

  var task = new GlideRecord("sn_si_task")
  task.initialize()

  task.setValue("short_description", "Remediate vulnerability on " + vulnItem.cmdb_ci.getDisplayValue())
  task.setValue(
    "description",
    "Vulnerability: " +
      vulnItem.vulnerability.getDisplayValue() +
      "\n" +
      "CVSS Score: " +
      vulnItem.getValue("cvss_score") +
      "\n" +
      "Risk Score: " +
      vulnItem.getValue("risk_score"),
  )

  // Link to vulnerable item
  task.setValue("vulnerable_item", vulnItemSysId)

  // Assignment based on CI ownership
  var ci = vulnItem.cmdb_ci.getRefRecord()
  if (ci.support_group) {
    task.setValue("assignment_group", ci.getValue("support_group"))
  }

  // Due date based on severity
  var dueDate = new GlideDateTime()
  var severity = vulnItem.getValue("severity")
  if (severity === "critical") {
    dueDate.addDaysLocalTime(7)
  } else if (severity === "high") {
    dueDate.addDaysLocalTime(30)
  } else if (severity === "medium") {
    dueDate.addDaysLocalTime(90)
  } else {
    dueDate.addDaysLocalTime(180)
  }
  task.setValue("due_date", dueDate)

  return task.insert()
}
```

## Threat Intelligence (ES5)

### Create Threat Indicator

```javascript
// Create IOC (Indicator of Compromise) (ES5 ONLY!)
var indicator = new GlideRecord("sn_ti_indicator")
indicator.initialize()

// Indicator details
indicator.setValue("value", "malicious-domain.com")
indicator.setValue("type", "domain") // domain, ip, hash, url, email
indicator.setValue("threat_type", "command_and_control")

// Confidence and severity
indicator.setValue("confidence", 90) // 0-100
indicator.setValue("severity", "high")

// Source
indicator.setValue("source", "Threat Feed")
indicator.setValue("source_ref", "TF-2024-001234")

// Validity
indicator.setValue("valid_from", new GlideDateTime())
var validUntil = new GlideDateTime()
validUntil.addDaysLocalTime(30)
indicator.setValue("valid_until", validUntil)

// Active
indicator.setValue("active", true)

indicator.insert()
```

### Match Indicators

```javascript
// Check if value matches known IOC (ES5 ONLY!)
function checkThreatIndicator(value, type) {
  var indicator = new GlideRecord("sn_ti_indicator")
  indicator.addQuery("value", value)
  indicator.addQuery("type", type)
  indicator.addQuery("active", true)
  indicator.addQuery("valid_from", "<=", new GlideDateTime())
  indicator.addQuery("valid_until", ">=", new GlideDateTime())
  indicator.query()

  if (indicator.next()) {
    return {
      matched: true,
      indicator_id: indicator.getUniqueValue(),
      threat_type: indicator.getValue("threat_type"),
      severity: indicator.getValue("severity"),
      confidence: indicator.getValue("confidence"),
      source: indicator.getValue("source"),
    }
  }

  return { matched: false }
}
```

## Security Playbooks (ES5)

### Execute Playbook

```javascript
// Execute containment playbook (ES5 ONLY!)
function executeContainmentPlaybook(incidentSysId) {
  var incident = new GlideRecord("sn_si_incident")
  if (!incident.get(incidentSysId)) {
    return { success: false, message: "Incident not found" }
  }

  var results = []

  // Step 1: Isolate affected CI
  var ci = incident.cmdb_ci.getRefRecord()
  if (ci.isValidRecord()) {
    results.push(isolateCI(ci))
  }

  // Step 2: Disable affected user
  var user = incident.affected_user.getRefRecord()
  if (user.isValidRecord()) {
    results.push(disableUser(user))
  }

  // Step 3: Create containment tasks
  createContainmentTasks(incidentSysId)

  // Step 4: Update incident state
  incident.setValue("state", 3) // Contain
  incident.setValue("contained_at", new GlideDateTime())
  incident.work_notes = "Containment playbook executed:\n" + JSON.stringify(results)
  incident.update()

  return {
    success: true,
    results: results,
  }
}

function isolateCI(ci) {
  // Integration with network/endpoint tools
  gs.eventQueue("security.isolate_ci", ci, "", "")
  return {
    action: "isolate_ci",
    target: ci.getDisplayValue(),
    status: "initiated",
  }
}

function disableUser(user) {
  user.setValue("active", false)
  user.setValue("locked_out", true)
  user.update()
  return {
    action: "disable_user",
    target: user.getDisplayValue(),
    status: "completed",
  }
}
```

## MCP Tool Integration

### Available Tools

| Tool                                | Purpose                 |
| ----------------------------------- | ----------------------- |
| `snow_query_table`                  | Query SecOps tables     |
| `snow_artifact_manage` (action='find') | Find security configs   |
| `snow_execute_script`               | Test SecOps scripts     |
| `snow_create_event`                 | Trigger security events |

### Example Workflow

```javascript
// 1. Query open security incidents
await snow_query_table({
  table: "sn_si_incident",
  query: "state!=7^state!=8^severity<=2",
  fields: "number,short_description,severity,state,assignment_group",
})

// 2. Find critical vulnerabilities
await snow_query_table({
  table: "sn_vul_vulnerable_item",
  query: "state=open^severity=critical",
  fields: "vulnerability,cmdb_ci,cvss_score,risk_score",
})

// 3. Check threat indicator
await snow_execute_script({
  script: `
        var result = checkThreatIndicator('suspicious-domain.com', 'domain');
        gs.info(JSON.stringify(result));
    `,
})
```

## Best Practices

1. **Triage Quickly** - Rapid initial assessment
2. **Contain First** - Stop the spread
3. **Document Everything** - Audit trail
4. **Automate Response** - Playbooks for common scenarios
5. **Integrate Tools** - SIEM, EDR, etc.
6. **Threat Intel** - Keep IOCs current
7. **Metrics** - Track MTTD, MTTR
8. **ES5 Only** - No modern JavaScript syntax
