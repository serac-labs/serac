---
name: workspace-builder
description: Build ServiceNow App Engine Studio applications — sys_scope creation, scoped tables, sys_aw_workspace with lists/forms, UI Builder pages and macroponents, data brokers, and application export readiness checks.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_execute_script
  - snow_artifact_manage
  - snow_update_set_manage
---

# App Engine Studio & Workspace Builder for ServiceNow

App Engine Studio (AES) enables low-code application development with custom workspaces.

## AES Architecture

```
Application (sys_scope)
    ├── Tables & Forms
    ├── Workflows
    ├── Workspaces (sys_aw_workspace)
    │   ├── Lists
    │   ├── Forms
    │   └── Dashboards
    └── Portals
```

## Key Tables

| Table                | Purpose              |
| -------------------- | -------------------- |
| `sys_scope`          | Application scope    |
| `sys_app`            | Application record   |
| `sys_aw_workspace`   | Workspace definition |
| `sys_ux_page`        | UI Builder pages     |
| `sys_ux_macroponent` | Custom components    |

## Application Development (ES5)

### Create Scoped Application

```javascript
// Create scoped application (ES5 ONLY!)
var app = new GlideRecord("sys_scope")
app.initialize()

// Basic info
app.setValue("name", "IT Asset Tracker")
app.setValue("scope", "x_myco_asset_track")
app.setValue("short_description", "Track IT assets across the organization")
app.setValue("version", "1.0.0")

// Vendor
app.setValue("vendor", "My Company")
app.setValue("vendor_prefix", "x_myco")

// License
app.setValue("licensable", true)

app.insert()
```

### Create Application Table

```javascript
// Create table in scoped app (ES5 ONLY!)
function createAppTable(scope, tableDef) {
  var table = new GlideRecord("sys_db_object")
  table.initialize()

  table.setValue("name", scope + "_" + tableDef.name)
  table.setValue("label", tableDef.label)
  table.setValue("super_class", tableDef.extends || "task")

  // Scope assignment
  table.setValue("sys_scope", getAppSysId(scope))

  // Options
  table.setValue("is_extendable", tableDef.extendable || false)
  table.setValue("create_access_controls", true)

  table.insert()

  // Create fields
  if (tableDef.fields) {
    for (var i = 0; i < tableDef.fields.length; i++) {
      createField(scope + "_" + tableDef.name, tableDef.fields[i])
    }
  }

  return table.getUniqueValue()
}

// Example
createAppTable("x_myco_asset_track", {
  name: "asset_item",
  label: "Asset Item",
  extends: "cmdb_ci",
  fields: [
    { name: "u_purchase_date", label: "Purchase Date", type: "glide_date" },
    { name: "u_warranty_end", label: "Warranty End", type: "glide_date" },
    { name: "u_assigned_user", label: "Assigned User", type: "reference", reference: "sys_user" },
  ],
})
```

## Workspace Configuration (ES5)

### Create Custom Workspace

```javascript
// Create workspace (ES5 ONLY!)
var workspace = new GlideRecord("sys_aw_workspace")
workspace.initialize()

workspace.setValue("name", "asset_tracker_workspace")
workspace.setValue("title", "Asset Tracker")
workspace.setValue("description", "Workspace for IT asset management")

// Primary table
workspace.setValue("primary_table", "x_myco_asset_track_asset_item")

// URL
workspace.setValue("url", "asset-tracker")

// Branding
workspace.setValue("icon", "laptop")
workspace.setValue("color", "#2E7D32")

// App scope
workspace.setValue("sys_scope", appScopeSysId)

// Features
workspace.setValue("agent_assist_enabled", false)
workspace.setValue("contextual_side_panel_enabled", true)

workspace.insert()
```

### Configure Workspace Lists

```javascript
// Create workspace list (ES5 ONLY!)
function createWorkspaceList(workspaceSysId, listDef) {
  var list = new GlideRecord("sys_aw_list")
  list.initialize()

  list.setValue("workspace", workspaceSysId)
  list.setValue("name", listDef.name)
  list.setValue("table", listDef.table)

  // Filter
  list.setValue("filter", listDef.filter || "")

  // Columns
  list.setValue("columns", listDef.columns.join(","))

  // Sorting
  if (listDef.orderBy) {
    list.setValue("order_by", listDef.orderBy)
    list.setValue("order_by_desc", listDef.orderDesc || false)
  }

  // Grouping
  if (listDef.groupBy) {
    list.setValue("group_by", listDef.groupBy)
  }

  list.insert()

  return list.getUniqueValue()
}

// Example lists
createWorkspaceList(workspaceSysId, {
  name: "My Assets",
  table: "x_myco_asset_track_asset_item",
  filter: "u_assigned_user=javascript:gs.getUserID()",
  columns: ["number", "name", "u_purchase_date", "u_warranty_end", "state"],
})

createWorkspaceList(workspaceSysId, {
  name: "Expiring Warranties",
  table: "x_myco_asset_track_asset_item",
  filter: "u_warranty_endBETWEENjavascript:gs.daysAgoStart(0)@javascript:gs.daysAgoEnd(-30)",
  columns: ["number", "name", "u_assigned_user", "u_warranty_end"],
  orderBy: "u_warranty_end",
})
```

## UI Builder Pages (ES5)

### Page Configuration

```javascript
// Create UI Builder page (ES5 ONLY!)
// Note: Full page creation typically done via UI Builder

var page = new GlideRecord("sys_ux_page")
page.initialize()

page.setValue("name", "asset_dashboard")
page.setValue("title", "Asset Dashboard")
page.setValue("description", "Dashboard for asset overview")

// Page type
page.setValue("page_type", "workspace")

// Workspace link
page.setValue("workspace", workspaceSysId)

// Scope
page.setValue("sys_scope", appScopeSysId)

page.insert()
```

