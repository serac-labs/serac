---
name: agent-workspace
description: Build ServiceNow Agent Workspace configurations — workspaces, lists, forms, contextual side panels, Agent Assist similar-record finders, and workspace-specific UI actions on sys_aw_* tables.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_create_workspace
  - snow_query_table
  - snow_artifact_manage
  - snow_execute_script
---

# Agent Workspace for ServiceNow

Agent Workspace provides a modern, configurable interface for fulfiller productivity.

## Workspace Architecture

```
Workspace (sys_aw_workspace)
    ├── Lists (sys_aw_list)
    ├── Forms (sys_aw_form)
    ├── Related Lists
    ├── UI Actions
    └── Contextual Side Panel
        ├── Agent Assist
        ├── Related Records
        └── Activity Stream
```

## Key Tables

| Table                 | Purpose               |
| --------------------- | --------------------- |
| `sys_aw_workspace`    | Workspace definitions |
| `sys_aw_list`         | List configurations   |
| `sys_aw_form`         | Form configurations   |
| `sys_aw_related_list` | Related list configs  |
| `sys_aw_action`       | Workspace UI actions  |

## Workspace Configuration (ES5)

### Create Workspace

```javascript
// Create workspace (ES5 ONLY!)
var workspace = new GlideRecord("sys_aw_workspace")
workspace.initialize()

// Basic info
workspace.setValue("name", "IT Service Desk Workspace")
workspace.setValue("title", "IT Service Desk")
workspace.setValue("description", "Workspace for IT service desk agents")

// Primary table
workspace.setValue("primary_table", "incident")

// URL path
workspace.setValue("url", "it-service-desk")

// Icon and branding
workspace.setValue("icon", "support")
workspace.setValue("color", "#0056B3")

// Default list
workspace.setValue("default_list", getListConfig("incident_active"))

// Enable features
workspace.setValue("agent_assist_enabled", true)
workspace.setValue("contextual_side_panel_enabled", true)
workspace.setValue("activity_stream_enabled", true)

workspace.insert()
```

### Workspace List Configuration

```javascript
// Create list configuration (ES5 ONLY!)
var list = new GlideRecord("sys_aw_list")
list.initialize()

list.setValue("name", "My Active Incidents")
list.setValue("table", "incident")
list.setValue("workspace", workspaceSysId)

// Filter
list.setValue("filter", "active=true^assigned_to=javascript:gs.getUserID()")

// Columns
list.setValue("columns", "number,short_description,priority,state,caller_id,opened_at")

// Sort
list.setValue("order_by", "priority")
list.setValue("order_by_desc", false)

// Row actions
list.setValue("show_row_actions", true)

// Grouping (optional)
list.setValue("group_by", "priority")

list.insert()
```

### Workspace Form Configuration

```javascript
// Create form configuration (ES5 ONLY!)
var form = new GlideRecord("sys_aw_form")
form.initialize()

form.setValue("name", "Incident Form")
form.setValue("table", "incident")
form.setValue("workspace", workspaceSysId)

// Form sections
var sections = [
  {
    name: "Details",
    columns: 2,
    fields: ["number", "state", "caller_id", "opened_at", "short_description", "priority"],
  },
  {
    name: "Assignment",
    columns: 2,
    fields: ["assignment_group", "assigned_to", "escalation"],
  },
  {
    name: "Resolution",
    columns: 1,
    fields: ["resolution_code", "close_notes"],
    condition: "state=6^ORstate=7", // Only show for resolved/closed
  },
]

form.setValue("sections", JSON.stringify(sections))

// Related lists
form.setValue("related_lists", "incident.task_sla,incident.sys_attachment")

// Enable Agent Assist
form.setValue("agent_assist_enabled", true)

form.insert()
```

## Contextual Side Panel (ES5)

### Configure Side Panel

```javascript
// Side panel configuration (ES5 ONLY!)
var panel = new GlideRecord("sys_aw_contextual_side_panel")
panel.initialize()

panel.setValue("workspace", workspaceSysId)
panel.setValue("table", "incident")
panel.setValue("name", "Incident Context")

// Tabs
var tabs = [
  {
    id: "agent_assist",
    label: "Agent Assist",
    icon: "lightbulb-outline",
    component: "agent-assist",
  },
  {
    id: "caller_info",
    label: "Caller Info",
    icon: "user",
    component: "custom-caller-info",
  },
  {
    id: "related",
    label: "Related Records",
    icon: "link",
    component: "related-records",
  },
  {
    id: "activity",
    label: "Activity",
    icon: "history",
    component: "activity-stream",
  },
]

panel.setValue("tabs", JSON.stringify(tabs))
panel.setValue("default_tab", "agent_assist")

panel.insert()
```

