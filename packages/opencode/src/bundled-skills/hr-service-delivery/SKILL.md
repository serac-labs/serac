---
name: hr-service-delivery
description: Build ServiceNow HR Service Delivery — sn_hr_core_case from Employee Center or HR catalog, sn_hr_le_lifecycle_event onboarding/offboarding with templated activities, and HR document generation.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_hr_case_create
  - snow_query_table
  - snow_find_artifact
  - snow_execute_script_with_output
---

# HR Service Delivery for ServiceNow

HR Service Delivery (HRSD) streamlines employee services through cases, lifecycle events, and self-service.

## HRSD Architecture

```
Employee Center (Portal)
    ├── HR Service Catalog
    │   ├── HR Catalog Items
    │   └── Requests → HR Cases
    ├── Knowledge Articles
    └── My HR Cases

HR Cases (sn_hr_core_case)
    ├── Case Tasks
    ├── Lifecycle Events
    └── Document Requests
```

## Key Tables

| Table                       | Purpose               |
| --------------------------- | --------------------- |
| `sn_hr_core_case`           | HR cases              |
| `sn_hr_core_case_operation` | Case operations/tasks |
| `sn_hr_le_lifecycle_event`  | Lifecycle events      |
| `sn_hr_le_activity`         | Lifecycle activities  |
| `sn_hr_core_service`        | HR services           |

## HR Cases (ES5)

### Create HR Case

```javascript
// Create HR Case (ES5 ONLY!)
var hrCase = new GlideRecord("sn_hr_core_case")
hrCase.initialize()

// Case details
hrCase.setValue("short_description", "Request for salary verification letter")
hrCase.setValue("description", "Employee needs salary verification for mortgage application")

// HR Service and Category
hrCase.setValue("hr_service", getHRService("Document Requests"))
hrCase.setValue("hr_service_type", "general_inquiry")

// Subject person (employee)
hrCase.setValue("subject_person", employeeSysId)
hrCase.setValue("opened_for", employeeSysId)

// Opened by (could be different - e.g., manager on behalf)
hrCase.setValue("opened_by", gs.getUserID())

// Assignment
hrCase.setValue("assignment_group", getGroupSysId("HR Operations"))

// Priority
hrCase.setValue("priority", 3)

var caseSysId = hrCase.insert()
```

### HR Case from Catalog

```javascript
// Process HR catalog request (ES5 ONLY!)
// Called from HR Catalog Item workflow

;(function executeActivity(inputs, outputs, scratchpad) {
  // Get request item details
  var ritm = inputs.request_item
  var variables = ritm.variables

  // Create HR Case
  var hrCase = new GlideRecord("sn_hr_core_case")
  hrCase.initialize()

  hrCase.setValue("short_description", ritm.cat_item.getDisplayValue() + " for " + ritm.opened_for.getDisplayValue())
  hrCase.setValue("hr_service", ritm.cat_item.u_hr_service)
  hrCase.setValue("subject_person", ritm.opened_for)
  hrCase.setValue("opened_for", ritm.opened_for)
  hrCase.setValue("opened_by", ritm.opened_by)

  // Copy variables to case
  hrCase.setValue("u_effective_date", variables.effective_date)
  hrCase.setValue("u_reason", variables.reason)

  // Link to request
  hrCase.setValue("parent", ritm.getUniqueValue())

  outputs.hr_case = hrCase.insert()
})(inputs, outputs, scratchpad)
```

## Lifecycle Events (ES5)

### Onboarding Lifecycle Event

```javascript
// Create onboarding lifecycle event (ES5 ONLY!)
function createOnboardingEvent(employeeSysId, startDate, details) {
  var lifecycle = new GlideRecord("sn_hr_le_lifecycle_event")
  lifecycle.initialize()

  // Event details
  lifecycle.setValue("name", "Onboarding - " + getEmployeeName(employeeSysId))
  lifecycle.setValue("subject_person", employeeSysId)
  lifecycle.setValue("state", "ready") // ready, in_progress, complete

  // Lifecycle event type
  lifecycle.setValue("le_type", getLifecycleType("onboarding"))

  // Dates
  lifecycle.setValue("planned_start", startDate)

  // Copy details
  lifecycle.setValue("department", details.department)
  lifecycle.setValue("location", details.location)
  lifecycle.setValue("manager", details.manager)

  var eventSysId = lifecycle.insert()

  // Generate activities from template
  generateActivitiesFromTemplate(eventSysId, "onboarding")

  return eventSysId
}
```

