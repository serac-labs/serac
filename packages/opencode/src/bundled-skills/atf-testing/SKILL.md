---
name: atf-testing
description: Build ServiceNow Automated Test Framework tests and suites — impersonation, form steps, assertions, server-side script steps, test parameters, and execution via snow_create_atf_test / snow_execute_atf_test.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_atf_test_create
  - snow_atf_test_run
  - snow_query_table
  - snow_find_artifact
---

# Automated Test Framework (ATF) for ServiceNow

ATF provides automated testing capabilities for ServiceNow applications, enabling regression testing and continuous integration.

## ATF Architecture

### Test Hierarchy

```
Test Suite: Incident Management Tests
├── Test: Create Incident
│   ├── Step 1: Impersonate User
│   ├── Step 2: Open New Record
│   ├── Step 3: Set Field Values
│   ├── Step 4: Submit Form
│   └── Step 5: Assert Values
├── Test: Assign Incident
│   └── Steps...
└── Test: Resolve Incident
    └── Steps...
```

### Key Tables

| Table                     | Purpose                  |
| ------------------------- | ------------------------ |
| `sys_atf_test`            | Test definitions         |
| `sys_atf_step`            | Individual test steps    |
| `sys_atf_test_suite`      | Test suite groupings     |
| `sys_atf_test_suite_test` | Suite-test relationships |
| `sys_atf_test_result`     | Test execution results   |

## Test Step Types

### Common Step Types

| Step Type                  | Purpose              | Example                   |
| -------------------------- | -------------------- | ------------------------- |
| **Impersonate**            | Run as specific user | Test as ITIL user         |
| **Open a New Form**        | Create new record    | New incident form         |
| **Open an Existing Form**  | Edit record          | Open INC0010001           |
| **Set Field Values**       | Populate fields      | Set priority, description |
| **Click a UI Action**      | Trigger button       | Click "Save"              |
| **Assert Field Values**    | Validate values      | Priority = 1              |
| **Run Server Side Script** | Execute script       | Custom validation         |
| **Wait**                   | Pause execution      | Wait for async            |

## Creating Tests

### Basic Test Structure (ES5)

```javascript
// Create a new ATF test
var test = new GlideRecord("sys_atf_test")
test.initialize()
test.setValue("name", "Test: Create High Priority Incident")
test.setValue("description", "Verify high priority incident creation workflow")
test.setValue("active", true)
test.setValue("application", "global") // or scoped app sys_id
var testSysId = test.insert()

// Add test steps
function addTestStep(testId, order, stepType, config) {
  var step = new GlideRecord("sys_atf_step")
  step.initialize()
  step.setValue("test", testId)
  step.setValue("order", order)
  step.setValue("step_config", stepType)

  // Set step-specific configuration
  for (var key in config) {
    if (config.hasOwnProperty(key)) {
      step.setValue(key, config[key])
    }
  }

  return step.insert()
}
```

### Impersonate Step

```javascript
// Step 1: Impersonate ITIL user
addTestStep(testSysId, 100, "sys_atf_step_config_impersonate", {
  description: "Impersonate ITIL user",
  inputs: JSON.stringify({
    user: "itil", // or sys_id
  }),
})
```

### Open New Form Step

```javascript
// Step 2: Open new incident form
addTestStep(testSysId, 200, "sys_atf_step_config_open_new_form", {
  description: "Open new incident form",
  inputs: JSON.stringify({
    table: "incident",
  }),
})
```

### Set Field Values Step

```javascript
// Step 3: Set field values
addTestStep(testSysId, 300, "sys_atf_step_config_set_field_values", {
  description: "Set incident fields",
  inputs: JSON.stringify({
    table: "incident",
    values: [
      { field: "short_description", value: "ATF Test Incident" },
      { field: "priority", value: "1" },
      { field: "category", value: "network" },
      { field: "caller_id", value: "admin" },
    ],
  }),
})
```

### Submit Form Step

```javascript
// Step 4: Submit form (click Save)
addTestStep(testSysId, 400, "sys_atf_step_config_click_ui_action", {
  description: "Save the incident",
  inputs: JSON.stringify({
    ui_action: "sysverb_insert", // Submit/Insert action
  }),
})
```

### Assert Field Values Step

```javascript
// Step 5: Assert values
addTestStep(testSysId, 500, "sys_atf_step_config_assert_field_values", {
  description: "Verify incident was created correctly",
  inputs: JSON.stringify({
    table: "incident",
    assertions: [
      {
        field: "priority",
        operator: "equals",
        value: "1",
      },
      {
        field: "state",
        operator: "equals",
        value: "1", // New
      },
      {
        field: "number",
        operator: "is not empty",
      },
    ],
  }),
})
```

## Server-Side Script Steps

### Custom Validation Script (ES5)