### Custom Panel Component (ES5)

```javascript
// Widget for side panel (ES5 ONLY!)
// Server Script
;(function () {
  // Get current record from context
  var recordSysId = input.sys_id
  var tableName = input.table

  if (tableName === "incident" && recordSysId) {
    var gr = new GlideRecord("incident")
    if (gr.get(recordSysId)) {
      // Get caller information
      data.caller = {
        name: gr.caller_id.getDisplayValue(),
        email: gr.caller_id.email.getDisplayValue(),
        phone: gr.caller_id.phone.getDisplayValue(),
        location: gr.caller_id.location.getDisplayValue(),
        vip: gr.caller_id.vip.getDisplayValue() === "true",
      }

      // Get caller's open incidents
      data.openIncidents = []
      var incidents = new GlideRecord("incident")
      incidents.addQuery("caller_id", gr.getValue("caller_id"))
      incidents.addQuery("active", true)
      incidents.addQuery("sys_id", "!=", recordSysId)
      incidents.orderByDesc("opened_at")
      incidents.setLimit(5)
      incidents.query()

      while (incidents.next()) {
        data.openIncidents.push({
          sys_id: incidents.getUniqueValue(),
          number: incidents.getValue("number"),
          short_description: incidents.getValue("short_description"),
          state: incidents.state.getDisplayValue(),
        })
      }
    }
  }
})()
```

## Agent Assist (ES5)

### Configure Agent Assist

```javascript
// Agent Assist configuration (ES5 ONLY!)
var config = new GlideRecord("sys_aw_agent_assist_config")
config.initialize()

config.setValue("workspace", workspaceSysId)
config.setValue("table", "incident")
config.setValue("name", "Incident Agent Assist")
config.setValue("active", true)

// Recommendations sources
config.setValue("show_knowledge", true)
config.setValue("show_similar_incidents", true)
config.setValue("show_solutions", true)
config.setValue("show_macros", true)

// Knowledge search configuration
config.setValue("knowledge_bases", kbSysIds) // Comma-separated
config.setValue("knowledge_search_fields", "short_description,description")

config.insert()
```

### Similar Records Script (ES5)

```javascript
// Find similar incidents for Agent Assist (ES5 ONLY!)
var SimilarIncidentFinder = Class.create()
SimilarIncidentFinder.prototype = {
  initialize: function () {},

  /**
   * Find similar resolved incidents
   */
  findSimilar: function (incidentSysId) {
    var current = new GlideRecord("incident")
    if (!current.get(incidentSysId)) {
      return []
    }

    var similar = []
    var keywords = this._extractKeywords(current.getValue("short_description"))

    // Search resolved incidents
    var gr = new GlideRecord("incident")
    gr.addQuery("state", "IN", "6,7") // Resolved or Closed
    gr.addQuery("sys_id", "!=", incidentSysId)

    // Match by category
    if (current.category) {
      gr.addQuery("category", current.getValue("category"))
    }

    // Match by CI
    if (current.cmdb_ci) {
      gr.addOrCondition("cmdb_ci", current.getValue("cmdb_ci"))
    }

    // Keyword matching
    for (var i = 0; i < keywords.length && i < 3; i++) {
      gr.addOrCondition("short_description", "CONTAINS", keywords[i])
    }

    gr.setLimit(10)
    gr.orderByDesc("resolved_at")
    gr.query()

    while (gr.next()) {
      var score = this._calculateSimilarity(current, gr)
      if (score > 0.3) {
        similar.push({
          sys_id: gr.getUniqueValue(),
          number: gr.getValue("number"),
          short_description: gr.getValue("short_description"),
          resolution_code: gr.resolution_code.getDisplayValue(),
          close_notes: gr.getValue("close_notes"),
          score: Math.round(score * 100),
        })
      }
    }

    // Sort by similarity score
    similar.sort(function (a, b) {
      return b.score - a.score
    })

    return similar.slice(0, 5)
  },

  _extractKeywords: function (text) {
    var stopWords = ["the", "is", "at", "which", "on", "a", "an", "and", "or", "not", "to", "for"]
    var words = text.toLowerCase().split(/\s+/)
    var keywords = []

    for (var i = 0; i < words.length; i++) {
      var word = words[i].replace(/[^a-z0-9]/g, "")
      if (word.length > 3 && stopWords.indexOf(word) === -1) {
        keywords.push(word)
      }
    }

    return keywords
  },

  _calculateSimilarity: function (source, target) {
    var score = 0

    // Category match
    if (source.getValue("category") === target.getValue("category")) {
      score += 0.3
    }

    // Subcategory match
    if (source.getValue("subcategory") === target.getValue("subcategory")) {
      score += 0.2
    }

    // CI match
    if (source.getValue("cmdb_ci") === target.getValue("cmdb_ci")) {
      score += 0.3
    }

    // Keyword overlap
    var sourceKeywords = this._extractKeywords(source.getValue("short_description"))
    var targetKeywords = this._extractKeywords(target.getValue("short_description"))
    var overlap = 0

    for (var i = 0; i < sourceKeywords.length; i++) {
      if (targetKeywords.indexOf(sourceKeywords[i]) !== -1) {
        overlap++
      }
    }

    if (sourceKeywords.length > 0) {
      score += 0.2 * (overlap / sourceKeywords.length)
    }

    return score
  },

  type: "SimilarIncidentFinder",
}
```