### Lifecycle Activities

```javascript
// Generate lifecycle activities from template (ES5 ONLY!)
function generateActivitiesFromTemplate(lifecycleEventSysId, templateName) {
  // Get lifecycle event
  var lifecycleEvent = new GlideRecord("sn_hr_le_lifecycle_event")
  if (!lifecycleEvent.get(lifecycleEventSysId)) {
    return
  }

  // Get template activities
  var template = new GlideRecord("sn_hr_le_activity_template")
  template.addQuery("template", templateName)
  template.orderBy("order")
  template.query()

  var plannedStart = new GlideDateTime(lifecycleEvent.getValue("planned_start"))

  while (template.next()) {
    var activity = new GlideRecord("sn_hr_le_activity")
    activity.initialize()

    // Link to lifecycle event
    activity.setValue("lifecycle_event", lifecycleEventSysId)

    // Copy from template
    activity.setValue("short_description", template.getValue("name"))
    activity.setValue("description", template.getValue("description"))
    activity.setValue("activity_type", template.getValue("activity_type"))
    activity.setValue("assignment_group", template.getValue("assignment_group"))

    // Calculate due date based on offset
    var dueDate = new GlideDateTime(plannedStart)
    dueDate.addDaysLocalTime(parseInt(template.getValue("day_offset"), 10))
    activity.setValue("due_date", dueDate)

    // Set order
    activity.setValue("order", template.getValue("order"))

    // State
    activity.setValue("state", "pending")

    activity.insert()
  }
}
```

### Offboarding Automation

```javascript
// Trigger offboarding lifecycle event (ES5 ONLY!)
// Business Rule: after, update, sys_user

;(function executeRule(current, previous) {
  // Check if employee is being terminated
  if (current.active.changesTo(false) && current.u_employment_status.changesTo("terminated")) {
    createOffboardingEvent(current)
  }
})(current, previous)

function createOffboardingEvent(user) {
  var lifecycle = new GlideRecord("sn_hr_le_lifecycle_event")
  lifecycle.initialize()

  lifecycle.setValue("name", "Offboarding - " + user.getDisplayValue())
  lifecycle.setValue("subject_person", user.getUniqueValue())
  lifecycle.setValue("le_type", getLifecycleType("offboarding"))
  lifecycle.setValue("state", "ready")
  lifecycle.setValue("planned_start", user.getValue("u_termination_date") || new GlideDateTime())

  // Capture current access for revocation
  lifecycle.setValue("u_current_groups", getCurrentGroups(user.getUniqueValue()))
  lifecycle.setValue("u_current_roles", getCurrentRoles(user.getUniqueValue()))

  var eventSysId = lifecycle.insert()

  // Generate offboarding activities
  generateActivitiesFromTemplate(eventSysId, "offboarding")

  // Notify HR and Manager
  gs.eventQueue("hr.offboarding.initiated", lifecycle, user.manager, "")
}
```

## HR Services (ES5)

### HR Service Configuration

```javascript
// Create HR Service (ES5 ONLY!)
var service = new GlideRecord("sn_hr_core_service")
service.initialize()

service.setValue("name", "Benefits Enrollment")
service.setValue("short_description", "Enroll in or change benefit plans")
service.setValue("description", "Request enrollment or changes to health, dental, vision, and retirement benefits")

// Category
service.setValue("topic", getHRTopic("Benefits"))

// Fulfillment
service.setValue("fulfillment_group", getGroupSysId("Benefits Administration"))
service.setValue("default_sla", getSLASysId("HR Standard Response"))

// Access control
service.setValue("visibility", "all_employees") // all_employees, specific_criteria

// Enable for Employee Center
service.setValue("employee_center_visible", true)

service.insert()
```

### Document Generation

