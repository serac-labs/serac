---
name: ui-actions-policies
description: Build ServiceNow UI Actions (form/list buttons, context menus) and UI Policies (conditional mandatory/visible/read-only) with server/client scripts and GlideAjax. Use snow_analyze_form before modifying forms.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_create_ui_action
  - snow_create_ui_policy
  - snow_find_artifact
  - snow_edit_artifact
  - snow_analyze_form
---

# UI Actions & UI Policies for ServiceNow

UI Actions add buttons, links, and context menus. UI Policies control form field behavior dynamically.

Before modifying an existing form, reach for `snow_analyze_form` — it returns every active UI policy, client script, data policy, record + field ACL, and UI action on the target table in one call. Use it to answer "why is this form behaving like this?" before guessing.

## UI Actions

### UI Action Types

| Type                  | Location           | Example            |
| --------------------- | ------------------ | ------------------ |
| **Form Button**       | Form header        | "Resolve Incident" |
| **Form Context Menu** | Right-click menu   | "Copy Record"      |
| **Form Link**         | Related links      | "View CI"          |
| **List Button**       | List header        | "Export Selected"  |
| **List Context Menu** | Right-click on row | "Assign to Me"     |
| **List Choice**       | Actions dropdown   | "Update State"     |
| **List Link**         | List header links  | "New Record"       |

### Form Button UI Action (ES5)

```javascript
// Table: sys_ui_action
// Name: Resolve Incident
// Table: incident
// Form button: true
// Active: true
// Condition: current.active == true && current.state != 6

// Script (Server-side - ES5 ONLY):
;(function executeAction() {
  // Validate before resolving
  if (!current.resolution_code) {
    gs.addErrorMessage("Please select a resolution code")
    action.setRedirectURL(current)
    return
  }

  if (!current.close_notes) {
    gs.addErrorMessage("Please provide resolution notes")
    action.setRedirectURL(current)
    return
  }

  // Set resolved state
  current.state = 6 // Resolved
  current.resolved_at = new GlideDateTime()
  current.resolved_by = gs.getUserID()
  current.update()

  gs.addInfoMessage("Incident " + current.number + " has been resolved")
  action.setRedirectURL(current)
})()
```

### Client-Side UI Action (ES5)

```javascript
// Table: sys_ui_action
// Name: Quick Assign
// Client: true
// Onclick: quickAssign()

// Client script (ES5 ONLY):
function quickAssign() {
  // Get current user
  var userId = g_user.userID
  var userName = g_user.getFullName()

  // Confirm action
  var confirmed = confirm("Assign this incident to yourself (" + userName + ")?")
  if (!confirmed) {
    return false
  }

  // Set the field value
  g_form.setValue("assigned_to", userId)
  g_form.setValue("assignment_group", g_user.getGroupID())

  // Save the form
  gsftSubmit(null, g_form.getFormElement(), "save")
  return false
}
```

### List UI Action (ES5)

```javascript
// Table: sys_ui_action
// Name: Close Selected Incidents
// Table: incident
// List button: true
// List choice: true
// Condition: gs.hasRole('itil')

// Script (Server-side - ES5 ONLY):
;(function executeAction() {
  // Get selected records
  var selectedRecords = RP.getParameterValue("sysparm_checked_items")
  if (!selectedRecords) {
    gs.addErrorMessage("No records selected")
    return
  }

  var sysIds = selectedRecords.split(",")
  var closedCount = 0

  for (var i = 0; i < sysIds.length; i++) {
    var gr = new GlideRecord("incident")
    if (gr.get(sysIds[i])) {
      if (gr.state != 7) {
        // Not already closed
        gr.state = 7 // Closed
        gr.closed_at = new GlideDateTime()
        gr.closed_by = gs.getUserID()
        gr.update()
        closedCount++
      }
    }
  }

  gs.addInfoMessage("Closed " + closedCount + " incident(s)")
})()
```

### UI Action with GlideAjax (ES5)

```javascript
// Client-side UI Action calling server
// Client: true
// Onclick: checkAndEscalate()

function checkAndEscalate() {
  var incidentId = g_form.getUniqueValue()

  // Check if escalation is allowed
  var ga = new GlideAjax("IncidentAjax")
  ga.addParam("sysparm_name", "canEscalate")
  ga.addParam("sysparm_incident_id", incidentId)
  ga.getXMLAnswer(function (answer) {
    var result = JSON.parse(answer)
    if (result.canEscalate) {
      // Proceed with escalation
      g_form.setValue("priority", 1)
      g_form.setValue("escalation", 1)
      gsftSubmit(null, g_form.getFormElement(), "escalate_incident")
    } else {
      alert("Cannot escalate: " + result.reason)
    }
  })
  return false
}
```

## UI Policies

### UI Policy Structure

| Field                 | Purpose                   |
| --------------------- | ------------------------- |
| **Short description** | Policy name               |
| **Table**             | Target table              |
| **Conditions**        | When to apply             |
| **Reverse if false**  | Undo when condition false |
| **On load**           | Run when form loads       |
| **UI Policy Actions** | Field behaviors           |

### Basic UI Policy (No Script)

```yaml
# UI Policy: Make Resolution Required on Resolve
Table: incident
Short description: Require resolution fields when resolving
Conditions: state = 6 (Resolved)
On load: true
Reverse if false: true

# UI Policy Actions:
- Field: resolution_code
  Mandatory: true
  Visible: true

- Field: close_notes
  Mandatory: true
  Visible: true

- Field: resolved_by
  Read only: true
```

### UI Policy with Script (ES5)

