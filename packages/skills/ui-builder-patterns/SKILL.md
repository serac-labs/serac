---
name: ui-builder-patterns
description: Build ServiceNow UI Builder / Next Experience pages — macroponents, GraphQL/script data brokers, client state parameters, event handlers (NOW_RECORD_LIST etc.), and now-record-list/form component configuration.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
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

# UI Builder Patterns for ServiceNow

UI Builder (UIB) is ServiceNow's modern framework for building Next Experience workspaces and applications.

## UI Builder Architecture

### Component Hierarchy

```
UX Application
└── App Shell
    └── Chrome (Header, Navigation)
        └── Pages
            └── Variants
                └── Macroponents
                    └── Components
                        └── Elements
```

### Key Concepts

| Concept          | Description                                  |
| ---------------- | -------------------------------------------- |
| **Macroponent**  | Reusable container with components and logic |
| **Component**    | UI building block (list, form, button)       |
| **Data Broker**  | Fetches and manages data for components      |
| **Client State** | Page-level state management                  |
| **Event**        | Communication between components             |

## Page Structure

### Page Anatomy

```
Page: incident_list
├── Variants
│   ├── Default (desktop)
│   └── Mobile
├── Data Brokers
│   ├── incident_data (GraphQL)
│   └── user_preferences (Script)
├── Client States
│   ├── selectedRecord
│   └── filterActive
├── Events
│   ├── RECORD_SELECTED
│   └── FILTER_APPLIED
└── Layout
    ├── Header (macroponent)
    ├── Sidebar (macroponent)
    └── Content (macroponent)
```

## Data Brokers

### Types of Data Brokers

| Type          | Use Case          | Example            |
| ------------- | ----------------- | ------------------ |
| **GraphQL**   | Table queries     | Incident list      |
| **Script**    | Complex logic     | Calculated metrics |
| **REST**      | External APIs     | Weather data       |
| **Transform** | Data manipulation | Format dates       |

### GraphQL Data Broker

```javascript
// Data Broker: incident_list
// Type: GraphQL

// Query
query ($limit: Int, $query: String) {
  GlideRecord_Query {
    incident(
      queryConditions: $query
      limit: $limit
    ) {
      number { value displayValue }
      short_description { value }
      priority { value displayValue }
      state { value displayValue }
      assigned_to { value displayValue }
      sys_id { value }
    }
  }
}

// Variables (from client state or props)
{
  "limit": 50,
  "query": "active=true"
}
```

### Script Data Broker (ES5)

```javascript
// Data Broker: incident_metrics
// Type: Script

;(function execute(inputs, outputs) {
  var result = {
    total: 0,
    byPriority: {},
    avgAge: 0,
  }

  var gr = new GlideRecord("incident")
  gr.addQuery("active", true)
  gr.query()

  var totalAge = 0
  while (gr.next()) {
    result.total++

    // Count by priority
    var priority = gr.getValue("priority")
    if (!result.byPriority[priority]) {
      result.byPriority[priority] = 0
    }
    result.byPriority[priority]++

    // Calculate age
    var opened = new GlideDateTime(gr.getValue("opened_at"))
    var now = new GlideDateTime()
    var age = gs.dateDiff(opened, now, true)
    totalAge += parseInt(age)
  }

  if (result.total > 0) {
    result.avgAge = Math.round(totalAge / result.total / 3600) // hours
  }

  outputs.metrics = result
})(inputs, outputs)
```

## Client State Parameters

### Defining Client State

```json
// Page Client State Parameters
{
  "selectedIncident": {
    "type": "string",
    "default": ""
  },
  "filterQuery": {
    "type": "string",
    "default": "active=true"
  },
  "viewMode": {
    "type": "string",
    "default": "list",
    "enum": ["list", "card", "split"]
  },
  "selectedRecords": {
    "type": "array",
    "items": { "type": "string" },
    "default": []
  }
}
```

### Using Client State in Components

```javascript
// In component configuration
{
  "query": "@state.filterQuery",
  "selectedItem": "@state.selectedIncident"
}

// Updating client state via event
{
  "eventName": "NOW_RECORD_LIST#RECORD_SELECTED",
  "handlers": [
    {
      "action": "UPDATE_CLIENT_STATE",
      "payload": {
        "selectedIncident": "@payload.sys_id"
      }
    }
  ]
}
```

## Events and Handlers

### Event Types

| Event                             | Trigger         | Payload           |
| --------------------------------- | --------------- | ----------------- |
| `NOW_RECORD_LIST#RECORD_SELECTED` | Row click       | { sys_id, table } |
| `NOW_BUTTON#CLICKED`              | Button click    | { label }         |
| `NOW_DROPDOWN#SELECTED`           | Dropdown change | { value }         |
| `CUSTOM#EVENT_NAME`               | Custom event    | Custom payload    |

### Event Handler Configuration

