---
name: flow-designer
description: Build ServiceNow Flow Designer flows via the dedicated tool — triggers, IF/ELSE/TRY/CATCH placement rules, subflows, script actions with inputs/outputs, and REST step configuration. Never use background scripts on sys_hub_* tables.
license: Apache-2.0
compatibility: Designed for Serac and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_query_table
  - snow_artifact_manage
  - snow_execute_script
---

# Flow Designer Patterns for ServiceNow

Flow Designer is the modern automation engine in ServiceNow, replacing legacy Workflows for new development.

## Using the Flow Designer Tool

To create and manage flows programmatically, first discover the Flow Designer tool via `tool_search({query: "flow designer"})`. The discovered tool handles all GraphQL mutations for the full flow lifecycle.

**CRITICAL — IF/ELSE/ELSEIF placement rules:**

- Actions **inside** an IF branch: `parent_ui_id` = IF's `uiUniqueIdentifier`
- **ELSE/ELSEIF** blocks: must be at the **same level** as IF, NOT nested inside it
  - `parent_ui_id` = the **same parent** you used for the IF block
  - `connected_to` = IF's `logicId` (the sysId returned when creating the IF)
- Getting this wrong causes "Unsupported flowLogic type" errors when saving the flow

**CRITICAL — TRY/CATCH placement rules:**

When you add a TRY block, the CATCH companion is **auto-created** by the tool. TRY and CATCH are **containers** — actions go INSIDE them, not next to them.

- **Actions inside TRY** (steps that may fail):
  - `parent_ui_id` = TRY's `uiUniqueIdentifier`
  - `order`: 1, 2, 3, ... within the TRY
- **Actions inside CATCH** (error handling):
  - `parent_ui_id` = CATCH's `uiUniqueIdentifier` (returned as `catch_ui_id` from the TRY creation response)
  - `order`: 1, 2, 3, ... within the CATCH
- The `next_order` returned from creating the TRY/CATCH pair is for the next **sibling** after the pair, NOT for children inside them. Use it for the action *after* the try/catch, not for actions *inside* them.

**Do NOT** create flows via background scripts, GlideRecord, or REST calls to `sys_hub_*` tables. Always discover and use the Flow Designer tool via `tool_search({query: "flow designer"})` — it handles the GraphQL mutations correctly. Background-script approaches will silently produce broken flows.

## Flow Designer Components

| Component   | Purpose                               | Reusable |
| ----------- | ------------------------------------- | -------- |
| **Flow**    | Main automation process               | No       |
| **Subflow** | Reusable flow logic                   | Yes      |
| **Action**  | Single operation (Script, REST, etc.) | Yes      |
| **Spoke**   | Collection of related actions         | Yes      |

## Flow Triggers

### Record-Based Triggers

```
Trigger: Created
Table: incident
Condition: Priority = 1

Trigger: Updated
Table: incident
Condition: State changes to Resolved

Trigger: Created or Updated
Table: change_request
Condition: Risk = High
```

### Schedule Triggers

```
Trigger: Daily
Time: 02:00 AM
Timezone: America/New_York

Trigger: Weekly
Day: Monday
Time: 08:00 AM
```

### Service Catalog Triggers

```
Trigger: Service Catalog
Catalog Item: Request New Laptop
```

## Flow Best Practices

### 1. Use Subflows for Reusability

```
Main Flow: Incident P1 Handler
├── Trigger: Incident Created (Priority = 1)
├── Action: Log Event
├── Subflow: Notify On-Call Team     ← Reusable!
├── Subflow: Create Major Incident   ← Reusable!
└── Action: Update Incident
```

### 2. Error Handling

```
Flow: Process Integration
├── Try
│   ├── Action: Call REST API
│   ├── Action: Parse Response
│   └── Action: Update Record
├── Catch (all errors)
│   ├── Action: Log Error Details
│   ├── Action: Create Error Task
│   └── Action: Send Alert
└── Always
    └── Action: Cleanup Temp Data
```

### 3. Flow Variables

```javascript
// Input Variables (from trigger)
var incidentSysId = fd_data.trigger.current.sys_id
var priority = fd_data.trigger.current.priority

// Scratch Variables (within flow)
fd_data.scratch.approval_required = priority == "1"
fd_data.scratch.notification_sent = false

// Output Variables (to calling flow/subflow)
fd_data.output.success = true
fd_data.output.message = "Processed successfully"
```

### 4. Conditions and Branches

```
If: Priority = Critical
  Then:
    - Notify VP
    - Create Major Incident
    - Page On-Call
  Else If: Priority = High
    - Notify Manager
    - Escalate in 4 hours
  Else:
    - Standard Processing
```

## Custom Actions (Scripts)

### Basic Script Action