### Custom Component (Macroponent)

```javascript
// Create custom macroponent definition (ES5 ONLY!)
// Note: Actual components created via UI Builder

var component = new GlideRecord("sys_ux_macroponent")
component.initialize()

component.setValue("name", "asset_summary_card")
component.setValue("label", "Asset Summary Card")
component.setValue("description", "Displays asset summary information")

// Component category
component.setValue("category", "data_visualization")

// Scope
component.setValue("sys_scope", appScopeSysId)

// Properties (inputs)
component.setValue(
  "properties",
  JSON.stringify([
    { name: "title", type: "string", label: "Card Title" },
    { name: "assetTable", type: "string", label: "Asset Table" },
    { name: "filter", type: "string", label: "Filter" },
  ]),
)

component.insert()
```

## Data Brokers (ES5)

### Create Data Broker

```javascript
// Data broker for workspace data (ES5 ONLY!)
// Data brokers provide data to UI Builder pages

var broker = new GlideRecord("sys_ux_data_broker")
broker.initialize()

broker.setValue("name", "asset_stats")
broker.setValue("label", "Asset Statistics")

// Data source type
broker.setValue("type", "script")

// Script to fetch data (ES5 ONLY!)
broker.setValue(
  "script",
  "(function getData(inputs) {\n" +
    "    var result = {\n" +
    "        total: 0,\n" +
    "        assigned: 0,\n" +
    "        available: 0,\n" +
    "        expiring_warranty: 0\n" +
    "    };\n" +
    "    \n" +
    '    var ga = new GlideAggregate("x_myco_asset_track_asset_item");\n' +
    '    ga.addAggregate("COUNT");\n' +
    '    ga.groupBy("state");\n' +
    "    ga.query();\n" +
    "    \n" +
    "    while (ga.next()) {\n" +
    '        var count = parseInt(ga.getAggregate("COUNT"), 10);\n' +
    "        result.total += count;\n" +
    "        \n" +
    '        var state = ga.getValue("state");\n' +
    '        if (state === "in_use") {\n' +
    "            result.assigned = count;\n" +
    '        } else if (state === "available") {\n' +
    "            result.available = count;\n" +
    "        }\n" +
    "    }\n" +
    "    \n" +
    "    // Expiring warranties\n" +
    '    var expiring = new GlideAggregate("x_myco_asset_track_asset_item");\n' +
    '    expiring.addQuery("u_warranty_end", "BETWEEN", "javascript:gs.daysAgoStart(0)@javascript:gs.daysAgoEnd(-30)");\n' +
    '    expiring.addAggregate("COUNT");\n' +
    "    expiring.query();\n" +
    "    \n" +
    "    if (expiring.next()) {\n" +
    '        result.expiring_warranty = parseInt(expiring.getAggregate("COUNT"), 10);\n' +
    "    }\n" +
    "    \n" +
    "    return result;\n" +
    "})(inputs);",
)

broker.setValue("sys_scope", appScopeSysId)

broker.insert()
```

## Application Deployment (ES5)

### Create Update Set

```javascript
// Create update set for app deployment (ES5 ONLY!)
function createAppUpdateSet(appName, description) {
  var updateSet = new GlideRecord("sys_update_set")
  updateSet.initialize()
  updateSet.setValue("name", appName + " - " + new GlideDateTime().getDate())
  updateSet.setValue("description", description)
  updateSet.setValue("application", getAppSysId(appName))
  updateSet.setValue("state", "in progress")
  return updateSet.insert()
}
```

### Export Application

```javascript
// Prepare app for export (ES5 ONLY!)
function prepareAppExport(appScope) {
  // Validate all components
  var issues = []

  // Check for missing dependencies
  var dependency = new GlideRecord("sys_app_dependency")
  dependency.addQuery("app.scope", appScope)
  dependency.query()

  while (dependency.next()) {
    if (!isDependencyInstalled(dependency.getValue("dependency"))) {
      issues.push("Missing dependency: " + dependency.dependency.getDisplayValue())
    }
  }

  // Validate update sets
  var updateSet = new GlideRecord("sys_update_set")
  updateSet.addQuery("application.scope", appScope)
  updateSet.addQuery("state", "in progress")
  updateSet.query()

  while (updateSet.next()) {
    issues.push("Open update set: " + updateSet.getValue("name"))
  }

  return {
    ready: issues.length === 0,
    issues: issues,
  }
}
```

## MCP Tool Integration

### Available Tools

| Tool                                  | Purpose              |
| ------------------------------------- | -------------------- |
| `snow_query_table`                    | Query app components |
| `snow_execute_script`                 | Test app scripts     |
| `snow_artifact_manage` (action='find') | Find configurations  |
| `snow_update_set_manage` (action='create') | Create update sets   |

### Example Workflow

```javascript
// 1. Query applications
await snow_query_table({
  table: "sys_scope",
  query: "scopeSTARTSWITHx_",
  fields: "name,scope,version,vendor",
})

// 2. Find app tables
await snow_query_table({
  table: "sys_db_object",
  query: "nameSTARTSWITHx_myco",
  fields: "name,label,super_class",
})

// 3. Get workspace configs
await snow_query_table({
  table: "sys_aw_workspace",
  query: "sys_scope.scopeSTARTSWITHx_",
  fields: "name,title,primary_table,url",
})
```

## Best Practices

1. **Naming Conventions** - Consistent prefixes
2. **Scoped Apps** - Use scope isolation
3. **Reusable Components** - Modular design
4. **Data Brokers** - Efficient data fetching
5. **Workspace Design** - User-focused layouts
6. **Testing** - ATF tests for apps
7. **Documentation** - App documentation
8. **ES5 Only** - No modern JavaScript syntax
