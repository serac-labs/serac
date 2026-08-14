---
name: csm-patterns
description: Build ServiceNow Customer Service Management — customer_account, customer_contact, sn_customerservice_case routing, service entitlements with usage decrement, and Customer Portal case submission widgets.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_create_customer_case
  - snow_query_table
  - snow_artifact_manage
  - snow_execute_script
---

# Customer Service Management for ServiceNow

CSM enables organizations to deliver exceptional customer service through cases, accounts, and self-service.

## CSM Architecture

```
Account (customer_account)
    ├── Contacts (customer_contact)
    ├── Contracts (ast_contract)
    │   └── Entitlements (service_entitlement)
    ├── Assets (alm_asset)
    └── Cases (sn_customerservice_case)
        ├── Case Tasks
        └── Communications
```

## Key Tables

| Table                     | Purpose              |
| ------------------------- | -------------------- |
| `customer_account`        | Customer accounts    |
| `customer_contact`        | Account contacts     |
| `sn_customerservice_case` | Customer cases       |
| `service_entitlement`     | Service entitlements |
| `ast_contract`            | Service contracts    |

## Customer Accounts (ES5)

### Create Customer Account

```javascript
// Create customer account (ES5 ONLY!)
var account = new GlideRecord("customer_account")
account.initialize()

// Basic info
account.setValue("name", "Acme Corporation")
account.setValue("account_code", "ACME-001")
account.setValue("industry", "Technology")

// Contact info
account.setValue("phone", "+1-555-123-4567")
account.setValue("email", "info@acme.com")
account.setValue("website", "https://www.acme.com")

// Address
account.setValue("street", "123 Main Street")
account.setValue("city", "San Francisco")
account.setValue("state", "CA")
account.setValue("zip", "94105")
account.setValue("country", "US")

// Account details
account.setValue("account_type", "customer") // customer, partner, vendor
account.setValue("tier", "gold") // bronze, silver, gold, platinum

// Assignment
account.setValue("account_manager", accountManagerSysId)

account.insert()
```

### Create Contact

```javascript
// Create contact for account (ES5 ONLY!)
var contact = new GlideRecord("customer_contact")
contact.initialize()

// Link to account
contact.setValue("account", accountSysId)

// Contact info
contact.setValue("name", "John Smith")
contact.setValue("email", "john.smith@acme.com")
contact.setValue("phone", "+1-555-123-4568")
contact.setValue("title", "IT Manager")

// Contact type
contact.setValue("type", "primary") // primary, billing, technical
contact.setValue("active", true)

// Create user for portal access
var user = createUserFromContact(contact)
contact.setValue("user", user)

contact.insert()
```

## Customer Cases (ES5)

### Create Customer Case

```javascript
// Create customer case (ES5 ONLY!)
var caseRecord = new GlideRecord("sn_customerservice_case")
caseRecord.initialize()

// Case info
caseRecord.setValue("short_description", "Unable to access product features")
caseRecord.setValue("description", "Customer reports error when trying to use premium features")

// Classification
caseRecord.setValue("category", "product_issue")
caseRecord.setValue("subcategory", "access_problem")
caseRecord.setValue("priority", 2)

// Customer
caseRecord.setValue("account", accountSysId)
caseRecord.setValue("contact", contactSysId)

// Product/Asset
caseRecord.setValue("product", productSysId)
caseRecord.setValue("asset", assetSysId)

// Assignment
caseRecord.setValue("assignment_group", getGroupSysId("Customer Support"))

// Channel
caseRecord.setValue("channel", "email") // email, phone, chat, web

caseRecord.insert()
```

### Case Routing

```javascript
// Route case based on account and product (ES5 ONLY!)
// Business Rule: before, insert, sn_customerservice_case

;(function executeRule(current, previous) {
  if (current.assignment_group) {
    return // Already assigned
  }

  var group = determineAssignmentGroup(current)
  if (group) {
    current.assignment_group = group
  }
})(current, previous)

function determineAssignmentGroup(caseRecord) {
  // Check for premium support entitlement
  if (hasPremiumSupport(caseRecord.getValue("account"))) {
    return getGroupSysId("Premium Support")
  }

  // Route by product
  var product = caseRecord.product.getRefRecord()
  if (product.isValidRecord()) {
    var supportGroup = product.getValue("support_group")
    if (supportGroup) {
      return supportGroup
    }
  }

  // Default
  return getGroupSysId("General Support")
}

function hasPremiumSupport(accountSysId) {
  var entitlement = new GlideRecord("service_entitlement")
  entitlement.addQuery("account", accountSysId)
  entitlement.addQuery("type", "premium_support")
  entitlement.addQuery("start_date", "<=", new GlideDateTime())
  entitlement.addQuery("end_date", ">=", new GlideDateTime())
  entitlement.query()
  return entitlement.hasNext()
}
```

## Entitlements (ES5)

### Create Service Entitlement

```javascript
// Create entitlement (ES5 ONLY!)
var entitlement = new GlideRecord("service_entitlement")
entitlement.initialize()

entitlement.setValue("name", "Premium Support - Acme Corp")
entitlement.setValue("account", accountSysId)
entitlement.setValue("contract", contractSysId)

// Entitlement type
entitlement.setValue("type", "premium_support")

// Dates
entitlement.setValue("start_date", "2024-01-01")
entitlement.setValue("end_date", "2024-12-31")

// Limits
entitlement.setValue("total_cases", 100)
entitlement.setValue("used_cases", 0)
entitlement.setValue("remaining_cases", 100)

// SLA
entitlement.setValue("response_sla", "4 hours")
entitlement.setValue("resolution_sla", "24 hours")

entitlement.insert()
```

### Check Entitlement

