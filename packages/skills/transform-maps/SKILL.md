---
name: transform-maps
description: Build ServiceNow transform maps — sys_data_source configurations (CSV/JDBC/REST), sys_transform_map field/reference/script entries, coalesce keys for update-vs-insert, and onBefore/onAfter/onComplete transform scripts.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_create_transform_map
  - snow_create_import_set
  - snow_query_table
  - snow_execute_script
---

# Transform Maps for ServiceNow

Transform Maps control how data from import sets is mapped and transformed into ServiceNow tables.

## Import Architecture

```
Data Source (CSV, LDAP, JDBC, REST)
        ↓
    Import Set Table (staging)
        ↓
    Transform Map (mapping rules)
        ↓
    Target Table (final destination)
```

## Key Components

| Component            | Table               | Purpose                  |
| -------------------- | ------------------- | ------------------------ |
| **Data Source**      | sys_data_source     | Connection configuration |
| **Import Set Table** | sys_db_object       | Staging table            |
| **Import Set**       | sys_import_set      | Import run record        |
| **Transform Map**    | sys_transform_map   | Mapping definition       |
| **Field Map**        | sys_transform_entry | Field mappings           |

## Data Sources

### CSV Data Source (ES5)

```javascript
// Create CSV data source
var ds = new GlideRecord("sys_data_source")
ds.initialize()
ds.setValue("name", "Employee Import - CSV")
ds.setValue("type", "File")
ds.setValue("format", "CSV")

// File settings
ds.setValue("file_path", "/import/employees.csv")
ds.setValue("header_row", 1)

// CSV parsing
ds.setValue("csv_delimiter", ",")
ds.setValue("csv_quote", '"')

// Import set table
ds.setValue("import_set_table", "u_employee_import")

ds.insert()
```

### JDBC Data Source (ES5)

```javascript
// Create JDBC data source
var ds = new GlideRecord("sys_data_source")
ds.initialize()
ds.setValue("name", "HR System - JDBC")
ds.setValue("type", "JDBC")

// Connection
ds.setValue("connection_url", "jdbc:oracle:thin:@hrdb:1521:HRPROD")
ds.setValue("username", "hr_readonly")
ds.setValue("password", "encrypted_password")

// Query
ds.setValue("query", "SELECT emp_id, first_name, last_name, email, dept_code FROM employees WHERE active = 1")

// Import set table
ds.setValue("import_set_table", "u_hr_employee_import")

ds.insert()
```

### REST Data Source (ES5)

```javascript
// Create REST data source
var ds = new GlideRecord("sys_data_source")
ds.initialize()
ds.setValue("name", "External API - REST")
ds.setValue("type", "REST (IntegrationHub)")

// REST message
ds.setValue("rest_message", restMessageSysId)
ds.setValue("http_method", "GET")

// Response handling
ds.setValue("json_path", "$.data.employees[*]")

// Import set table
ds.setValue("import_set_table", "u_api_employee_import")

ds.insert()
```

## Import Set Tables

### Creating Import Set Table (ES5)

```javascript
// Create staging table for employee import
var table = new GlideRecord("sys_db_object")
table.initialize()
table.setValue("name", "u_employee_import")
table.setValue("label", "Employee Import")
table.setValue("super_class", "sys_import_set_row") // Extends import set row
table.setValue("is_extendable", false)
table.insert()

// Add columns matching source data
var columns = [
  { name: "u_employee_id", type: "string", max_length: 50 },
  { name: "u_first_name", type: "string", max_length: 100 },
  { name: "u_last_name", type: "string", max_length: 100 },
  { name: "u_email", type: "string", max_length: 255 },
  { name: "u_department", type: "string", max_length: 100 },
  { name: "u_manager_id", type: "string", max_length: 50 },
  { name: "u_start_date", type: "string", max_length: 20 },
]

for (var i = 0; i < columns.length; i++) {
  var col = new GlideRecord("sys_dictionary")
  col.initialize()
  col.setValue("name", "u_employee_import")
  col.setValue("element", columns[i].name)
  col.setValue("internal_type", columns[i].type)
  col.setValue("max_length", columns[i].max_length)
  col.insert()
}
```

## Transform Maps

### Creating Transform Map (ES5)

