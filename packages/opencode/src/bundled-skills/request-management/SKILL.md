---
name: request-management
description: Handle ServiceNow service requests — sc_request/sc_req_item creation from catalog items, sc_task fulfillment with auto-close on completion, RITM variable access via sc_item_option_mtom, and approval status rollup.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_artifact_manage
  - snow_execute_script
  - snow_create_catalog_item
---

# Request Management for ServiceNow

Request Management handles service requests from catalog items through fulfillment.

## Request Hierarchy

```
Request (sc_request)
    ├── Request Item (sc_req_item) - RITM
    │   ├── Catalog Tasks (sc_task)
    │   └── Variables (sc_item_option_mtom)
    └── Request Item
        └── Catalog Tasks
```

## Key Tables

| Table                 | Purpose                  |
| --------------------- | ------------------------ |
| `sc_request`          | Parent request record    |
| `sc_req_item`         | Requested items (RITM)   |
| `sc_task`             | Fulfillment tasks        |
| `sc_item_option_mtom` | Variable values          |
| `sc_cat_item`         | Catalog item definitions |

## Request Items (ES5)

### Create Request Programmatically

```javascript
// Create request and RITM (ES5 ONLY!)
function createServiceRequest(catalogItemName, requestedFor, variables) {
  // Get catalog item
  var catItem = new GlideRecord("sc_cat_item")
  if (!catItem.get("name", catalogItemName)) {
    gs.error("Catalog item not found: " + catalogItemName)
    return null
  }

  // Create request
  var request = new GlideRecord("sc_request")
  request.initialize()
  request.setValue("requested_for", requestedFor)
  request.setValue("opened_by", gs.getUserID())
  request.setValue("description", "Request for " + catalogItemName)
  var requestSysId = request.insert()

  // Create RITM
  var ritm = new GlideRecord("sc_req_item")
  ritm.initialize()
  ritm.setValue("request", requestSysId)
  ritm.setValue("cat_item", catItem.getUniqueValue())
  ritm.setValue("requested_for", requestedFor)
  ritm.setValue("quantity", 1)

  var ritmSysId = ritm.insert()

  // Set variables
  if (variables) {
    setRITMVariables(ritmSysId, variables)
  }

  return {
    request: request.getValue("number"),
    ritm: ritm.getValue("number"),
    request_sys_id: requestSysId,
    ritm_sys_id: ritmSysId,
  }
}

function setRITMVariables(ritmSysId, variables) {
  var ritm = new GlideRecord("sc_req_item")
  if (!ritm.get(ritmSysId)) return

  for (var varName in variables) {
    if (variables.hasOwnProperty(varName)) {
      ritm.variables[varName] = variables[varName]
    }
  }
  ritm.update()
}
```

### Query Request Items

```javascript
// Get user's open requests (ES5 ONLY!)
function getUserRequests(userSysId, includeCompleted) {
  var requests = []

  var ritm = new GlideRecord("sc_req_item")
  ritm.addQuery("requested_for", userSysId)

  if (!includeCompleted) {
    ritm.addQuery("state", "!=", "3") // Not Closed Complete
    ritm.addQuery("state", "!=", "4") // Not Closed Incomplete
  }

  ritm.orderByDesc("sys_created_on")
  ritm.query()

  while (ritm.next()) {
    requests.push({
      sys_id: ritm.getUniqueValue(),
      number: ritm.getValue("number"),
      short_description: ritm.getValue("short_description"),
      cat_item: ritm.cat_item.getDisplayValue(),
      state: ritm.state.getDisplayValue(),
      stage: ritm.stage.getDisplayValue(),
      opened_at: ritm.getValue("sys_created_on"),
      due_date: ritm.getValue("due_date"),
    })
  }

  return requests
}
```

## Fulfillment Tasks (ES5)

### Create Catalog Tasks

```javascript
// Create fulfillment tasks for RITM (ES5 ONLY!)
function createFulfillmentTasks(ritmSysId, taskDefinitions) {
  var ritm = new GlideRecord("sc_req_item")
  if (!ritm.get(ritmSysId)) {
    return []
  }

  var createdTasks = []

  for (var i = 0; i < taskDefinitions.length; i++) {
    var taskDef = taskDefinitions[i]

    var task = new GlideRecord("sc_task")
    task.initialize()
    task.setValue("request_item", ritmSysId)
    task.setValue("request", ritm.getValue("request"))
    task.setValue("short_description", taskDef.description)
    task.setValue("assignment_group", taskDef.assignmentGroup)
    task.setValue("order", (i + 1) * 100)

    // Calculate due date if specified
    if (taskDef.daysToComplete) {
      var dueDate = new GlideDateTime()
      dueDate.addDaysLocalTime(taskDef.daysToComplete)
      task.setValue("due_date", dueDate)
    }

    var taskSysId = task.insert()
    createdTasks.push({
      sys_id: taskSysId,
      number: task.getValue("number"),
    })
  }

  return createdTasks
}

// Example usage
var tasks = createFulfillmentTasks(ritmSysId, [
  { description: "Verify request details", assignmentGroup: "Service Desk", daysToComplete: 1 },
  { description: "Provision access", assignmentGroup: "IAM Team", daysToComplete: 2 },
  { description: "Notify user", assignmentGroup: "Service Desk", daysToComplete: 1 },
])
```

### Auto-close RITM on Task Completion

