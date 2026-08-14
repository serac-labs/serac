---
name: scoped-apps
description: Build ServiceNow scoped applications (x_vendor_app) — scope naming, x_-prefixed tables, cross-scope script include access via GlideScopedEvaluator, application properties, scoped REST APIs, and store-publishing checklist.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_create_application
  - snow_update_set_manage (action='create')
  - snow_query_table
  - snow_property_manager
---

# Scoped Application Development for ServiceNow

Scoped applications provide isolation and portability for custom development in ServiceNow.

## Why Use Scoped Apps?

| Feature          | Global Scope | Scoped App               |
| ---------------- | ------------ | ------------------------ |
| Naming conflicts | Possible     | Prevented (x_prefix)     |
| Portability      | Difficult    | Easy (Update Sets)       |
| Security         | Open         | Controlled (Cross-scope) |
| Store publishing | No           | Yes                      |
| Dependencies     | Implicit     | Explicit                 |

## Creating a Scoped Application

### Via Studio (Recommended)

```
1. Navigate: System Applications > Studio
2. Click: Create Application
3. Enter:
   - Name: "My Custom App"
   - Scope: "x_mycom_myapp" (auto-generated)
   - Version: 1.0.0
4. Configure:
   - Runtime access: Check tables needing cross-scope access
```

### Via MCP

```javascript
snow_create_application({
  name: "My Custom Application",
  scope: "x_mycom_custom",
  version: "1.0.0",
  description: "Custom application for...",
})
```

## Scope Naming Convention

```
x_[vendor]_[app]

Examples:
- x_acme_hr          (ACME Corp HR App)
- x_mycom_inventory  (My Company Inventory)
- x_snc_global       (ServiceNow Global)
```

## Table Naming

```javascript
// Scoped tables are automatically prefixed
// Table name in Studio: "task_tracker"
// Actual table name: "x_mycom_myapp_task_tracker"

// Creating records
var gr = new GlideRecord("x_mycom_myapp_task_tracker")
gr.initialize()
gr.setValue("name", "My Task")
gr.insert()
```

## Script Include in Scoped App

```javascript
var TaskManager = Class.create()
TaskManager.prototype = {
  initialize: function () {
    this.tableName = "x_mycom_myapp_task_tracker"
  },

  createTask: function (name, description) {
    var gr = new GlideRecord(this.tableName)
    gr.initialize()
    gr.setValue("name", name)
    gr.setValue("description", description)
    return gr.insert()
  },

  // Mark as accessible from other scopes
  // Requires: "Accessible from: All application scopes"
  getTask: function (sysId) {
    var gr = new GlideRecord(this.tableName)
    if (gr.get(sysId)) {
      return {
        name: gr.getValue("name"),
        description: gr.getValue("description"),
      }
    }
    return null
  },

  type: "TaskManager",
}
```

## Cross-Scope Access

### Calling Other Scope's Script Include

```javascript
// From scope: x_mycom_otherapp
// Calling: x_mycom_myapp.TaskManager

// Option 1: Direct call (if accessible)
var tm = new x_mycom_myapp.TaskManager()
var task = tm.getTask(sysId)

// Option 2: GlideScopedEvaluator
var evaluator = new GlideScopedEvaluator()
evaluator.putVariable("sysId", sysId)
var result = evaluator.evaluateScript("x_mycom_myapp", "new TaskManager().getTask(sysId)")
```

### Accessing Other Scope's Tables

```javascript
// Check if cross-scope access is allowed
var gr = new GlideRecord("x_other_app_table")
if (!gr.isValid()) {
  gs.error("No access to x_other_app_table")
  return
}

// If accessible, query normally
gr.addQuery("active", true)
gr.query()
```

## Application Properties

### Define Properties

```javascript
// In Application > Properties
// Name: x_mycom_myapp.default_priority
// Value: 3
// Type: string

// In Application > Modules
// Create "Properties" module pointing to:
// /sys_properties_list.do?sysparm_query=name=x_mycom_myapp
```

### Use Properties

```javascript
// Get property value
var defaultPriority = gs.getProperty("x_mycom_myapp.default_priority", "3")

// Set property value (requires admin)
gs.setProperty("x_mycom_myapp.default_priority", "2")
```

## Application Files Structure

```
x_mycom_myapp/
├── Tables
│   ├── x_mycom_myapp_task
│   └── x_mycom_myapp_config
├── Script Includes
│   ├── TaskManager
│   └── ConfigUtils
├── Business Rules
│   └── Validate Task
├── UI Pages
│   └── task_dashboard
├── REST API
│   └── Task API
├── Scheduled Jobs
│   └── Daily Cleanup
└── Application Properties
    ├── default_priority
    └── enable_notifications
```

## REST API in Scoped App

### Define Scripted REST API

```javascript
// Resource: /api/x_mycom_myapp/tasks
// HTTP Method: GET

;(function process(request, response) {
  var tasks = []
  var gr = new GlideRecord("x_mycom_myapp_task_tracker")
  gr.addQuery("active", true)
  gr.query()

  while (gr.next()) {
    tasks.push({
      sys_id: gr.getUniqueValue(),
      name: gr.getValue("name"),
      status: gr.getValue("status"),
    })
  }

  response.setBody({
    result: tasks,
    count: tasks.length,
  })
})(request, response)
```

### Calling the API

```bash
curl -X GET \
  "https://instance.service-now.com/api/x_mycom_myapp/tasks" \
  -H "Authorization: Bearer token"
```

## Application Dependencies

### Declare Dependencies

```
Application > Dependencies
Add:
  - sn_hr_core (HR Core)
  - sn_cmdb (CMDB)
```

### Check Dependencies in Code

```javascript
// Check if plugin is active
if (GlidePluginManager.isActive("com.snc.hr.core")) {
  // HR Core is available
  var hrCase = new sn_hr_core.hr_case()
}
```

## Publishing to Store

### Checklist Before Publishing

```
□ All tables have proper ACLs
□ No hard-coded sys_ids
□ No hard-coded instance URLs
□ All dependencies declared
□ Properties have default values
□ Documentation complete
□ Test cases pass
□ No global scope modifications
□ Update Set tested on clean instance
```

### Version Management

```
Major.Minor.Patch
1.0.0 - Initial release
1.1.0 - New feature added
1.1.1 - Bug fix
2.0.0 - Breaking change
```

## Common Mistakes

| Mistake                          | Problem                  | Solution                   |
| -------------------------------- | ------------------------ | -------------------------- |
| Global modifications             | Won't deploy cleanly     | Keep changes in scope      |
| Hard-coded sys_ids               | Fails on other instances | Use properties or lookups  |
| Missing ACLs                     | Security vulnerabilities | Create ACLs for all tables |
| No error handling                | Silent failures          | Add try/catch, logging     |
| Accessing global tables directly | Upgrade conflicts        | Use references, not copies |

## Best Practices

1. **Single Responsibility** - One app per business function
2. **Explicit Dependencies** - Declare all requirements
3. **Property-Driven** - Configurable without code changes
4. **Defensive Coding** - Check access before operations
5. **Documentation** - Include README, release notes
6. **Testing** - Automated tests for critical functions
7. **Versioning** - Semantic versioning for updates
