---
name: client-scripts
description: Write ServiceNow client scripts (onLoad/onChange/onSubmit/onCellEdit) using g_form, g_user, GlideAjax, field visibility/mandatory toggles, and validation with debounced server calls.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_create_client_script
  - snow_artifact_manage
  - snow_create_script_include
---

# Client Script Patterns for ServiceNow

Client Scripts run in the user's browser and control form behavior. Unlike server-side scripts, client scripts can use modern JavaScript (ES6+) in modern browsers.

## Client Script Types

| Type           | When it Runs        | Use Case                                      |
| -------------- | ------------------- | --------------------------------------------- |
| **onLoad**     | Form loads          | Set defaults, hide/show fields, initial setup |
| **onChange**   | Field value changes | React to user input, cascading updates        |
| **onSubmit**   | Form submitted      | Validation before save                        |
| **onCellEdit** | List cell edited    | Validate inline edits                         |

## The g_form API

### Getting and Setting Values

```javascript
// Get field value
var priority = g_form.getValue("priority")
var callerName = g_form.getDisplayValue("caller_id") // Reference display value

// Set field value
g_form.setValue("priority", "1")
g_form.setValue("assigned_to", userSysId, "John Smith") // Reference with display

// Clear a field
g_form.clearValue("assignment_group")
```

### Field Visibility and State

```javascript
// Show/Hide fields
g_form.setVisible("u_internal_notes", false)
g_form.setDisplay("u_internal_notes", false) // Removes from DOM

// Make field mandatory
g_form.setMandatory("short_description", true)

// Make field read-only
g_form.setReadOnly("caller_id", true)

// Disable field (grayed out but visible)
g_form.setDisabled("state", true)
```

### Messages and Validation

```javascript
// Field-level messages
g_form.showFieldMsg("email", "Invalid email format", "error")
g_form.hideFieldMsg("email")

// Form-level messages
g_form.addInfoMessage("Record saved successfully")
g_form.addErrorMessage("Please fix the errors below")
g_form.clearMessages()

// Flash a field to draw attention
g_form.flash("priority", "#ff0000", 0) // Red flash
```

### Sections and Labels

```javascript
// Collapse/Expand sections
g_form.setSectionDisplay("notes", false) // Collapse
g_form.setSectionDisplay("notes", true) // Expand

// Change field label
g_form.setLabelOf("short_description", "Issue Summary")
```

## Common Patterns

### Pattern 1: onLoad - Set Defaults

```javascript
function onLoad() {
  // Only on new records
  if (g_form.isNewRecord()) {
    // Set default priority
    g_form.setValue("priority", "3")

    // Set caller to current user
    g_form.setValue("caller_id", g_user.userID)

    // Hide internal fields from end users
    if (!g_user.hasRole("itil")) {
      g_form.setVisible("assignment_group", false)
      g_form.setVisible("assigned_to", false)
    }
  }
}
```

### Pattern 2: onChange - Cascading Updates

```javascript
function onChange(control, oldValue, newValue, isLoading) {
  // Don't run during form load
  if (isLoading) return

  // When category changes, clear subcategory
  if (newValue != oldValue) {
    g_form.setValue("subcategory", "")
    g_form.clearValue("u_item")
  }

  // Auto-set priority based on category
  if (newValue == "security") {
    g_form.setValue("priority", "1")
    g_form.setReadOnly("priority", true)
  } else {
    g_form.setReadOnly("priority", false)
  }
}
```

### Pattern 3: onChange with GlideAjax

```javascript
function onChange(control, oldValue, newValue, isLoading) {
  if (isLoading || newValue == "") return

  // Get data from server
  var ga = new GlideAjax("MyScriptInclude")
  ga.addParam("sysparm_name", "getUserDetails")
  ga.addParam("sysparm_user_id", newValue)
  ga.getXMLAnswer(function (response) {
    var data = JSON.parse(response)

    // Update form with server data
    g_form.setValue("location", data.location)
    g_form.setValue("department", data.department)
    g_form.setValue("u_vip", data.vip)

    if (data.vip == "true") {
      g_form.setValue("priority", "1")
      g_form.flash("priority", "#ffff00", 2)
    }
  })
}
```

### Pattern 4: onSubmit - Validation