```javascript
// Create transform map
var tm = new GlideRecord("sys_transform_map")
tm.initialize()
tm.setValue("name", "Employee Import Transform")
tm.setValue("source_table", "u_employee_import")
tm.setValue("target_table", "sys_user")

// Run order (for multiple transforms)
tm.setValue("order", 100)

// Active
tm.setValue("active", true)

// Copy empty fields
tm.setValue("copy_empty_fields", false)

// Enforce mandatory fields
tm.setValue("enforce_mandatory_fields", true)

var tmSysId = tm.insert()
```

## Field Mappings

### Direct Field Mapping (ES5)

```javascript
// Map source fields to target fields
function addFieldMap(transformMapId, sourceField, targetField, config) {
  var fm = new GlideRecord("sys_transform_entry")
  fm.initialize()
  fm.setValue("map", transformMapId)
  fm.setValue("source_field", sourceField)
  fm.setValue("target_field", targetField)

  // Coalesce (match existing records)
  if (config && config.coalesce) {
    fm.setValue("coalesce", true)
  }

  // Order
  fm.setValue("order", config ? config.order : 100)

  return fm.insert()
}

// Map employee fields
addFieldMap(tmSysId, "u_employee_id", "employee_number", { coalesce: true, order: 10 })
addFieldMap(tmSysId, "u_first_name", "first_name", { order: 20 })
addFieldMap(tmSysId, "u_last_name", "last_name", { order: 30 })
addFieldMap(tmSysId, "u_email", "email", { order: 40 })
```

### Reference Field Mapping (ES5)

```javascript
// Map to reference field (lookup by value)
var deptMap = new GlideRecord("sys_transform_entry")
deptMap.initialize()
deptMap.setValue("map", tmSysId)
deptMap.setValue("source_field", "u_department")
deptMap.setValue("target_field", "department")

// Reference handling
deptMap.setValue("reference_key", true)
deptMap.setValue("reference_key_field", "name") // Lookup by department name

// Create if not found
deptMap.setValue("create_also", false)

deptMap.insert()
```

### Scripted Field Mapping (ES5)

```javascript
// Script-based field transformation
var scriptMap = new GlideRecord("sys_transform_entry")
scriptMap.initialize()
scriptMap.setValue("map", tmSysId)
scriptMap.setValue("target_field", "name")
scriptMap.setValue(
  "source_script",
  "// Combine first and last name\n" + 'answer = source.u_first_name + " " + source.u_last_name;',
)
scriptMap.insert()

// Date transformation script
var dateMap = new GlideRecord("sys_transform_entry")
dateMap.initialize()
dateMap.setValue("map", tmSysId)
dateMap.setValue("target_field", "u_start_date")
dateMap.setValue(
  "source_script",
  "// Convert MM/DD/YYYY to ServiceNow date format\n" +
    'var parts = source.u_start_date.split("/");\n' +
    "if (parts.length === 3) {\n" +
    '    answer = parts[2] + "-" + parts[0] + "-" + parts[1];\n' +
    "} else {\n" +
    '    answer = "";\n' +
    "}",
)
dateMap.insert()
```

## Coalesce (Update vs Insert)

### Coalesce Configuration

```javascript
// Coalesce on employee_number to update existing records
var coalesceMap = new GlideRecord("sys_transform_entry")
coalesceMap.initialize()
coalesceMap.setValue("map", tmSysId)
coalesceMap.setValue("source_field", "u_employee_id")
coalesceMap.setValue("target_field", "employee_number")
coalesceMap.setValue("coalesce", true) // KEY: Use for matching
coalesceMap.setValue("order", 1) // Process first
coalesceMap.insert()

// Multiple coalesce fields (compound key)
// First field with coalesce=true, second with coalesce=true
// Both must match for update
```

## Transform Scripts

### onBefore Script (ES5)

```javascript
// Transform Map > onBefore script
// Runs before each row is processed

;(function runTransformScript(source, map, log, target) {
  // Skip inactive employees
  if (source.u_status === "INACTIVE") {
    ignore = true // Skip this row
    return
  }

  // Validate required fields
  if (!source.u_employee_id || !source.u_email) {
    log.error("Missing required fields for row: " + source.sys_id)
    ignore = true
    return
  }

  // Normalize email
  source.u_email = source.u_email.toString().toLowerCase()
})(source, map, log, target)
```

### onAfter Script (ES5)

