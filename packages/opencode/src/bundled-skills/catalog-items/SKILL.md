---
name: catalog-items
description: Build ServiceNow Service Catalog items, variables, variable sets, catalog client scripts, record producers, and order guides with reference qualifiers and dynamic pricing.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_catalog_item_create
  - snow_catalog_variable_create
  - snow_query_table
  - snow_find_artifact
---

# Service Catalog Development for ServiceNow

The Service Catalog allows users to request services and items through a self-service portal.

## Catalog Components

| Component        | Purpose                  | Example               |
| ---------------- | ------------------------ | --------------------- |
| **Catalog**      | Container for categories | IT Service Catalog    |
| **Category**     | Group of items           | Hardware, Software    |
| **Item**         | Requestable service      | New Laptop Request    |
| **Variable**     | Form field on item       | Laptop Model dropdown |
| **Variable Set** | Reusable variable group  | User Details          |
| **Producer**     | Creates records directly | Report an Incident    |
| **Order Guide**  | Multi-item wizard        | New Employee Setup    |

## Catalog Item Structure

```
Catalog Item: Request New Laptop
├── Variables
│   ├── laptop_model (Reference: cmdb_model)
│   ├── reason (Multi-line text)
│   └── urgency (Choice: Low, Medium, High)
├── Variable Sets
│   └── Delivery Information (Address, Contact)
├── Catalog Client Scripts
│   ├── onLoad: Set defaults
│   └── onChange: Update price
├── Workflows/Flows
│   └── Laptop Approval Flow
└── Fulfillment
    └── Creates Task for IT
```

## Variable Types

| Type                | Use Case            | Example                |
| ------------------- | ------------------- | ---------------------- |
| Single Line Text    | Short input         | Employee ID            |
| Multi Line Text     | Long input          | Business Justification |
| Select Box          | Single choice       | Priority               |
| Check Box           | Yes/No              | Express Delivery       |
| Reference           | Link to table       | Requested For          |
| Date                | Date picker         | Needed By Date         |
| Lookup Select Box   | Filtered reference  | Model by Category      |
| List Collector      | Multiple selections | CC Recipients          |
| Container Start/End | Visual grouping     | Hardware Options       |
| Macro               | Custom widget       | Cost Calculator        |

## Creating Catalog Variables

### Basic Variable

```javascript
// Via MCP
snow_create_catalog_variable({
  catalog_item: "laptop_request",
  name: "laptop_model",
  type: "reference",
  reference: "cmdb_model",
  reference_qual: "category=computer",
  mandatory: true,
  order: 100,
})
```

### Variable with Dynamic Default

```javascript
// Variable: requested_for
// Type: Reference (sys_user)
// Default value (script):
javascript: gs.getUserID()
```

### Variable with Reference Qualifier

```javascript
// Variable: assignment_group
// Type: Reference (sys_user_group)
// Reference Qualifier:

// Simple:
active=true^type=it

// Dynamic (Script):
javascript: 'active=true^manager=' + gs.getUserID()

// Advanced (using current variables):
javascript: 'u_department=' + current.variables.department
```

## Catalog Client Scripts

### Set Defaults onLoad

```javascript
function onLoad() {
  // Set default values
  g_form.setValue("urgency", "low")

  // Hide admin-only fields
  if (!g_user.hasRole("catalog_admin")) {
    g_form.setDisplay("cost_center", false)
  }

  // Set default date to tomorrow
  var tomorrow = new GlideDateTime()
  tomorrow.addDays(1)
  g_form.setValue("needed_by", tomorrow.getDate().getValue())
}
```

### Dynamic Pricing onChange

```javascript
function onChange(control, oldValue, newValue, isLoading) {
  if (isLoading) return

  // Get price from selected model
  var ga = new GlideAjax("CatalogUtils")
  ga.addParam("sysparm_name", "getModelPrice")
  ga.addParam("sysparm_model", newValue)
  ga.getXMLAnswer(function (price) {
    g_form.setValue("item_price", price)
    updateTotal()
  })
}

function updateTotal() {
  var price = parseFloat(g_form.getValue("item_price")) || 0
  var quantity = parseInt(g_form.getValue("quantity")) || 1
  g_form.setValue("total_cost", (price * quantity).toFixed(2))
}
```

### Validation onSubmit