```javascript
// Step: Run Server Side Script
// Script (ES5 only!):

;(function (outputs, steps, params, stepResult) {
  // Access outputs from previous steps
  var incidentSysId = steps["step_sys_id"].record_id

  // Perform custom validation
  var gr = new GlideRecord("incident")
  if (gr.get(incidentSysId)) {
    // Check business rule fired
    if (gr.getValue("assignment_group") === "") {
      stepResult.setOutputMessage("Assignment group not set by business rule")
      stepResult.setFailed()
      return
    }

    // Check SLA attached
    var sla = new GlideRecord("task_sla")
    sla.addQuery("task", incidentSysId)
    sla.query()

    if (!sla.hasNext()) {
      stepResult.setOutputMessage("No SLA attached to incident")
      stepResult.setFailed()
      return
    }

    // All validations passed
    outputs.incident_number = gr.getValue("number")
    outputs.sla_count = sla.getRowCount()
    stepResult.setOutputMessage("All validations passed")
  } else {
    stepResult.setOutputMessage("Incident not found")
    stepResult.setFailed()
  }
})(outputs, steps, params, stepResult)
```

### Data Setup Script (ES5)

```javascript
// Step: Setup test data
;(function (outputs, steps, params, stepResult) {
  // Create test user if needed
  var user = new GlideRecord("sys_user")
  user.addQuery("user_name", "atf_test_user")
  user.query()

  if (!user.next()) {
    user.initialize()
    user.setValue("user_name", "atf_test_user")
    user.setValue("first_name", "ATF")
    user.setValue("last_name", "Test User")
    user.setValue("email", "atf@test.com")
    user.setValue("active", true)
    outputs.user_sys_id = user.insert()
  } else {
    outputs.user_sys_id = user.getUniqueValue()
  }

  stepResult.setOutputMessage("Test user ready: " + outputs.user_sys_id)
})(outputs, steps, params, stepResult)
```

### Cleanup Script (ES5)

```javascript
// Step: Cleanup test data (always runs)
;(function (outputs, steps, params, stepResult) {
  var testRecordId = steps["create_incident_step"].record_id

  if (testRecordId) {
    var gr = new GlideRecord("incident")
    if (gr.get(testRecordId)) {
      gr.deleteRecord()
      stepResult.setOutputMessage("Cleaned up test incident: " + testRecordId)
    }
  }
})(outputs, steps, params, stepResult)
```

## Test Suites

### Creating Test Suite

```javascript
// Create test suite
var suite = new GlideRecord("sys_atf_test_suite")
suite.initialize()
suite.setValue("name", "Incident Management Regression Suite")
suite.setValue("description", "Full regression tests for incident management")
suite.setValue("active", true)
var suiteSysId = suite.insert()

// Add tests to suite
function addTestToSuite(suiteId, testId, order) {
  var link = new GlideRecord("sys_atf_test_suite_test")
  link.initialize()
  link.setValue("test_suite", suiteId)
  link.setValue("test", testId)
  link.setValue("order", order)
  return link.insert()
}

addTestToSuite(suiteSysId, createTestId, 100)
addTestToSuite(suiteSysId, assignTestId, 200)
addTestToSuite(suiteSysId, resolveTestId, 300)
```

## Parameterized Tests

### Using Test Parameters

```javascript
// Test with parameters
var test = new GlideRecord('sys_atf_test');
test.initialize();
test.setValue('name', 'Test: Create Incident with Priority');
test.setValue('parameters', JSON.stringify({
    priority: '2',
    category: 'software'
}));
test.insert();

// In step, reference parameter
{
    "values": [
        { "field": "priority", "value": "${priority}" },
        { "field": "category", "value": "${category}" }
    ]
}
```

## MCP Tool Integration

### Available ATF Tools

| Tool                         | Purpose             |
| ---------------------------- | ------------------- |
| `snow_create_atf_test`       | Create test         |
| `snow_create_atf_test_step`  | Add step to test    |
| `snow_create_atf_test_suite` | Create suite        |
| `snow_execute_atf_test`      | Run test            |
| `snow_get_atf_results`       | Get results         |
| `snow_discover_atf_tests`    | Find existing tests |

### Example Workflow

```javascript
// 1. Create test
var testId = await snow_create_atf_test({
  name: "Test: Incident Priority Escalation",
  description: "Verify priority changes trigger notifications",
})

// 2. Add steps
await snow_create_atf_test_step({
  test_id: testId,
  order: 100,
  type: "impersonate",
  user: "itil",
})

await snow_create_atf_test_step({
  test_id: testId,
  order: 200,
  type: "server_script",
  script: createIncidentScript,
})

// 3. Execute test
var resultId = await snow_execute_atf_test({
  test_id: testId,
})

// 4. Get results
var results = await snow_get_atf_results({
  result_id: resultId,
})
```

## Best Practices

1. **Isolate Test Data** - Create and cleanup test data in each test
2. **Use Impersonation** - Test as actual user roles
3. **Atomic Tests** - Each test validates one scenario
4. **Descriptive Names** - Clear test and step descriptions
5. **Order Steps** - Use 100, 200, 300 for easy insertion
6. **Handle Async** - Add wait steps for async operations
7. **Cleanup Always** - Use finally steps for cleanup
8. **Parameterize** - Use parameters for reusable tests

## Common Assertions

| Assertion      | Use Case              |
| -------------- | --------------------- |
| `equals`       | Exact value match     |
| `not equals`   | Value exclusion       |
| `is empty`     | Field should be empty |
| `is not empty` | Field must have value |
| `contains`     | Substring match       |
| `starts with`  | Prefix match          |
| `greater than` | Numeric comparison    |
| `less than`    | Numeric comparison    |