```javascript
// Transform Map > onAfter script
// Runs after each row is processed

;(function runTransformScript(source, map, log, target) {
  // Add user to appropriate group based on department
  if (target && action !== "ignore") {
    var dept = target.department.getDisplayValue()
    var groupName = ""

    if (dept === "IT") {
      groupName = "IT Staff"
    } else if (dept === "HR") {
      groupName = "HR Team"
    }

    if (groupName) {
      addUserToGroup(target.sys_id, groupName)
    }
  }

  function addUserToGroup(userId, groupName) {
    var group = new GlideRecord("sys_user_group")
    group.addQuery("name", groupName)
    group.query()

    if (group.next()) {
      var member = new GlideRecord("sys_user_grmember")
      member.addQuery("user", userId)
      member.addQuery("group", group.getUniqueValue())
      member.query()

      if (!member.next()) {
        member.initialize()
        member.setValue("user", userId)
        member.setValue("group", group.getUniqueValue())
        member.insert()
      }
    }
  }
})(source, map, log, target)
```

### onComplete Script (ES5)

```javascript
// Transform Map > onComplete script
// Runs after all rows are processed

;(function runTransformScript(source, map, log, target) {
  // Log import statistics
  var importSet = new GlideRecord("sys_import_set")
  if (importSet.get(source.sys_import_set)) {
    var stats = {
      total: importSet.getValue("rows"),
      inserted: importSet.getValue("insertions"),
      updated: importSet.getValue("updates"),
      errors: importSet.getValue("errors"),
    }

    log.info("Import completed: " + JSON.stringify(stats))

    // Send notification if errors
    if (stats.errors > 0) {
      gs.eventQueue("import.errors", importSet, stats.errors.toString())
    }
  }
})(source, map, log, target)
```

## Running Imports

### Manual Import Execution (ES5)

```javascript
// Execute import programmatically
var loader = new GlideImportSetLoader(dataSourceSysId)
var importSetSysId = loader.loadImportSet()

if (importSetSysId) {
  // Run transform
  var transformer = new GlideImportSetTransformer()
  transformer.setImportSetID(importSetSysId)
  transformer.transform()

  // Check results
  var importSet = new GlideRecord("sys_import_set")
  if (importSet.get(importSetSysId)) {
    gs.info("Import completed: " + importSet.getValue("state"))
    gs.info("Rows: " + importSet.getValue("rows"))
    gs.info("Errors: " + importSet.getValue("errors"))
  }
}
```

## MCP Tool Integration

### Available Import Tools

| Tool                         | Purpose              |
| ---------------------------- | -------------------- |
| `snow_create_transform_map`  | Create transform map |
| `snow_create_field_map`      | Add field mapping    |
| `snow_create_import_set`     | Create import set    |
| `snow_discover_data_sources` | Find data sources    |
| `snow_test_integration`      | Test connection      |

### Example Workflow

```javascript
// 1. Create import set table, then add one column per field
await snow_create_table({
  name: "u_vendor_import",
  label: "Vendor Import",
  extends_table: "sys_import_set_row",
})

await snow_create_field({ table: "u_vendor_import", column_name: "u_vendor_id", internal_type: "string" })
await snow_create_field({ table: "u_vendor_import", column_name: "u_vendor_name", internal_type: "string" })
await snow_create_field({ table: "u_vendor_import", column_name: "u_contact_email", internal_type: "string" })

// 2. Create transform map
var transformId = await snow_create_transform_map({
  name: "Vendor Import",
  source_table: "u_vendor_import",
  target_table: "core_company",
})

// 3. Add field mappings
await snow_create_field_map({
  transform_map: transformId,
  source: "u_vendor_id",
  target: "vendor_code",
  coalesce: true,
})

await snow_create_field_map({
  transform_map: transformId,
  source: "u_vendor_name",
  target: "name",
})

// 4. Stage rows into the import set table, then run the transform
var importResult = await snow_create_import_set({
  table: "u_vendor_import",
  data: [
    { u_vendor_id: "V001", u_vendor_name: "Acme Corp", u_contact_email: "ops@acme.example" },
  ],
})

await snow_execute_transform({
  import_set_sys_id: importResult.import_set,
  transform_map_sys_id: transformId,
})
```

## Best Practices

1. **Staging Tables** - Always use import set tables
2. **Coalesce Keys** - Define clear matching criteria
3. **Validate Data** - Use onBefore scripts
4. **Error Handling** - Log and handle failures
5. **Incremental Imports** - Track last import date
6. **Testing** - Test with small datasets first
7. **Rollback Plan** - Be able to undo imports
8. **Scheduling** - Use scheduled data sources
