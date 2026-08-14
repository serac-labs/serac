---
name: approval-workflows
description: Configure ServiceNow approval rules and sysapproval_approver records — manager/group/script approvers, multi-level routing, delegation via sys_user_delegate, and parent-record state rollup.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_approval_chain_manage
  - snow_query_table
  - snow_artifact_manage
  - snow_execute_script
---

# Approval Workflows for ServiceNow

Approval workflows route records through configurable approval chains.

## Approval Architecture

```
Record (change_request, sc_req_item, etc.)
    ↓
Approval Rules (sysapproval_rule)
    ↓
Approval Records (sysapproval_approver)
    ↓ Approve/Reject
Record State Updated
```

## Key Tables

| Table                   | Purpose                      |
| ----------------------- | ---------------------------- |
| `sysapproval_approver`  | Individual approval records  |
| `sysapproval_group`     | Group approval configuration |
| `sysapproval_rule`      | Approval rules               |
| `sys_approval_workflow` | Approval workflow stages     |

## Approval Rules (ES5)

### Create Approval Rule

```javascript
// Create approval rule (ES5 ONLY!)
var rule = new GlideRecord("sysapproval_rule")
rule.initialize()

// Rule identification
rule.setValue("name", "Change Request Manager Approval")
rule.setValue("table", "change_request")
rule.setValue("order", 100)
rule.setValue("active", true)

// Conditions - when rule applies
rule.setValue("conditions", "type=normal^priority<=2")

// Approver type
rule.setValue("approver", "manager") // manager, group, user, script
// For user: rule.setValue('approver_user', userSysId);
// For group: rule.setValue('approver_group', groupSysId);

// Approval type
rule.setValue("approval_type", "and") // and (all must approve), or (any can approve)

// Wait for previous level
rule.setValue("wait_for", true)

rule.insert()
```

### Script-Based Approver Selection

```javascript
// Approval rule with script (ES5 ONLY!)
var rule = new GlideRecord("sysapproval_rule")
rule.initialize()
rule.setValue("name", "Cost-Based Approval")
rule.setValue("table", "sc_req_item")
rule.setValue("approver", "script")

// Script to determine approvers (ES5 ONLY!)
rule.setValue(
  "script",
  "(function getApprovers(current) {\n" +
    "    var approvers = [];\n" +
    '    var cost = parseFloat(current.getValue("estimated_cost")) || 0;\n' +
    "    \n" +
    "    // Manager approval for all\n" +
    "    var caller = current.requested_for.getRefRecord();\n" +
    "    if (caller.manager) {\n" +
    "        approvers.push(caller.manager.toString());\n" +
    "    }\n" +
    "    \n" +
    "    // Director approval for > $5000\n" +
    "    if (cost > 5000) {\n" +
    "        var director = getDirector(caller);\n" +
    "        if (director) approvers.push(director);\n" +
    "    }\n" +
    "    \n" +
    "    // VP approval for > $25000\n" +
    "    if (cost > 25000) {\n" +
    "        var vp = getVP(caller);\n" +
    "        if (vp) approvers.push(vp);\n" +
    "    }\n" +
    "    \n" +
    "    return approvers;\n" +
    "})(current);",
)

rule.insert()
```

## Managing Approvals (ES5)

### Create Approval Manually

```javascript
// Create approval record (ES5 ONLY!)
function createApproval(recordSysId, approverSysId, source) {
  var approval = new GlideRecord("sysapproval_approver")
  approval.initialize()
  approval.setValue("sysapproval", recordSysId)
  approval.setValue("approver", approverSysId)
  approval.setValue("state", "requested")
  approval.setValue("source_table", source.table || "")

  return approval.insert()
}
```

### Process Approval Decision

```javascript
// Approve or reject (ES5 ONLY!)
function processApprovalDecision(approvalSysId, decision, comments) {
  var approval = new GlideRecord("sysapproval_approver")
  if (!approval.get(approvalSysId)) {
    return { success: false, message: "Approval not found" }
  }

  // Validate current state
  if (approval.getValue("state") !== "requested") {
    return { success: false, message: "Approval already processed" }
  }

  // Validate approver
  if (approval.getValue("approver") !== gs.getUserID()) {
    if (!canActOnBehalf(approval.getValue("approver"))) {
      return { success: false, message: "Not authorized to approve" }
    }
  }

  // Set decision
  approval.setValue("state", decision) // 'approved' or 'rejected'
  approval.setValue("comments", comments)
  approval.setValue("actual_approver", gs.getUserID())
  approval.update()

  // Update parent record approval status
  updateParentApprovalStatus(approval.getValue("sysapproval"))

  return {
    success: true,
    decision: decision,
    record: approval.sysapproval.getDisplayValue(),
  }
}

function canActOnBehalf(originalApproverId) {
  // Check delegation
  var delegation = new GlideRecord("sys_user_delegate")
  delegation.addQuery("user", originalApproverId)
  delegation.addQuery("delegate", gs.getUserID())
  delegation.addQuery("starts", "<=", new GlideDateTime())
  delegation.addQuery("ends", ">=", new GlideDateTime())
  delegation.addQuery("approvals", true)
  delegation.query()
  return delegation.hasNext()
}
```

### Update Parent Record

