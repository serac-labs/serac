---
name: integration-hub
description: Build ServiceNow IntegrationHub spokes — sn_ih_spoke definitions, sn_ih_action with inputs/outputs, REST/script steps, connection and credential aliases (sys_alias), and retry logic for transient failures.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_artifact_manage
  - snow_test_rest_connection
  - snow_execute_script
---

# IntegrationHub for ServiceNow

IntegrationHub provides reusable integration components for Flow Designer and workflows.

## IntegrationHub Architecture

```
Spoke (sn_ih_spoke)
    ├── Actions (sn_ih_action)
    │   ├── Inputs
    │   ├── Steps
    │   └── Outputs
    ├── Connection Alias
    └── Credential Alias

Flow Designer
    └── Uses Spoke Actions
```

## Key Tables

| Table               | Purpose                       |
| ------------------- | ----------------------------- |
| `sn_ih_spoke`       | Spoke definitions             |
| `sn_ih_action`      | Spoke actions                 |
| `sn_ih_step_config` | Action step configuration     |
| `sys_alias`         | Connection/credential aliases |

## Connection & Credential Aliases (ES5)

### Create Connection Alias

```javascript
// Create connection alias (ES5 ONLY!)
var alias = new GlideRecord("sys_alias")
alias.initialize()

alias.setValue("name", "Jira Connection")
alias.setValue("id", "x_myapp_jira_connection")
alias.setValue("type", "connection")
alias.setValue("connection_type", "http")

// Connection attributes
alias.setValue(
  "attributes",
  JSON.stringify({
    base_url: "https://mycompany.atlassian.net/rest/api/3",
    timeout: 30000,
  }),
)

alias.insert()
```

### Create Credential Alias

```javascript
// Create credential alias (ES5 ONLY!)
var credAlias = new GlideRecord("sys_alias")
credAlias.initialize()

credAlias.setValue("name", "Jira API Token")
credAlias.setValue("id", "x_myapp_jira_credential")
credAlias.setValue("type", "credential")

credAlias.insert()

// Link to actual credential
var credential = new GlideRecord("basic_auth_credentials")
credential.initialize()
credential.setValue("name", "Jira API Token Credential")
credential.setValue("user_name", "api-user@company.com")
credential.setValue("password", "") // Set via secure method
credential.insert()

// Create alias-credential mapping
var mapping = new GlideRecord("sys_alias_credential")
mapping.initialize()
mapping.setValue("alias", credAlias.getUniqueValue())
mapping.setValue("credential", credential.getUniqueValue())
mapping.insert()
```

## Spoke Development (ES5)

### Create Custom Spoke

```javascript
// Create spoke (ES5 ONLY!)
var spoke = new GlideRecord("sn_ih_spoke")
spoke.initialize()

spoke.setValue("name", "Custom ITSM Connector")
spoke.setValue("label", "Custom ITSM Connector")
spoke.setValue("description", "Integration with external ITSM system")
spoke.setValue("vendor", "My Company")
spoke.setValue("version", "1.0.0")

// Scope
spoke.setValue("scope", "x_myapp_itsm")

// Logo
spoke.setValue("logo", "attachment_sys_id")

spoke.insert()
```

### Create Spoke Action

```javascript
// Create action for spoke (ES5 ONLY!)
var action = new GlideRecord("sn_ih_action")
action.initialize()

action.setValue("name", "Create External Ticket")
action.setValue("label", "Create External Ticket")
action.setValue("spoke", spokeSysId)
action.setValue("description", "Creates a ticket in external ITSM system")

// Category
action.setValue("category", "record_operations")

// Accessibility
action.setValue("accessible_from", "flow_designer")

action.insert()

// Add inputs
addActionInput(action.getUniqueValue(), "summary", "String", true, "Ticket summary")
addActionInput(action.getUniqueValue(), "description", "String", false, "Ticket description")
addActionInput(action.getUniqueValue(), "priority", "String", false, "Priority level")

// Add outputs
addActionOutput(action.getUniqueValue(), "ticket_id", "String", "Created ticket ID")
addActionOutput(action.getUniqueValue(), "ticket_url", "String", "URL to ticket")
```

### Action Input/Output Helpers

```javascript
// Add action input (ES5 ONLY!)
function addActionInput(actionSysId, name, type, mandatory, label) {
  var input = new GlideRecord("sn_ih_input")
  input.initialize()
  input.setValue("action", actionSysId)
  input.setValue("name", name)
  input.setValue("label", label)
  input.setValue("type", type)
  input.setValue("mandatory", mandatory)
  input.setValue("order", getNextOrder(actionSysId, "input"))
  return input.insert()
}

// Add action output (ES5 ONLY!)
function addActionOutput(actionSysId, name, type, label) {
  var output = new GlideRecord("sn_ih_output")
  output.initialize()
  output.setValue("action", actionSysId)
  output.setValue("name", name)
  output.setValue("label", label)
  output.setValue("type", type)
  output.setValue("order", getNextOrder(actionSysId, "output"))
  return output.insert()
}
```

## Action Steps (ES5)

### REST Step Configuration