```javascript
// Check if customer is entitled to service (ES5 ONLY!)
function checkEntitlement(accountSysId, entitlementType) {
  var now = new GlideDateTime()

  var entitlement = new GlideRecord("service_entitlement")
  entitlement.addQuery("account", accountSysId)
  entitlement.addQuery("type", entitlementType)
  entitlement.addQuery("start_date", "<=", now)
  entitlement.addQuery("end_date", ">=", now)
  entitlement.query()

  if (entitlement.next()) {
    var remaining = parseInt(entitlement.getValue("remaining_cases"), 10)

    return {
      entitled: true,
      remaining: remaining,
      unlimited: remaining < 0, // -1 = unlimited
      expiration: entitlement.getValue("end_date"),
      sla: {
        response: entitlement.getValue("response_sla"),
        resolution: entitlement.getValue("resolution_sla"),
      },
    }
  }

  return {
    entitled: false,
    message: "No active entitlement found",
  }
}
```

### Decrement Entitlement

```javascript
// Use entitlement when case created (ES5 ONLY!)
// Business Rule: after, insert, sn_customerservice_case

;(function executeRule(current, previous) {
  var accountSysId = current.getValue("account")
  if (!accountSysId) return

  var entitlement = new GlideRecord("service_entitlement")
  entitlement.addQuery("account", accountSysId)
  entitlement.addQuery("type", "support")
  entitlement.addQuery("start_date", "<=", new GlideDateTime())
  entitlement.addQuery("end_date", ">=", new GlideDateTime())
  entitlement.addQuery("remaining_cases", ">", 0)
  entitlement.orderBy("end_date") // Use earliest expiring first
  entitlement.setLimit(1)
  entitlement.query()

  if (entitlement.next()) {
    var used = parseInt(entitlement.getValue("used_cases"), 10)
    var remaining = parseInt(entitlement.getValue("remaining_cases"), 10)

    entitlement.setValue("used_cases", used + 1)
    entitlement.setValue("remaining_cases", remaining - 1)
    entitlement.update()

    // Link case to entitlement
    current.u_entitlement = entitlement.getUniqueValue()
    current.update()

    // Alert if running low
    if (remaining - 1 <= 5) {
      gs.eventQueue("entitlement.low", entitlement, accountSysId, (remaining - 1).toString())
    }
  }
})(current, previous)
```

## Customer Portal (ES5)

### Portal Case Submission

```javascript
// Widget Server Script for case submission (ES5 ONLY!)
;(function () {
  // Handle case creation
  if (input && input.action === "createCase") {
    var contactId = getContactForUser(gs.getUserID())
    if (!contactId) {
      data.error = "No contact record found"
      return
    }

    var contact = new GlideRecord("customer_contact")
    contact.get(contactId)

    // Create case
    var caseRecord = new GlideRecord("sn_customerservice_case")
    caseRecord.initialize()
    caseRecord.setValue("short_description", input.subject)
    caseRecord.setValue("description", input.description)
    caseRecord.setValue("contact", contactId)
    caseRecord.setValue("account", contact.getValue("account"))
    caseRecord.setValue("priority", input.priority || 3)
    caseRecord.setValue("channel", "web")

    var caseSysId = caseRecord.insert()

    data.success = true
    data.case_number = caseRecord.getValue("number")
    data.case_sys_id = caseSysId
  }

  // Get user's cases
  if (!input || input.action === "getCases") {
    var contactId = getContactForUser(gs.getUserID())
    data.cases = []

    if (contactId) {
      var gr = new GlideRecord("sn_customerservice_case")
      gr.addQuery("contact", contactId)
      gr.orderByDesc("sys_created_on")
      gr.setLimit(20)
      gr.query()

      while (gr.next()) {
        data.cases.push({
          sys_id: gr.getUniqueValue(),
          number: gr.getValue("number"),
          short_description: gr.getValue("short_description"),
          state: gr.state.getDisplayValue(),
          priority: gr.priority.getDisplayValue(),
          opened_at: gr.getValue("opened_at"),
        })
      }
    }
  }

  function getContactForUser(userId) {
    var contact = new GlideRecord("customer_contact")
    contact.addQuery("user", userId)
    contact.query()
    if (contact.next()) {
      return contact.getUniqueValue()
    }
    return null
  }
})()
```

## MCP Tool Integration

### Available Tools

| Tool                   | Purpose                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `snow_query_table`     | Query CSM tables                                                                           |
| `snow_artifact_manage` | Find CSM configurations (`action: "find"`) and deploy CSM widgets (`action: "create"`)     |
| `snow_execute_script`  | Test CSM scripts                                                                           |

### Example Workflow

```javascript
// 1. Query customer cases
await snow_query_table({
  table: "sn_customerservice_case",
  query: "active=true^priority<=2",
  fields: "number,short_description,account,contact,state",
})

// 2. Check entitlements
await snow_execute_script({
  script: `
        var result = checkEntitlement('account_sys_id', 'premium_support');
        gs.info(JSON.stringify(result));
    `,
})

// 3. Find accounts with expiring contracts
await snow_query_table({
  table: "ast_contract",
  query: "endsBETWEENjavascript:gs.beginningOfToday()@javascript:gs.daysAgoEnd(-30)",
  fields: "number,vendor,ends,account",
})
```

## Best Practices

1. **Account Hierarchy** - Parent/child accounts
2. **Contact Roles** - Clear contact types
3. **Entitlements** - Track usage limits
4. **SLA Mapping** - Account tier to SLA
5. **Portal Access** - Secure customer data
6. **Case Routing** - Smart assignment
7. **Communication** - Audit trail
8. **ES5 Only** - No modern JavaScript syntax