```javascript
// UI Policy Script - Execute if true
// Runs when condition becomes true (ES5 ONLY!)

function onCondition() {
  // Show/hide fields based on category
  var category = g_form.getValue("category")

  if (category === "hardware") {
    g_form.setDisplay("cmdb_ci", true)
    g_form.setMandatory("cmdb_ci", true)
    g_form.setDisplay("software", false)
  } else if (category === "software") {
    g_form.setDisplay("software", true)
    g_form.setMandatory("software", true)
    g_form.setDisplay("cmdb_ci", false)
  }
}
```

### Complex UI Policy Script (ES5)

```javascript
// UI Policy: VIP Caller Handling
// Condition: None (script handles logic)
// On load: true
// Run scripts: true

// Script - Execute if true (ES5 ONLY!):
function onCondition() {
  var callerId = g_form.getValue("caller_id")
  if (!callerId) {
    return
  }

  // Check if VIP via GlideAjax
  var ga = new GlideAjax("UserAjax")
  ga.addParam("sysparm_name", "isVIP")
  ga.addParam("sysparm_user_id", callerId)
  ga.getXMLAnswer(function (answer) {
    var isVIP = answer === "true"

    if (isVIP) {
      // Highlight form
      g_form.flash("caller_id", "#FFD700", 0)
      g_form.showFieldMsg("caller_id", "VIP Customer", "info")

      // Set default priority
      if (!g_form.getValue("priority")) {
        g_form.setValue("priority", 2)
      }

      // Make assignment group mandatory
      g_form.setMandatory("assignment_group", true)
    }
  })
}
```

### Dynamic Field Visibility (ES5)

```javascript
// UI Policy: Show fields based on incident type
// Table: incident
// On load: true

function onCondition() {
  var incidentType = g_form.getValue("u_incident_type")

  // Reset all conditional fields
  var conditionalFields = ["u_network_details", "u_hardware_model", "u_software_name"]
  for (var i = 0; i < conditionalFields.length; i++) {
    g_form.setDisplay(conditionalFields[i], false)
    g_form.setMandatory(conditionalFields[i], false)
  }

  // Show relevant fields
  switch (incidentType) {
    case "network":
      g_form.setDisplay("u_network_details", true)
      g_form.setMandatory("u_network_details", true)
      break
    case "hardware":
      g_form.setDisplay("u_hardware_model", true)
      g_form.setMandatory("u_hardware_model", true)
      break
    case "software":
      g_form.setDisplay("u_software_name", true)
      g_form.setMandatory("u_software_name", true)
      break
  }
}
```

## Creating via Scripts (ES5)

### Create UI Action Programmatically

```javascript
// Create UI Action via background script (ES5 ONLY!)
var uiAction = new GlideRecord("sys_ui_action")
uiAction.initialize()
uiAction.setValue("name", "Escalate to Manager")
uiAction.setValue("table", "incident")
uiAction.setValue("active", true)
uiAction.setValue("form_button", true)
uiAction.setValue("form_style", "btn-warning")
uiAction.setValue("hint", "Escalate this incident to the caller's manager")
uiAction.setValue("condition", "current.active == true && current.priority > 2")
uiAction.setValue(
  "script",
  "(function executeAction() {\n" +
    "    current.priority = 2;\n" +
    "    current.escalation = 1;\n" +
    '    current.work_notes = "Escalated by " + gs.getUserDisplayName();\n' +
    "    current.update();\n" +
    '    gs.addInfoMessage("Incident escalated");\n' +
    "    action.setRedirectURL(current);\n" +
    "})();",
)
uiAction.insert()
```

### Create UI Policy Programmatically

```javascript
// Create UI Policy (ES5 ONLY!)
var policy = new GlideRecord("sys_ui_policy")
policy.initialize()
policy.setValue("short_description", "Require Close Notes on Close")
policy.setValue("table", "incident")
policy.setValue("active", true)
policy.setValue("on_load", true)
policy.setValue("reverse_if_false", true)
policy.setValue("conditions", "state=7")
var policySysId = policy.insert()

// Add UI Policy Action
var action = new GlideRecord("sys_ui_policy_action")
action.initialize()
action.setValue("ui_policy", policySysId)
action.setValue("field", "close_notes")
action.setValue("mandatory", true)
action.setValue("visible", true)
action.setValue("disabled", false)
action.insert()
```

## MCP Tool Integration

### Available Tools

| Tool                    | Purpose                   |
| ----------------------- | ------------------------- |
| `snow_create_ui_action` | Create UI Action          |
| `snow_create_ui_policy` | Create UI Policy          |
| `snow_find_artifact`    | Find existing UI elements |
| `snow_edit_artifact`    | Modify UI elements        |

### Example Workflow

```javascript
// 1. Create UI Action
await snow_create_ui_action({
  name: "Approve Change",
  table: "change_request",
  form_button: true,
  condition: 'current.state == "assess"',
  script: "/* approval script */",
})

// 2. Create UI Policy
await snow_create_ui_policy({
  short_description: "Require justification for high priority",
  table: "change_request",
  conditions: "priority=1",
  actions: [{ field: "justification", mandatory: true }],
})
```

## Best Practices

1. **Descriptive Names** - Clear purpose in name
2. **Conditions First** - Use conditions before scripts
3. **Minimal Scripts** - Keep scripts short
4. **Reverse If False** - Clean up field states
5. **Test Thoroughly** - Multiple scenarios
6. **Role Security** - Add role conditions
7. **ES5 Only** - No modern JavaScript syntax
8. **Form vs List** - Choose appropriate action type
