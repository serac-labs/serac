---
name: data-policies
description: Manage ServiceNow dictionary (sys_dictionary), table/field creation, choice lists, dictionary overrides, and sys_data_policy2 rules that enforce mandatory/read-only/visible field behavior on the data layer.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_discover_table_fields
  - snow_query_table
  - snow_execute_script
---

# Data Policies & Dictionary for ServiceNow

Data Policies enforce data integrity rules. Dictionary controls schema and field behavior.

## Architecture

```
Dictionary (sys_dictionary)
    ├── Field Definition
    │   ├── Type, Length, Default
    │   └── Dependent Field
    └── Dictionary Overrides (sys_dictionary_override)

Data Policy (sys_data_policy2)
    └── Data Policy Rules (sys_data_policy_rule)
        └── Condition-based field behaviors
```

## Key Tables

| Table                     | Purpose           |
| ------------------------- | ----------------- |
| `sys_dictionary`          | Field definitions |
| `sys_dictionary_override` | Scoped overrides  |
| `sys_data_policy2`        | Data policies     |
| `sys_data_policy_rule`    | Policy rules      |
| `sys_db_object`           | Table definitions |

## Dictionary Management (ES5)

### Create Table

```javascript
// Create custom table (ES5 ONLY!)
var table = new GlideRecord("sys_db_object")
table.initialize()

table.setValue("name", "u_custom_table")
table.setValue("label", "Custom Table")
table.setValue("super_class", "task") // Extends task
table.setValue("is_extendable", true)
table.setValue("create_access_controls", true)
table.setValue("live_feed_enabled", false)

table.insert()
```

### Create Field

```javascript
// Create field on table (ES5 ONLY!)
var field = new GlideRecord("sys_dictionary")
field.initialize()

// Table and element
field.setValue("name", "u_custom_table")
field.setValue("element", "u_customer_name")

// Field properties
field.setValue("column_label", "Customer Name")
field.setValue("internal_type", "string")
field.setValue("max_length", 100)
field.setValue("mandatory", false)
field.setValue("read_only", false)
field.setValue("display", false)
field.setValue("active", true)

// Default value
field.setValue("default_value", "")

// Reference field specific
// field.setValue('reference', 'customer_account');
// field.setValue('reference_qual', 'active=true');

field.insert()
```

### Field Types

```javascript
// Common field types
var FIELD_TYPES = {
  STRING: "string",
  INTEGER: "integer",
  DECIMAL: "decimal",
  BOOLEAN: "boolean",
  GLIDE_DATE: "glide_date",
  GLIDE_DATE_TIME: "glide_date_time",
  REFERENCE: "reference",
  CHOICE: "choice",
  JOURNAL: "journal",
  JOURNAL_INPUT: "journal_input",
  HTML: "html",
  URL: "url",
  EMAIL: "email",
  SCRIPT: "script",
  CONDITIONS: "conditions",
}

// Create different field types (ES5 ONLY!)
function createField(tableName, fieldDef) {
  var field = new GlideRecord("sys_dictionary")
  field.initialize()
  field.setValue("name", tableName)
  field.setValue("element", fieldDef.name)
  field.setValue("column_label", fieldDef.label)
  field.setValue("internal_type", fieldDef.type)

  if (fieldDef.maxLength) {
    field.setValue("max_length", fieldDef.maxLength)
  }

  if (fieldDef.reference) {
    field.setValue("reference", fieldDef.reference)
  }

  if (fieldDef.choices) {
    field.setValue("choice", 1) // Has choices
  }

  return field.insert()
}
```

### Create Choices

```javascript
// Create choice list values (ES5 ONLY!)
function createChoices(tableName, fieldName, choices) {
  for (var i = 0; i < choices.length; i++) {
    var choice = new GlideRecord("sys_choice")
    choice.initialize()
    choice.setValue("name", tableName)
    choice.setValue("element", fieldName)
    choice.setValue("value", choices[i].value)
    choice.setValue("label", choices[i].label)
    choice.setValue("sequence", (i + 1) * 10)
    choice.setValue("inactive", false)
    choice.insert()
  }
}

// Usage
createChoices("incident", "u_custom_status", [
  { value: "pending", label: "Pending Review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
])
```

## Dictionary Overrides (ES5)

### Create Override

```javascript
// Create dictionary override for scoped app (ES5 ONLY!)
var override = new GlideRecord("sys_dictionary_override")
override.initialize()

// Reference the base field
override.setValue("base_table", "task")
override.setValue("base_element", "short_description")

// Target table
override.setValue("name", "u_custom_table")

// Override properties
override.setValue("column_label", "Request Summary")
override.setValue("mandatory", true)
override.setValue("read_only", false)
override.setValue("max_length", 200)

// Default value override
override.setValue("default_value", "")

override.insert()
```

## Data Policies (ES5)

### Create Data Policy

```javascript
// Create data policy (ES5 ONLY!)
var policy = new GlideRecord("sys_data_policy2")
policy.initialize()

policy.setValue("model_table", "incident")
policy.setValue("short_description", "Resolution Fields Required on Resolve")
policy.setValue("active", true)

// Conditions - when policy applies
policy.setValue("conditions", "state=6") // Resolved state

// Apply to forms
policy.setValue("apply_to_client", true)
policy.setValue("apply_to_import_sets", true)
policy.setValue("apply_to_soap", true)

// Reverse
policy.setValue("reverse_if_false", true)

var policySysId = policy.insert()

// Add policy rules
addDataPolicyRule(policySysId, "resolution_code", true, false, false)
addDataPolicyRule(policySysId, "close_notes", true, false, false)
```