```javascript
function onSubmit() {
  // Validate email format
  var email = g_form.getValue("u_email")
  if (email && !isValidEmail(email)) {
    g_form.showFieldMsg("u_email", "Please enter a valid email", "error")
    return false // Prevent submit
  }

  // Require close notes when resolving
  var state = g_form.getValue("state")
  var closeNotes = g_form.getValue("close_notes")
  if (state == "6" && !closeNotes) {
    g_form.showFieldMsg("close_notes", "Close notes required", "error")
    g_form.setMandatory("close_notes", true)
    return false
  }

  // Confirm before high-priority submission
  var priority = g_form.getValue("priority")
  if (priority == "1") {
    return confirm("This will create a Priority 1 incident. Continue?")
  }

  return true // Allow submit
}

function isValidEmail(email) {
  var regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return regex.test(email)
}
```

### Pattern 5: Conditional Mandatory Fields

```javascript
function onChange(control, oldValue, newValue, isLoading) {
  if (isLoading) return

  // Category "Hardware" requires asset tag
  var isHardware = newValue == "hardware"
  g_form.setMandatory("u_asset_tag", isHardware)
  g_form.setDisplay("u_asset_tag", isHardware)

  // Category "Software" requires application name
  var isSoftware = newValue == "software"
  g_form.setMandatory("u_application", isSoftware)
  g_form.setDisplay("u_application", isSoftware)
}
```

## GlideAjax Pattern (Server Communication)

### Client Script

```javascript
function onChange(control, oldValue, newValue, isLoading) {
  if (isLoading || !newValue) return

  var ga = new GlideAjax("IncidentUtils")
  ga.addParam("sysparm_name", "getRelatedIncidents")
  ga.addParam("sysparm_ci", newValue)
  ga.getXMLAnswer(handleResponse)
}

function handleResponse(response) {
  var result = JSON.parse(response)

  if (result.count > 0) {
    g_form.addWarningMessage("There are " + result.count + " related open incidents for this CI")
  }
}
```

### Server Script Include

```javascript
var IncidentUtils = Class.create()
IncidentUtils.prototype = Object.extendsObject(AbstractAjaxProcessor, {
  getRelatedIncidents: function () {
    var ci = this.getParameter("sysparm_ci")
    var result = { count: 0, incidents: [] }

    var gr = new GlideRecord("incident")
    gr.addQuery("cmdb_ci", ci)
    gr.addQuery("active", true)
    gr.query()

    result.count = gr.getRowCount()
    while (gr.next()) {
      result.incidents.push({
        number: gr.getValue("number"),
        short_description: gr.getValue("short_description"),
      })
    }

    return JSON.stringify(result)
  },

  type: "IncidentUtils",
})
```

## g_user Object

```javascript
// Current user information
var userName = g_user.userName // User name
var userID = g_user.userID // sys_id
var firstName = g_user.firstName // First name
var lastName = g_user.lastName // Last name
var fullName = g_user.getFullName() // Full name

// Role checks
if (g_user.hasRole("admin")) {
}
if (g_user.hasRole("itil")) {
}
if (g_user.hasRoleExactly("incident_manager")) {
} // Exact match, no admin override

// Multiple roles
if (g_user.hasRoleFromList("itil,incident_manager")) {
}
```

## Performance Best Practices

### 1. Minimize Server Calls

```javascript
// ❌ BAD - Multiple GlideAjax calls
onChange: getUserLocation()
onChange: getUserDepartment()
onChange: getUserManager()

// ✅ GOOD - Single call returning all data
onChange: getUserDetails() // Returns location, department, manager
```

### 2. Use isLoading Parameter

```javascript
function onChange(control, oldValue, newValue, isLoading) {
  // ❌ BAD - Runs during form load
  callServer(newValue)

  // ✅ GOOD - Skip during load
  if (isLoading) return
  callServer(newValue)
}
```

### 3. Debounce Rapid Changes

```javascript
var timeout
function onChange(control, oldValue, newValue, isLoading) {
  if (isLoading) return

  clearTimeout(timeout)
  timeout = setTimeout(function () {
    performExpensiveOperation(newValue)
  }, 300) // Wait 300ms for typing to stop
}
```

## Common Mistakes

| Mistake                        | Problem                           | Solution                              |
| ------------------------------ | --------------------------------- | ------------------------------------- |
| Forgetting `isLoading` check   | Script runs unnecessarily on load | Always check `if (isLoading) return;` |
| Blocking onSubmit              | UI freezes on slow validation     | Use async validation with callback    |
| No error handling in GlideAjax | Silent failures                   | Add error callbacks                   |
| Testing only in one browser    | Cross-browser issues              | Test Chrome, Firefox, Edge            |
| Direct DOM manipulation        | Breaks with UI updates            | Use g_form API                        |