```javascript
// Generate HR document (ES5 ONLY!)
function generateHRDocument(hrCaseSysId, documentType) {
  var hrCase = new GlideRecord("sn_hr_core_case")
  if (!hrCase.get(hrCaseSysId)) {
    return null
  }

  var employee = hrCase.subject_person.getRefRecord()

  // Get document template
  var template = new GlideRecord("sn_hr_core_document_template")
  template.addQuery("name", documentType)
  template.query()

  if (!template.next()) {
    gs.error("Document template not found: " + documentType)
    return null
  }

  // Process template with employee data
  var content = template.getValue("template_body")
  content = processTemplate(content, {
    employee_name: employee.getDisplayValue(),
    employee_id: employee.getValue("employee_number"),
    title: employee.getValue("title"),
    department: employee.department.getDisplayValue(),
    start_date: employee.getValue("u_start_date"),
    salary: employee.getValue("u_annual_salary"),
    manager_name: employee.manager.getDisplayValue(),
    current_date: new GlideDateTime().getLocalDate().toString(),
  })

  // Create document record
  var doc = new GlideRecord("sn_hr_core_document")
  doc.initialize()
  doc.setValue("hr_case", hrCaseSysId)
  doc.setValue("subject_person", employee.getUniqueValue())
  doc.setValue("document_type", documentType)
  doc.setValue("name", documentType + " - " + employee.getDisplayValue())
  doc.setValue("content", content)
  doc.setValue("state", "draft")

  return doc.insert()
}

function processTemplate(template, data) {
  for (var key in data) {
    if (data.hasOwnProperty(key)) {
      var pattern = new RegExp("\\{\\{" + key + "\\}\\}", "g")
      template = template.replace(pattern, data[key] || "")
    }
  }
  return template
}
```

## Employee Center Integration (ES5)

### Case Status Widget

```javascript
// Widget Server Script - HR Case Status (ES5 ONLY!)
;(function () {
  var userId = gs.getUserID()

  // Get user's HR cases
  data.cases = []
  var gr = new GlideRecord("sn_hr_core_case")
  gr.addQuery("subject_person", userId)
  gr.addQuery("active", true)
  gr.orderByDesc("opened_at")
  gr.setLimit(10)
  gr.query()

  while (gr.next()) {
    data.cases.push({
      sys_id: gr.getUniqueValue(),
      number: gr.getValue("number"),
      short_description: gr.getValue("short_description"),
      state: gr.state.getDisplayValue(),
      priority: gr.priority.getDisplayValue(),
      opened_at: gr.getValue("opened_at"),
      hr_service: gr.hr_service.getDisplayValue(),
    })
  }

  // Get pending activities for user
  data.activities = []
  var activity = new GlideRecord("sn_hr_le_activity")
  activity.addQuery("lifecycle_event.subject_person", userId)
  activity.addQuery("state", "IN", "pending,in_progress")
  activity.orderBy("due_date")
  activity.query()

  while (activity.next()) {
    data.activities.push({
      sys_id: activity.getUniqueValue(),
      short_description: activity.getValue("short_description"),
      due_date: activity.getValue("due_date"),
      state: activity.state.getDisplayValue(),
    })
  }
})()
```

## MCP Tool Integration

### Available Tools

| Tool                              | Purpose                       |
| --------------------------------- | ----------------------------- |
| `snow_query_table`                | Query HR cases and activities |
| `snow_find_artifact`              | Find HR configurations        |
| `snow_execute_script_with_output` | Test HR scripts               |
| `snow_deploy`                     | Deploy HR widgets             |

### Example Workflow

```javascript
// 1. Query open HR cases
await snow_query_table({
  table: "sn_hr_core_case",
  query: "active=true^assignment_group=HR Operations",
  fields: "number,short_description,subject_person,state,opened_at",
})

// 2. Find lifecycle events
await snow_query_table({
  table: "sn_hr_le_lifecycle_event",
  query: "state=in_progress",
  fields: "name,subject_person,le_type,planned_start",
})

// 3. Create HR case
await snow_execute_script_with_output({
  script: `
        var hrCase = new GlideRecord('sn_hr_core_case');
        hrCase.initialize();
        hrCase.short_description = 'Test HR Case';
        hrCase.subject_person = gs.getUserID();
        gs.info('Created: ' + hrCase.insert());
    `,
})
```

## Best Practices

1. **Service Catalog** - Use catalog for common requests
2. **Templates** - Lifecycle activity templates
3. **Automation** - Trigger events on HR changes
4. **Documents** - Template-based generation
5. **Privacy** - Respect HR data sensitivity
6. **SLAs** - Define service commitments
7. **Employee Center** - Self-service focus
8. **ES5 Only** - No modern JavaScript syntax