```javascript
// Business Rule: after, update, sc_task (ES5 ONLY!)
;(function executeRule(current, previous) {
  // Check if task was just closed
  if (current.state.changesTo("3") || current.state.changesTo("4")) {
    checkAndCloseRITM(current.getValue("request_item"))
  }
})(current, previous)

function checkAndCloseRITM(ritmSysId) {
  // Check if all tasks are complete
  var openTasks = new GlideAggregate("sc_task")
  openTasks.addQuery("request_item", ritmSysId)
  openTasks.addQuery("state", "NOT IN", "3,4,7") // Not closed or cancelled
  openTasks.addAggregate("COUNT")
  openTasks.query()

  if (openTasks.next()) {
    var count = parseInt(openTasks.getAggregate("COUNT"), 10)
    if (count === 0) {
      // All tasks complete, close RITM
      var ritm = new GlideRecord("sc_req_item")
      if (ritm.get(ritmSysId)) {
        ritm.state = 3 // Closed Complete
        ritm.update()
      }
    }
  }
}
```

## Variable Management (ES5)

### Access RITM Variables

```javascript
// Get variable values from RITM (ES5 ONLY!)
function getRITMVariables(ritmSysId) {
  var variables = {}

  var ritm = new GlideRecord("sc_req_item")
  if (!ritm.get(ritmSysId)) {
    return variables
  }

  // Get all variable values
  var varValue = new GlideRecord("sc_item_option_mtom")
  varValue.addQuery("request_item", ritmSysId)
  varValue.query()

  while (varValue.next()) {
    var varName = varValue.sc_item_option.item_option_new.name.toString()
    var value = varValue.getValue("sc_item_option")

    // Get display value for reference fields
    var varDef = varValue.sc_item_option.item_option_new.getRefRecord()
    if (varDef.getValue("type") === "8") {
      // Reference
      var refRecord = new GlideRecord(varDef.getValue("reference"))
      if (refRecord.get(value)) {
        variables[varName] = {
          value: value,
          display_value: refRecord.getDisplayValue(),
        }
      }
    } else {
      variables[varName] = {
        value: value,
        display_value: varValue.sc_item_option.getDisplayValue(),
      }
    }
  }

  return variables
}
```

### Validate Variables

```javascript
// Validate RITM variables (ES5 ONLY!)
function validateRITMVariables(ritmSysId) {
  var errors = []

  var ritm = new GlideRecord("sc_req_item")
  if (!ritm.get(ritmSysId)) {
    return ["RITM not found"]
  }

  // Get catalog item variable definitions
  var catItem = ritm.cat_item.getRefRecord()

  var varDef = new GlideRecord("item_option_new")
  varDef.addQuery("cat_item", catItem.getUniqueValue())
  varDef.addQuery("mandatory", true)
  varDef.query()

  while (varDef.next()) {
    var varName = varDef.getValue("name")
    var varValue = ritm.variables[varName]

    if (!varValue || varValue.toString() === "") {
      errors.push("Missing required variable: " + varDef.getValue("question_text"))
    }
  }

  return errors
}
```

## Request Approvals (ES5)

### Check Approval Status

```javascript
// Get approval status for request (ES5 ONLY!)
function getRequestApprovalStatus(requestSysId) {
  var approvals = []

  var approval = new GlideRecord("sysapproval_approver")
  approval.addQuery("sysapproval", requestSysId)
  approval.query()

  while (approval.next()) {
    approvals.push({
      approver: approval.approver.getDisplayValue(),
      state: approval.state.getDisplayValue(),
      comments: approval.getValue("comments"),
      sys_updated_on: approval.getValue("sys_updated_on"),
    })
  }

  // Determine overall status
  var pending = 0
  var approved = 0
  var rejected = 0

  for (var i = 0; i < approvals.length; i++) {
    var state = approvals[i].state
    if (state === "Requested") pending++
    else if (state === "Approved") approved++
    else if (state === "Rejected") rejected++
  }

  return {
    approvals: approvals,
    summary: {
      pending: pending,
      approved: approved,
      rejected: rejected,
      overall: rejected > 0 ? "Rejected" : pending > 0 ? "Pending" : "Approved",
    },
  }
}
```

## MCP Tool Integration

### Available Tools

| Tool                                       | Purpose                  |
| ------------------------------------------ | ------------------------ |
| `snow_query_table`                         | Query requests and RITMs |
| `snow_artifact_manage` (action='find')     | Find catalog items       |
| `snow_execute_script`                      | Test request scripts     |
| `snow_create_catalog_item`                 | Create catalog items     |

### Example Workflow

```javascript
// 1. Query open requests
await snow_query_table({
  table: "sc_req_item",
  query: "state!=3^state!=4^requested_for=javascript:gs.getUserID()",
  fields: "number,short_description,cat_item,state,stage",
})

// 2. Get request details
await snow_execute_script({
  script: `
        var vars = getRITMVariables('ritm_sys_id');
        gs.info(JSON.stringify(vars));
    `,
})

// 3. Check approvals
await snow_query_table({
  table: "sysapproval_approver",
  query: "sysapproval=request_sys_id",
  fields: "approver,state,comments",
})
```

## Best Practices

1. **Clear Descriptions** - User-friendly short descriptions
2. **Variable Validation** - Validate before processing
3. **Task Ordering** - Logical fulfillment sequence
4. **SLA Tracking** - Set appropriate due dates
5. **Notifications** - Keep requesters informed
6. **Approval Rules** - Configure appropriate approvals
7. **Auto-closure** - Close RITMs when tasks complete
8. **ES5 Only** - No modern JavaScript syntax
