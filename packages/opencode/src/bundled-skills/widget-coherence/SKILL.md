---
name: widget-coherence
description: Build Service Portal widgets (sp_widget) with synchronized server/client/HTML — data.* initialization, ng-click + controller method matching, c.server.get action handlers, and Angular directive usage.
version: 1.0.0
tools:
  - snow_deploy
  - snow_update
  - snow_preview_widget
  - snow_widget_test
  - snow_find_artifact
  - snow_edit_artifact
---

# Widget Coherence for ServiceNow Service Portal

Service Portal widgets MUST have perfect communication between Server Script, Client Controller, and HTML Template. This is not optional - widgets fail when these components don't talk to each other correctly.

## The Three-Way Contract

Every widget requires synchronized communication:

### 1. Server Script Must:

- Initialize ALL `data.*` properties that HTML will reference
- Handle EVERY `input.action` that client sends via `c.server.get()`
- Return data in the format the client expects

### 2. Client Controller Must:

- Implement EVERY method called by `ng-click` in HTML
- Use `c.server.get({action: 'name'})` for server communication
- Update `c.data` when server responds

### 3. HTML Template Must:

- Only reference `data.*` properties that server provides
- Only call methods defined in client controller
- Use correct Angular directives and bindings

## Data Flow Patterns

### Server → Client → HTML

```javascript
// SERVER SCRIPT
;(function () {
  data.incidents = []
  data.loading = true

  var gr = new GlideRecord("incident")
  gr.addQuery("active", true)
  gr.setLimit(10)
  gr.query()

  while (gr.next()) {
    data.incidents.push({
      sys_id: gr.getUniqueValue(),
      number: gr.getValue("number"),
      short_description: gr.getValue("short_description"),
    })
  }
  data.loading = false
})()
```

```javascript
// CLIENT CONTROLLER
api.controller = function ($scope) {
  var c = this

  c.selectIncident = function (incident) {
    c.selectedIncident = incident
  }
}
```

```html
<!-- HTML TEMPLATE -->
<div ng-if="data.loading">Loading...</div>
<div ng-if="!data.loading">
  <div ng-repeat="incident in data.incidents" ng-click="c.selectIncident(incident)">
    {{incident.number}}: {{incident.short_description}}
  </div>
</div>
```

### Client → Server (Actions)

```javascript
// CLIENT CONTROLLER
c.saveIncident = function () {
  c.server
    .get({
      action: "save_incident",
      incident_data: c.formData,
    })
    .then(function (response) {
      if (response.data.success) {
        c.data.message = "Saved successfully"
      }
    })
}
```

```javascript
// SERVER SCRIPT
if (input && input.action === "save_incident") {
  var gr = new GlideRecord("incident")
  gr.initialize()
  gr.setValue("short_description", input.incident_data.short_description)
  data.new_sys_id = gr.insert()
  data.success = !!data.new_sys_id
}
```

## Validation Checklist

Before deploying a widget, verify:

- [ ] Every `data.property` in server is used in HTML or client
- [ ] Every `ng-click="c.method()"` has matching `c.method` in client
- [ ] Every `c.server.get({action: 'x'})` has matching `if(input.action === 'x')` in server
- [ ] No orphaned methods or unused data properties
- [ ] All `data.*` properties are initialized in server (even if empty)

## Common Failures

### Action Name Mismatch

```javascript
// CLIENT - sends 'saveIncident'
c.server.get({ action: "saveIncident" })

// SERVER - expects 'save_incident' (MISMATCH!)
if (input.action === "save_incident") {
}
```

### Method Name Mismatch

```html
<!-- HTML - calls saveData() -->
<button ng-click="c.saveData()">Save</button>
```

```javascript
// CLIENT - defines save() (MISMATCH!)
c.save = function () {}
```

### Undefined Data Properties

```html
<!-- HTML - references user.email -->
<span>{{data.user.email}}</span>
```

```javascript
// SERVER - only sets user.name (user.email is undefined!)
data.user = { name: userName }
```

## Angular Directives Reference

| Directive           | Purpose                                  |
| ------------------- | ---------------------------------------- |
| `ng-if`             | Conditionally render element             |
| `ng-show`/`ng-hide` | Toggle visibility (element stays in DOM) |
| `ng-repeat`         | Iterate over array                       |
| `ng-click`          | Handle click events                      |
| `ng-model`          | Two-way data binding                     |
| `ng-class`          | Dynamic CSS classes                      |
| `ng-disabled`       | Disable form elements                    |