```javascript
// Create REST step for action (ES5 ONLY!)
var step = new GlideRecord("sn_ih_step_config")
step.initialize()

step.setValue("action", actionSysId)
step.setValue("name", "Call External API")
step.setValue("order", 100)
step.setValue("step_type", "rest")

// REST configuration
step.setValue(
  "rest_config",
  JSON.stringify({
    connection_alias: "x_myapp_jira_connection",
    credential_alias: "x_myapp_jira_credential",
    http_method: "POST",
    resource_path: "/issue",
    request_body: {
      fields: {
        project: { key: "${inputs.project_key}" },
        summary: "${inputs.summary}",
        description: "${inputs.description}",
        issuetype: { name: "Task" },
      },
    },
    headers: {
      "Content-Type": "application/json",
    },
  }),
)

step.insert()
```

### Script Step

```javascript
// Create script step (ES5 ONLY!)
var scriptStep = new GlideRecord("sn_ih_step_config")
scriptStep.initialize()

scriptStep.setValue("action", actionSysId)
scriptStep.setValue("name", "Process Response")
scriptStep.setValue("order", 200)
scriptStep.setValue("step_type", "script")

// Script (ES5 ONLY!)
scriptStep.setValue(
  "script",
  "(function execute(inputs, outputs) {\n" +
    "    // Get REST response from previous step\n" +
    "    var response = inputs.rest_response;\n" +
    "    \n" +
    "    if (response.status_code === 201) {\n" +
    "        var body = JSON.parse(response.body);\n" +
    "        outputs.ticket_id = body.id;\n" +
    "        outputs.ticket_url = body.self;\n" +
    "        outputs.success = true;\n" +
    "    } else {\n" +
    "        outputs.success = false;\n" +
    '        outputs.error_message = "Failed: " + response.status_code;\n' +
    "    }\n" +
    "})(inputs, outputs);",
)

scriptStep.insert()
```

## Subflows for Reuse (ES5)

### Create Integration Subflow

```javascript
// Subflows encapsulate reusable integration logic
// Created via Flow Designer UI, but can be invoked via script

// Invoke subflow from script (ES5 ONLY!)
var inputs = {
  ticket_id: "INC0010001",
  action: "update",
  fields: {
    status: "resolved",
    resolution: "Fixed",
  },
}

// Start subflow
sn_fd.FlowAPI.startSubflow("x_myapp_update_external_ticket", inputs)
```

### Execute Action from Script

```javascript
// Execute spoke action from script (ES5 ONLY!)
var actionInputs = {
  summary: "New ticket from ServiceNow",
  description: "Created via integration",
  priority: "Medium",
}

try {
  var result = sn_fd.FlowAPI.executeAction("x_myapp_itsm.create_external_ticket", actionInputs)

  if (result.outputs.success) {
    gs.info("Created ticket: " + result.outputs.ticket_id)
  } else {
    gs.error("Failed: " + result.outputs.error_message)
  }
} catch (e) {
  gs.error("Action execution failed: " + e.message)
}
```

## Error Handling (ES5)

### Action Error Handling

```javascript
// Error handling in action script (ES5 ONLY!)
;(function execute(inputs, outputs) {
  try {
    // Main logic
    var response = callExternalAPI(inputs)

    if (response.status_code >= 400) {
      throw new Error("API error: " + response.status_code + " - " + response.body)
    }

    outputs.result = JSON.parse(response.body)
    outputs.success = true
  } catch (e) {
    outputs.success = false
    outputs.error_code = "INTEGRATION_ERROR"
    outputs.error_message = e.message

    // Log for debugging
    gs.error("IntegrationHub action failed: " + e.message)

    // Optionally throw to trigger Flow Designer error handling
    // throw e;
  }
})(inputs, outputs)
```

### Retry Logic

```javascript
// Retry wrapper for transient failures (ES5 ONLY!)
function executeWithRetry(fn, maxRetries, delayMs) {
  var attempts = 0
  var lastError = null

  while (attempts < maxRetries) {
    try {
      return fn()
    } catch (e) {
      lastError = e
      attempts++

      if (attempts < maxRetries) {
        gs.info("Retry " + attempts + " of " + maxRetries + " after error: " + e.message)
        gs.sleep(delayMs * attempts) // Exponential backoff
      }
    }
  }

  throw new Error("Failed after " + maxRetries + " attempts: " + lastError.message)
}
```

## MCP Tool Integration

### Available Tools

| Tool                              | Purpose                  |
| --------------------------------- | ------------------------ |
| `snow_query_table`                | Query spokes and actions |
| `snow_artifact_manage` (action='find') | Find integration configs |
| `snow_test_rest_connection`       | Test connections         |
| `snow_execute_script`             | Test action scripts      |

### Example Workflow

```javascript
// 1. Find available spokes
await snow_query_table({
  table: "sn_ih_spoke",
  query: "active=true",
  fields: "name,label,vendor,version",
})

// 2. Get spoke actions
await snow_query_table({
  table: "sn_ih_action",
  query: "spoke.name=Jira Spoke",
  fields: "name,label,description,category",
})

// 3. Test connection
await snow_test_rest_connection({
  connection_alias: "x_myapp_jira_connection",
  credential_alias: "x_myapp_jira_credential",
})
```

## Best Practices

1. **Connection Aliases** - Abstract connection details
2. **Credential Security** - Never hardcode credentials
3. **Error Handling** - Graceful failure handling
4. **Retry Logic** - Handle transient failures
5. **Logging** - Comprehensive debug logging
6. **Testing** - Test with mock data first
7. **Versioning** - Track spoke versions
8. **ES5 Only** - No modern JavaScript syntax