```json
// Event: Record Selected
{
  "eventName": "NOW_RECORD_LIST#RECORD_SELECTED",
  "handlers": [
    {
      "action": "UPDATE_CLIENT_STATE",
      "payload": {
        "selectedIncident": "@payload.sys_id"
      }
    },
    {
      "action": "REFRESH_DATA_BROKER",
      "payload": {
        "dataBrokerId": "incident_details"
      }
    },
    {
      "action": "DISPATCH_EVENT",
      "payload": {
        "eventName": "INCIDENT_SELECTED",
        "payload": "@payload"
      }
    }
  ]
}
```

### Client Script Event Handler (ES5)

```javascript
// Client Script for custom event handling
;(function (coeffects) {
  var dispatch = coeffects.dispatch
  var state = coeffects.state
  var payload = coeffects.action.payload

  // Custom logic
  var selectedId = payload.sys_id

  // Update multiple states
  dispatch("UPDATE_CLIENT_STATE", {
    selectedIncident: selectedId,
    detailsVisible: true,
  })

  // Conditional dispatch
  if (payload.priority === "1") {
    dispatch("DISPATCH_EVENT", {
      eventName: "CRITICAL_INCIDENT_SELECTED",
      payload: payload,
    })
  }
})(coeffects)
```

## Component Configuration

### Common Components

| Component         | Purpose        | Key Properties        |
| ----------------- | -------------- | --------------------- |
| `now-record-list` | Data table     | columns, query, table |
| `now-record-form` | Record form    | table, sysId, fields  |
| `now-button`      | Action button  | label, variant, icon  |
| `now-card`        | Card container | header, content       |
| `now-tabs`        | Tab container  | tabs, activeTab       |
| `now-modal`       | Modal dialog   | opened, title         |

### Record List Configuration

```json
{
  "component": "now-record-list",
  "properties": {
    "table": "incident",
    "query": "@state.filterQuery",
    "columns": [
      { "field": "number", "label": "Number" },
      { "field": "short_description", "label": "Description" },
      { "field": "priority", "label": "Priority" },
      { "field": "state", "label": "State" },
      { "field": "assigned_to", "label": "Assigned To" }
    ],
    "pageSize": 20,
    "selectable": true,
    "selectedRecords": "@state.selectedRecords"
  }
}
```

### Form Configuration

```json
{
  "component": "now-record-form",
  "properties": {
    "table": "incident",
    "sysId": "@state.selectedIncident",
    "fields": ["short_description", "description", "priority", "assignment_group", "assigned_to"],
    "readOnly": false
  }
}
```

## Macroponents

### Creating Reusable Macroponents

```
Macroponent: incident-summary-card
├── Properties (inputs)
│   ├── incidentSysId (string)
│   └── showActions (boolean)
├── Internal State
│   └── expanded (boolean)
├── Data Broker
│   └── incident_data (uses incidentSysId)
└── Layout
    ├── now-card
    │   ├── Header: @data.incident.number
    │   ├── Content: @data.incident.short_description
    │   └── Footer: Action buttons
    └── now-modal (if expanded)
```

### Macroponent Properties

```json
{
  "properties": {
    "incidentSysId": {
      "type": "string",
      "required": true,
      "description": "Sys ID of incident to display"
    },
    "showActions": {
      "type": "boolean",
      "default": true,
      "description": "Show action buttons"
    },
    "variant": {
      "type": "string",
      "default": "default",
      "enum": ["default", "compact", "detailed"]
    }
  }
}
```

## MCP Tool Integration

### Available UIB Tools

| Tool                                       | Purpose               |
| ------------------------------------------ | --------------------- |
| `snow_uib_page_manage` (action='create')   | Create new page       |
| `snow_uib_page_manage` (action='add_element') | Add component to page |
| `snow_create_uib_data_broker`              | Create data broker    |
| `snow_create_uib_client_state`             | Define client state   |
| `snow_create_uib_event`                    | Configure events      |
| `snow_create_complete_workspace`           | Full workspace        |
| `snow_record_manage` (action='update')     | Modify page           |

### Example Workflow

```javascript
// 1. Create workspace
await snow_create_complete_workspace({
  name: "IT Support Workspace",
  description: "Agent workspace for IT support",
  landing_page: "incident_list",
})

// 2. Create data broker
await snow_create_uib_data_broker({
  page_id: pageId,
  name: "incident_list",
  type: "graphql",
  query: incidentQuery,
})

// 3. Add components
await snow_uib_page_manage({
  action: "add_element",
  page_id: pageId,
  component: "now-record-list",
  properties: listConfig,
})

// 4. Configure events
await snow_create_uib_event({
  page_id: pageId,
  event_name: "NOW_RECORD_LIST#RECORD_SELECTED",
  handlers: eventHandlers,
})
```

## Best Practices

1. **Use Data Brokers** - Never fetch data directly in components
2. **Client State for UI** - Use for filters, selections, view modes
3. **Events for Communication** - Decouple components via events
4. **Macroponents for Reuse** - Create reusable building blocks
5. **GraphQL for Queries** - More efficient than Script brokers
6. **Review Structure** - Manually verify page layout and bindings before deployment
7. **Mobile Variants** - Create responsive variants
8. **Accessibility** - Follow WCAG guidelines