```javascript
;(function execute(inputs, outputs) {
  // Inputs defined in Action Designer
  var incidentId = inputs.incident_sys_id
  var newState = inputs.target_state

  // Process
  var gr = new GlideRecord("incident")
  if (gr.get(incidentId)) {
    gr.setValue("state", newState)
    gr.update()

    // Set outputs
    outputs.success = true
    outputs.incident_number = gr.getValue("number")
  } else {
    outputs.success = false
    outputs.error_message = "Incident not found"
  }
})(inputs, outputs)
```

### Script Action with Error Handling

```javascript
;(function execute(inputs, outputs) {
  try {
    var gr = new GlideRecord(inputs.table_name)
    gr.addEncodedQuery(inputs.query)
    gr.query()

    var records = []
    while (gr.next()) {
      records.push({
        sys_id: gr.getUniqueValue(),
        display_value: gr.getDisplayValue(),
      })
    }

    outputs.records = JSON.stringify(records)
    outputs.count = records.length
    outputs.success = true
  } catch (e) {
    outputs.success = false
    outputs.error_message = e.message
    // Flow Designer will catch this and route to error handler
    throw new Error("Query failed: " + e.message)
  }
})(inputs, outputs)
```

## REST Action Example

### Configuration

```yaml
Action: Call External API
Connection: My REST Connection Alias
HTTP Method: POST
Endpoint: /api/v1/tickets

Headers:
  Content-Type: application/json
  Authorization: Bearer ${connection.credential.token}

Request Body:
{
  "title": "${inputs.short_description}",
  "priority": "${inputs.priority}",
  "reporter": "${inputs.caller_email}"
}

Parse Response: JSON
```

### Response Handling

```javascript
// In a Script step after REST call
var response = fd_data.action_outputs.rest_response

if (response.status_code == 201) {
  outputs.external_id = response.body.id
  outputs.success = true
} else {
  outputs.success = false
  outputs.error = response.body.error || "Unknown error"
}
```

## Subflow Patterns

### Notification Subflow

```
Subflow: Send Notification
Inputs:
  - recipient_email (String)
  - subject (String)
  - body (String)
  - priority (String, default: "normal")

Actions:
  1. Look Up: User by email
  2. If: User found
     - Send Email notification
     - Output: success = true
  3. Else:
     - Log Warning
     - Output: success = false
```

### Approval Subflow

```
Subflow: Request Approval
Inputs:
  - record_sys_id (Reference)
  - approver (Reference: sys_user)
  - approval_message (String)

Actions:
  1. Create: Approval record
  2. Wait: For approval state change
  3. If: Approved
     - Output: approved = true
  4. Else:
     - Output: approved = false
     - Output: rejection_reason = comments
```

## Flow Designer vs Workflow

| Feature            | Flow Designer               | Workflow               |
| ------------------ | --------------------------- | ---------------------- |
| Interface          | Modern, visual              | Legacy                 |
| Reusability        | Subflows, Actions           | Limited                |
| Testing            | Built-in testing            | Manual                 |
| Version Control    | Yes                         | Limited                |
| Integration Hub    | Yes                         | No                     |
| Performance        | Better                      | Slower                 |
| **Recommendation** | **Use for new development** | Maintain existing only |

## Debugging Flows

### Flow Context Logs

```javascript
// In Script Action
fd_log.info("Processing incident: " + inputs.incident_number)
fd_log.debug("Input data: " + JSON.stringify(inputs))
fd_log.warn("Retry attempt: " + inputs.retry_count)
fd_log.error("Failed to process: " + error.message)
```

### Flow Execution History

```
Navigate: Flow Designer > Executions
Filter by: Flow name, Status, Date range
View: Step-by-step execution details
```

## Common Patterns

### Pattern 1: SLA Escalation Flow

```
Trigger: SLA breached (Task SLA)
Actions:
  1. Get: Task details
  2. Get: Assignment group manager
  3. Send: Escalation email
  4. Update: Task priority
  5. Create: Escalation task
```

### Pattern 2: Approval Routing

```
Trigger: Request Item created
Actions:
  1. If: Amount < $1000
     - Auto-approve
  2. Else If: Amount < $10000
     - Request: Manager approval
  3. Else:
     - Request: VP approval
     - Wait: 3 business days
     - If timeout: Escalate to CFO
```

### Pattern 3: Integration Sync

```
Trigger: Scheduled (every 15 minutes)
Actions:
  1. Call: External API (get changes)
  2. For Each: Changed record
     a. Look Up: Matching local record
     b. If exists: Update
     c. Else: Create
  3. Log: Sync summary
```

## Performance Tips

1. **Use conditions early** - Filter before expensive operations
2. **Limit loops** - Set max iterations on For Each
3. **Async where possible** - Don't block on slow operations
4. **Cache lookups** - Store repeated queries in scratch variables
5. **Batch operations** - Group similar updates together