### Add Policy Rules

```javascript
// Add data policy rule (ES5 ONLY!)
function addDataPolicyRule(policySysId, fieldName, mandatory, readOnly, hidden) {
  var rule = new GlideRecord("sys_data_policy_rule")
  rule.initialize()
  rule.setValue("sys_data_policy", policySysId)
  rule.setValue("field", fieldName)
  rule.setValue("mandatory", mandatory)
  rule.setValue("read_only", readOnly)
  rule.setValue("visible", !hidden)
  return rule.insert()
}
```

### Complex Data Policy

```javascript
// Data policy with scripted condition (ES5 ONLY!)
var policy = new GlideRecord("sys_data_policy2")
policy.initialize()

policy.setValue("model_table", "change_request")
policy.setValue("short_description", "High Risk Change Requirements")
policy.setValue("active", true)

// Use scripted condition for complex logic
policy.setValue("use_as_condition", true)
policy.setValue(
  "script",
  "(function checkCondition(current) {\n" +
    "    // High risk changes require additional fields\n" +
    '    if (current.risk == "high") {\n' +
    "        return true;\n" +
    "    }\n" +
    "    \n" +
    "    // Also apply to changes affecting critical CIs\n" +
    "    if (current.cmdb_ci) {\n" +
    "        var ci = current.cmdb_ci.getRefRecord();\n" +
    '        if (ci.business_criticality == "1 - most critical") {\n' +
    "            return true;\n" +
    "        }\n" +
    "    }\n" +
    "    \n" +
    "    return false;\n" +
    "})(current);",
)

var policySysId = policy.insert()

// Require additional documentation for high risk
addDataPolicyRule(policySysId, "implementation_plan", true, false, false)
addDataPolicyRule(policySysId, "backout_plan", true, false, false)
addDataPolicyRule(policySysId, "test_plan", true, false, false)
addDataPolicyRule(policySysId, "justification", true, false, false)
```

## Field Validation (ES5)

### Dictionary Attribute Validation

```javascript
// Add validation to dictionary field (ES5 ONLY!)
var field = new GlideRecord("sys_dictionary")
if (field.get("name", "incident").get("element", "u_email")) {
  // Add regex validation
  field.setValue("attributes", "validate=email")
  field.update()
}

// Common validation attributes
var VALIDATION_ATTRIBUTES = {
  EMAIL: "validate=email",
  PHONE: "validate=phone_number",
  URL: "validate=url",
  CUSTOM: "validate=script", // Uses script in Calculated Value
}
```

### Script Validation

```javascript
// Calculated field with validation (ES5 ONLY!)
// Set in Dictionary > Calculated Value

// Check phone format
;(function calculate() {
  var phone = current.getValue("u_phone")
  if (!phone) return ""

  // Format validation
  var phonePattern = /^\+?[1-9]\d{1,14}$/
  if (!phonePattern.test(phone.replace(/[\s\-\(\)]/g, ""))) {
    gs.addErrorMessage("Invalid phone number format")
    return ""
  }

  return phone
})()
```

## Schema Queries (ES5)

### Get Table Fields

```javascript
// Get all fields for a table (ES5 ONLY!)
function getTableFields(tableName) {
  var fields = []

  var dict = new GlideRecord("sys_dictionary")
  dict.addQuery("name", tableName)
  dict.addQuery("internal_type", "!=", "collection")
  dict.addQuery("active", true)
  dict.orderBy("element")
  dict.query()

  while (dict.next()) {
    fields.push({
      name: dict.getValue("element"),
      label: dict.getValue("column_label"),
      type: dict.getValue("internal_type"),
      mandatory: dict.getValue("mandatory") === "true",
      reference: dict.getValue("reference"),
      maxLength: dict.getValue("max_length"),
    })
  }

  return fields
}
```

### Check Field Exists

```javascript
// Check if field exists on table (ES5 ONLY!)
function fieldExists(tableName, fieldName) {
  var dict = new GlideRecord("sys_dictionary")
  dict.addQuery("name", tableName)
  dict.addQuery("element", fieldName)
  dict.query()
  return dict.hasNext()
}
```

## MCP Tool Integration

### Available Tools

| Tool                         | Purpose                          |
| ---------------------------- | -------------------------------- |
| `snow_query_table`           | Query dictionary & data policies |
| `snow_discover_table_fields` | Get field definitions            |
| `snow_execute_script`        | Test dictionary scripts          |

### Example Workflow

```javascript
// 1. Get table fields
await snow_discover_table_fields({
  table_name: "incident",
})

// 2. Query data policies
await snow_query_table({
  table: "sys_data_policy2",
  query: "model_table=incident^active=true",
  fields: "short_description,conditions,apply_to_client",
})

// 3. Check dictionary overrides
await snow_query_table({
  table: "sys_dictionary_override",
  query: "name=u_custom_table",
  fields: "base_element,column_label,mandatory,read_only",
})
```

## Best Practices

1. **Schema Planning** - Design before implementation
2. **Field Naming** - u\_ prefix for custom fields
3. **Data Types** - Use appropriate types
4. **Mandatory Fields** - Only when truly required
5. **Data Policies** - Enforce business rules
6. **Performance** - Avoid complex calculated fields
7. **Documentation** - Document custom schema
8. **ES5 Only** - No modern JavaScript syntax