```javascript
function onSubmit() {
  // Validate business justification for high-cost items
  var cost = parseFloat(g_form.getValue("total_cost"))
  var justification = g_form.getValue("business_justification")

  if (cost > 1000 && !justification) {
    g_form.showFieldMsg("business_justification", "Required for items over $1000", "error")
    return false
  }

  // Validate date is in future
  var neededBy = g_form.getValue("needed_by")
  var today = new GlideDateTime().getDate().getValue()
  if (neededBy < today) {
    g_form.showFieldMsg("needed_by", "Date must be in the future", "error")
    return false
  }

  return true
}
```

## Variable Sets

### Creating Reusable Variable Sets

```
Variable Set: User Contact Information
├── contact_name (Single Line Text)
├── contact_email (Email)
├── contact_phone (Single Line Text)
└── preferred_contact (Choice: Email, Phone, Either)

Use in multiple catalog items:
- New Laptop Request
- Software Installation
- Network Access Request
```

### Accessing Variable Set Values

```javascript
// In workflow or script
var ritm = current // sc_req_item

// Access variable from variable set
var contactEmail = ritm.variables.contact_email
var preferredContact = ritm.variables.preferred_contact
```

## Catalog Workflows/Flows

### Approval Pattern

```
Flow Trigger: sc_req_item created
├── If: Total cost > $5000
│   └── Request Approval: Department Manager
│   └── If: Rejected
│       └── Update: RITM state = Closed Incomplete
├── If: Total cost > $25000
│   └── Request Approval: VP
├── Create: Catalog Task for Fulfillment
└── Wait: Task completion
```

### Fulfillment Script

```javascript
// In catalog item's "Execution Plan" or workflow

var ritm = current // sc_req_item

// Create an incident from catalog request
var inc = new GlideRecord("incident")
inc.initialize()
inc.setValue("short_description", ritm.short_description)
inc.setValue("description", ritm.description)
inc.setValue("caller_id", ritm.request.requested_for)
inc.setValue("category", ritm.variables.category)
inc.setValue("priority", ritm.variables.urgency)
inc.insert()

// Link incident to request
ritm.setValue("u_fulfillment_record", inc.getUniqueValue())
ritm.update()
```

## Record Producers

### Creating Incidents via Catalog

```javascript
// Record Producer: Report an Issue
// Table: incident
// Script:

// Map variables to incident fields
current.short_description = producer.short_description
current.description = producer.description
current.caller_id = gs.getUserID()
current.category = producer.category
current.subcategory = producer.subcategory
current.priority = producer.urgency == "urgent" ? "2" : "3"

// Set assignment based on category
if (producer.category == "network") {
  current.assignment_group.setDisplayValue("Network Support")
} else {
  current.assignment_group.setDisplayValue("Service Desk")
}
```

## Order Guides

### Multi-Step Request Wizard

```
Order Guide: New Employee Onboarding
├── Step 1: Employee Information
│   └── Variable Set: Employee Details
├── Step 2: Hardware Selection
│   ├── Catalog Item: Laptop
│   ├── Catalog Item: Monitor
│   └── Catalog Item: Peripherals
├── Step 3: Software Requests
│   └── Rule: Show software based on department
├── Step 4: Access Requests
│   └── Cascade Variable: Copy employee info
└── Submit: Creates multiple RITMs
```

### Order Guide Rule

```javascript
// Rule: Show software items based on department
function rule(item, guide_variables) {
  var dept = guide_variables.department

  // Show engineering software only for Engineering
  if (item.name == "Engineering Software Suite") {
    return dept == "engineering"
  }

  // Show finance software only for Finance
  if (item.name == "Financial Tools") {
    return dept == "finance"
  }

  return true // Show all other items
}
```

## Pricing & Approvals

### Dynamic Pricing

```javascript
// Catalog Item Script (Pricing)
// Runs when item is added to cart

var basePrice = parseFloat(current.price) || 0
var quantity = parseInt(current.variables.quantity) || 1
var expedited = current.variables.expedited == "true"

var total = basePrice * quantity
if (expedited) {
  total *= 1.5 // 50% rush fee
}

current.recurring_price = 0
current.price = total
```

### Approval Rules

```
Approval Definition: High-Value Purchases
Condition: total_cost > 5000
Approver: requested_for.manager
Wait for: Approval
Rejection action: Cancel request
```

## Best Practices

1. **Variable Naming** - Use descriptive, lowercase names (no spaces)
2. **Variable Sets** - Reuse common variable groups
3. **Reference Qualifiers** - Filter to relevant records only
4. **Client Scripts** - Minimize server calls (use GlideAjax sparingly)
5. **Fulfillment** - Create tasks, don't complete directly
6. **Testing** - Test as different user roles
7. **Mobile** - Test catalog items on mobile/tablet
8. **Documentation** - Add help text to variables