## Workspace UI Actions (ES5)

### Create Workspace Action

```javascript
// Create workspace-specific UI action (ES5 ONLY!)
var action = new GlideRecord("sys_aw_action")
action.initialize()

action.setValue("name", "Quick Resolve")
action.setValue("label", "Quick Resolve")
action.setValue("workspace", workspaceSysId)
action.setValue("table", "incident")

// Action type
action.setValue("action_type", "form") // form, list, both
action.setValue("order", 100)

// Condition
action.setValue("condition", "current.active == true && current.state != 6")

// Client action (opens modal)
action.setValue(
  "client_script",
  "function onClick() {\n" +
    "    spModal.open({\n" +
    '        title: "Quick Resolve",\n' +
    '        widget: "quick-resolve-modal",\n' +
    "        widgetInput: { table: g_form.getTableName(), sys_id: g_form.getUniqueValue() }\n" +
    "    }).then(function(result) {\n" +
    "        if (result) {\n" +
    '            g_form.setValue("state", 6);\n' +
    '            g_form.setValue("resolution_code", result.code);\n' +
    '            g_form.setValue("close_notes", result.notes);\n' +
    "            g_form.save();\n" +
    "        }\n" +
    "    });\n" +
    "}",
)

// Icon and style
action.setValue("icon", "check-circle")
action.setValue("button_class", "btn-success")

action.insert()
```

## MCP Tool Integration

### Available Tools

| Tool                   | Purpose                                       |
| ---------------------- | --------------------------------------------- |
| `snow_artifact_manage` | Find workspace widgets (`action: "find"`)     |
| `snow_query_table`     | Query workspace tables                        |
| `snow_artifact_manage` | Deploy workspace widgets (`action: "create"`) |
| `snow_execute_script`  | Test workspace scripts                        |

### Example Workflow

```javascript
// 1. Find workspaces
await snow_query_table({
  table: "sys_aw_workspace",
  query: "active=true",
  fields: "name,title,primary_table,url",
})

// 2. Get list configurations
await snow_query_table({
  table: "sys_aw_list",
  query: "workspace.name=IT Service Desk Workspace",
  fields: "name,table,filter,columns",
})

// 3. Test similar incident finder
await snow_execute_script({
  script: `
        var finder = new SimilarIncidentFinder();
        var similar = finder.findSimilar('incident_sys_id');
        gs.info('Found: ' + similar.length);
    `,
})
```

## Best Practices

1. **Role-Based** - Design for specific roles
2. **Efficient Lists** - Optimized filters and columns
3. **Context Panel** - Relevant information accessible
4. **Agent Assist** - Enable knowledge/similar records
5. **Actions** - Streamline common tasks
6. **Performance** - Lazy load components
7. **Mobile Ready** - Test responsive layouts
8. **ES5 Only** - No modern JavaScript syntax