```javascript
// Update approval status on parent record (ES5 ONLY!)
function updateParentApprovalStatus(recordSysId) {
  // Get all approvals for this record
  var approvals = new GlideRecord("sysapproval_approver")
  approvals.addQuery("sysapproval", recordSysId)
  approvals.query()

  var requested = 0
  var approved = 0
  var rejected = 0

  while (approvals.next()) {
    var state = approvals.getValue("state")
    if (state === "requested") requested++
    else if (state === "approved") approved++
    else if (state === "rejected") rejected++
  }

  // Determine overall status
  var overallStatus = "not requested"

  if (rejected > 0) {
    overallStatus = "rejected"
  } else if (requested > 0) {
    overallStatus = "requested"
  } else if (approved > 0) {
    overallStatus = "approved"
  }

  // Update parent record
  var parent = new GlideRecord("change_request")
  if (parent.get(recordSysId)) {
    parent.setValue("approval", overallStatus)
    parent.update()
  }
}
```

## Group Approvals (ES5)

### Configure Group Approval

```javascript
// Create group approval configuration (ES5 ONLY!)
var groupApproval = new GlideRecord("sysapproval_group")
groupApproval.initialize()
groupApproval.setValue("parent", recordSysId)
groupApproval.setValue("group", groupSysId)

// Approval requirement
groupApproval.setValue("approval", "any") // any, all, specific_count
groupApproval.setValue("specific_count", 2) // If specific_count

groupApproval.insert()
```

### Group Approval with Minimum

```javascript
// Check if group approval threshold met (ES5 ONLY!)
function checkGroupApprovalThreshold(groupApprovalSysId) {
  var groupConfig = new GlideRecord("sysapproval_group")
  if (!groupConfig.get(groupApprovalSysId)) {
    return false
  }

  var approvalType = groupConfig.getValue("approval")
  var groupId = groupConfig.getValue("group")
  var parentId = groupConfig.getValue("parent")

  // Count approvals from group members
  var ga = new GlideAggregate("sysapproval_approver")
  ga.addQuery("sysapproval", parentId)
  ga.addQuery("approver.sys_id", "IN", getGroupMembers(groupId))
  ga.addQuery("state", "approved")
  ga.addAggregate("COUNT")
  ga.query()

  var approvedCount = 0
  if (ga.next()) {
    approvedCount = parseInt(ga.getAggregate("COUNT"), 10)
  }

  // Check based on type
  if (approvalType === "any") {
    return approvedCount >= 1
  } else if (approvalType === "all") {
    var memberCount = getGroupMemberCount(groupId)
    return approvedCount >= memberCount
  } else if (approvalType === "specific_count") {
    var required = parseInt(groupConfig.getValue("specific_count"), 10)
    return approvedCount >= required
  }

  return false
}
```

## Approval Delegation (ES5)

### Create Delegation

```javascript
// Create approval delegation (ES5 ONLY!)
function createDelegation(userId, delegateId, startDate, endDate) {
  var delegation = new GlideRecord("sys_user_delegate")
  delegation.initialize()
  delegation.setValue("user", userId)
  delegation.setValue("delegate", delegateId)
  delegation.setValue("starts", startDate)
  delegation.setValue("ends", endDate)
  delegation.setValue("approvals", true)
  delegation.setValue("assignments", false)

  return delegation.insert()
}
```

### Find Active Delegates

```javascript
// Get delegates who can approve for a user (ES5 ONLY!)
function getActiveDelegates(userId) {
  var delegates = []
  var now = new GlideDateTime()

  var delegation = new GlideRecord("sys_user_delegate")
  delegation.addQuery("user", userId)
  delegation.addQuery("approvals", true)
  delegation.addQuery("starts", "<=", now)
  delegation.addQuery("ends", ">=", now)
  delegation.query()

  while (delegation.next()) {
    delegates.push({
      delegate: delegation.delegate.getDisplayValue(),
      delegate_id: delegation.getValue("delegate"),
      ends: delegation.getValue("ends"),
    })
  }

  return delegates
}
```

## Approval Notifications (ES5)

### Send Approval Request

```javascript
// Trigger approval notification (ES5 ONLY!)
function sendApprovalNotification(approvalSysId) {
  var approval = new GlideRecord("sysapproval_approver")
  if (!approval.get(approvalSysId)) return

  var parent = new GlideRecord(approval.source_table)
  if (parent.get(approval.getValue("sysapproval"))) {
    gs.eventQueue("approval.request", approval, approval.getValue("approver"), "")
  }
}
```

## MCP Tool Integration

### Available Tools

| Tool                          | Purpose                                            |
| ----------------------------- | -------------------------------------------------- |
| `snow_query_table`            | Query approvals and approval rules                 |
| `snow_approval_chain_manage`  | Define multi-step approval chains (`define_chain`) |
| `snow_artifact_manage`        | Find approval business rules (`action='find'`)     |
| `snow_execute_script`         | Test approval scripts                              |
| `snow_create_business_rule`   | Create approval triggers                           |

### Example Workflow

```javascript
// 1. Query pending approvals
await snow_query_table({
  table: "sysapproval_approver",
  query: "state=requested^approver=javascript:gs.getUserID()",
  fields: "sysapproval,state,sys_created_on",
})

// 2. Find approval rules
await snow_query_table({
  table: "sysapproval_rule",
  query: "table=change_request^active=true",
  fields: "name,conditions,approver,approval_type",
})

// 3. Check delegations
await snow_execute_script({
  script: `
        var delegates = getActiveDelegates(gs.getUserID());
        gs.info('Active delegates: ' + JSON.stringify(delegates));
    `,
})
```

## Best Practices

1. **Clear Conditions** - Specific rule conditions
2. **Logical Order** - Rule ordering matters
3. **Escalation** - Handle non-response
4. **Delegation** - Support out-of-office
5. **Notifications** - Timely reminders
6. **Audit Trail** - Track all decisions
7. **Testing** - Test all approval paths
8. **ES5 Only** - No modern JavaScript syntax
