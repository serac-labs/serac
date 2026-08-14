---
name: script-include-patterns
description: Write ServiceNow Script Includes — Class.create utility classes, AbstractAjaxProcessor client-callable APIs for GlideAjax, inheritance via Object.extendsObject, and scoped-app patterns.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_create_script_include
  - snow_artifact_manage
  - snow_execute_script
---

# Script Include Patterns for ServiceNow

Script Includes are reusable server-side JavaScript libraries that can be called from any server-side script.

## Script Include Types

| Type                      | Use Case                    | Client Callable |
| ------------------------- | --------------------------- | --------------- |
| **Standard**              | Server-side utilities       | No              |
| **Client Callable**       | GlideAjax from client       | Yes             |
| **On-Demand**             | Lazy loading                | No              |
| **AbstractAjaxProcessor** | Client-server communication | Yes             |

## Standard Script Include (ES5)

```javascript
// Basic utility class
var IncidentUtils = Class.create()
IncidentUtils.prototype = {
  initialize: function () {
    this.LOG_PREFIX = "[IncidentUtils] "
  },

  /**
   * Get incident by number
   * @param {string} number - Incident number (INC0010001)
   * @returns {GlideRecord|null} - Incident record or null
   */
  getByNumber: function (number) {
    var gr = new GlideRecord("incident")
    gr.addQuery("number", number)
    gr.query()
    if (gr.next()) {
      return gr
    }
    return null
  },

  /**
   * Calculate priority based on impact and urgency
   * @param {number} impact - Impact value (1-3)
   * @param {number} urgency - Urgency value (1-3)
   * @returns {number} - Calculated priority (1-5)
   */
  calculatePriority: function (impact, urgency) {
    var matrix = {
      "1-1": 1,
      "1-2": 2,
      "1-3": 3,
      "2-1": 2,
      "2-2": 3,
      "2-3": 4,
      "3-1": 3,
      "3-2": 4,
      "3-3": 5,
    }
    var key = impact + "-" + urgency
    return matrix[key] || 4
  },

  /**
   * Get open incidents for user
   * @param {string} userSysId - User sys_id
   * @returns {Array} - Array of incident objects
   */
  getOpenIncidentsForUser: function (userSysId) {
    var incidents = []
    var gr = new GlideRecord("incident")
    gr.addQuery("caller_id", userSysId)
    gr.addQuery("active", true)
    gr.orderByDesc("opened_at")
    gr.query()

    while (gr.next()) {
      incidents.push({
        sys_id: gr.getUniqueValue(),
        number: gr.getValue("number"),
        short_description: gr.getValue("short_description"),
        state: gr.state.getDisplayValue(),
        priority: gr.priority.getDisplayValue(),
      })
    }
    return incidents
  },

  type: "IncidentUtils",
}
```

## Client Callable Script Include (ES5)

```javascript
// Extends AbstractAjaxProcessor for GlideAjax calls
var IncidentAjax = Class.create()
IncidentAjax.prototype = Object.extendsObject(AbstractAjaxProcessor, {
  /**
   * Get incident details - callable from client
   * Client calls: new GlideAjax('IncidentAjax').addParam('sysparm_name', 'getIncidentDetails')
   */
  getIncidentDetails: function () {
    var incidentId = this.getParameter("sysparm_incident_id")
    var result = {}

    var gr = new GlideRecord("incident")
    if (gr.get(incidentId)) {
      result.success = true
      result.number = gr.getValue("number")
      result.short_description = gr.getValue("short_description")
      result.state = gr.state.getDisplayValue()
      result.priority = gr.priority.getDisplayValue()
      result.assigned_to = gr.assigned_to.getDisplayValue()
      result.assignment_group = gr.assignment_group.getDisplayValue()
    } else {
      result.success = false
      result.message = "Incident not found"
    }

    return JSON.stringify(result)
  },

  /**
   * Search incidents by keyword
   */
  searchIncidents: function () {
    var keyword = this.getParameter("sysparm_keyword")
    var limit = parseInt(this.getParameter("sysparm_limit"), 10) || 10
    var incidents = []

    var gr = new GlideRecord("incident")
    gr.addQuery("short_description", "CONTAINS", keyword)
    gr.addOrCondition("description", "CONTAINS", keyword)
    gr.addQuery("active", true)
    gr.setLimit(limit)
    gr.orderByDesc("opened_at")
    gr.query()

    while (gr.next()) {
      incidents.push({
        sys_id: gr.getUniqueValue(),
        number: gr.getValue("number"),
        short_description: gr.getValue("short_description"),
      })
    }

    return JSON.stringify(incidents)
  },

  /**
   * Check if user can update incident
   */
  canUserUpdate: function () {
    var incidentId = this.getParameter("sysparm_incident_id")
    var userId = gs.getUserID()

    var gr = new GlideRecord("incident")
    if (gr.get(incidentId)) {
      // Check if user is assigned or in assignment group
      var canUpdate =
        gr.getValue("assigned_to") === userId || this._isUserInGroup(userId, gr.getValue("assignment_group"))
      return JSON.stringify({ canUpdate: canUpdate })
    }

    return JSON.stringify({ canUpdate: false })
  },

  _isUserInGroup: function (userId, groupId) {
    var member = new GlideRecord("sys_user_grmember")
    member.addQuery("user", userId)
    member.addQuery("group", groupId)
    member.query()
    return member.hasNext()
  },

  type: "IncidentAjax",
})
```

## Client-Side GlideAjax Call (ES5)

```javascript
// Client script calling Script Include
function getIncidentDetails(incidentSysId, callback) {
  var ga = new GlideAjax("IncidentAjax")
  ga.addParam("sysparm_name", "getIncidentDetails")
  ga.addParam("sysparm_incident_id", incidentSysId)
  ga.getXMLAnswer(function (answer) {
    var result = JSON.parse(answer)
    callback(result)
  })
}

// Usage in client script
getIncidentDetails(g_form.getUniqueValue(), function (incident) {
  if (incident.success) {
    g_form.addInfoMessage("Incident: " + incident.number)
  } else {
    g_form.addErrorMessage(incident.message)
  }
})
```

## Inheritance Pattern (ES5)

```javascript
// Base class
var TaskUtils = Class.create()
TaskUtils.prototype = {
  initialize: function (tableName) {
    this.tableName = tableName || "task"
  },

  getByState: function (state) {
    var records = []
    var gr = new GlideRecord(this.tableName)
    gr.addQuery("state", state)
    gr.query()
    while (gr.next()) {
      records.push(this._toObject(gr))
    }
    return records
  },

  _toObject: function (gr) {
    return {
      sys_id: gr.getUniqueValue(),
      number: gr.getValue("number"),
      short_description: gr.getValue("short_description"),
      state: gr.getValue("state"),
    }
  },

  type: "TaskUtils",
}

// Derived class
var IncidentUtilsExtended = Class.create()
IncidentUtilsExtended.prototype = Object.extendsObject(TaskUtils, {
  initialize: function () {
    TaskUtils.prototype.initialize.call(this, "incident")
  },

  getP1Incidents: function () {
    var incidents = []
    var gr = new GlideRecord("incident")
    gr.addQuery("priority", 1)
    gr.addQuery("active", true)
    gr.query()
    while (gr.next()) {
      var obj = this._toObject(gr)
      obj.caller = gr.caller_id.getDisplayValue()
      incidents.push(obj)
    }
    return incidents
  },

  type: "IncidentUtilsExtended",
})
```

## Scoped Script Include (ES5)

```javascript
// In scoped application: x_myapp
var MyAppUtils = Class.create()
MyAppUtils.prototype = {
  initialize: function () {
    this.APP_SCOPE = "x_myapp"
  },

  /**
   * Get application property
   * @param {string} name - Property name (without scope prefix)
   */
  getAppProperty: function (name) {
    return gs.getProperty(this.APP_SCOPE + "." + name)
  },

  /**
   * Log with application prefix
   */
  log: function (message, source) {
    gs.info("[" + this.APP_SCOPE + "][" + (source || "MyAppUtils") + "] " + message)
  },

  /**
   * Access cross-scope table safely
   */
  getGlobalUser: function (userId) {
    var gr = new GlideRecord("sys_user")
    if (gr.get(userId)) {
      return {
        name: gr.getValue("name"),
        email: gr.getValue("email"),
      }
    }
    return null
  },

  type: "MyAppUtils",
}
```

## MCP Tool Integration

### Available Script Include Tools

| Tool                              | Purpose                       |
| --------------------------------- | ----------------------------- |
| `snow_create_script_include`      | Create new Script Include     |
| `snow_artifact_manage` (action='find')   | Find existing Script Includes |
| `snow_artifact_manage` (action='update') | Modify Script Include code    |
| `snow_execute_script`             | Test Script Include           |

### Example Workflow

```javascript
// 1. Create Script Include
await snow_create_script_include({
  name: "IncidentUtils",
  script: "/* Script Include code */",
  client_callable: false,
  description: "Incident utility functions",
})

// 2. Test the Script Include
await snow_execute_script({
  script: `
        var utils = new IncidentUtils();
        var incident = utils.getByNumber('INC0010001');
        gs.info('Found: ' + (incident ? incident.number : 'null'));
    `,
})
```

## Best Practices

1. **Single Responsibility** - One class, one purpose
2. **Meaningful Names** - IncidentUtils not Utils
3. **Document Methods** - JSDoc comments
4. **Error Handling** - Try-catch with logging
5. **Private Methods** - Prefix with underscore
6. **No Side Effects** - Initialization should not modify data
7. **Testable** - Write methods that can be unit tested
8. **ES5 Only** - No const, let, arrow functions, template literals
