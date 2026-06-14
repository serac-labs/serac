---
name: import-export
description: Move data in and out of ServiceNow — CSV parsing into import sets, GlideImportSetTransformer runs, CSV/JSON/XML exports, scheduled data sources, bulk update and deleteMultiple safety patterns.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_create_import_set
  - snow_create_transform_map
  - snow_execute_script
  - snow_query_table
---

# Import/Export for ServiceNow

Import/Export handles data migration, bulk operations, and data transfer.

## Import/Export Architecture

```
Data Sources
    ├── Files (CSV, Excel, XML)
    ├── JDBC Connections
    └── REST/SOAP

Import Process
    ├── Import Set Tables
    ├── Transform Maps
    └── Target Tables

Export Process
    ├── Scheduled Exports
    ├── Report Exports
    └── XML Export
```

## Key Tables

| Table               | Purpose            |
| ------------------- | ------------------ |
| `sys_import_set`    | Import set records |
| `sys_data_source`   | Data sources       |
| `sys_transform_map` | Transform maps     |
| `sys_export_set`    | Export sets        |

## Data Import (ES5)

### Import from CSV

```javascript
// Import CSV data (ES5 ONLY!)
function importCSVData(csvContent, importSetTable) {
  var loader = new GlideImportSetLoader()

  // Create import set
  var importSet = new GlideRecord("sys_import_set")
  importSet.initialize()
  importSet.setValue("table_name", importSetTable)
  importSet.setValue("state", "loading")
  var importSetSysId = importSet.insert()

  // Parse CSV
  var lines = csvContent.split("\n")
  var headers = lines[0].split(",")

  // Clean headers
  for (var h = 0; h < headers.length; h++) {
    headers[h] = headers[h]
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")
  }

  // Import rows
  var rowCount = 0
  for (var i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue

    var values = parseCSVLine(lines[i])

    // Create import set row
    var row = new GlideRecord(importSetTable)
    row.initialize()
    row.setValue("sys_import_set", importSetSysId)

    for (var j = 0; j < headers.length && j < values.length; j++) {
      var fieldName = "u_" + headers[j]
      if (row.isValidField(fieldName)) {
        row.setValue(fieldName, values[j])
      }
    }

    row.insert()
    rowCount++
  }

  // Update import set
  importSet = new GlideRecord("sys_import_set")
  if (importSet.get(importSetSysId)) {
    importSet.setValue("state", "loaded")
    importSet.setValue("row_count", rowCount)
    importSet.update()
  }

  return {
    import_set: importSetSysId,
    rows: rowCount,
  }
}

function parseCSVLine(line) {
  var values = []
  var current = ""
  var inQuotes = false

  for (var i = 0; i < line.length; i++) {
    var char = line[i]

    if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === "," && !inQuotes) {
      values.push(current.trim())
      current = ""
    } else {
      current += char
    }
  }
  values.push(current.trim())

  return values
}
```

### Run Transform

```javascript
// Run transform on import set (ES5 ONLY!)
function runTransform(importSetSysId, transformMapName) {
  var importSet = new GlideRecord("sys_import_set")
  if (!importSet.get(importSetSysId)) {
    return { success: false, message: "Import set not found" }
  }

  // Get transform map
  var transformMap = new GlideRecord("sys_transform_map")
  if (!transformMap.get("name", transformMapName)) {
    return { success: false, message: "Transform map not found" }
  }

  // Run transform
  var transformer = new GlideImportSetTransformer()
  transformer.setImportSetID(importSetSysId)
  transformer.setTransformMapID(transformMap.getUniqueValue())
  transformer.transform()

  // Get results
  var results = {
    success: true,
    inserted: 0,
    updated: 0,
    ignored: 0,
    error: 0,
  }

  // Count results from import set rows
  var ga = new GlideAggregate(importSet.getValue("table_name"))
  ga.addQuery("sys_import_set", importSetSysId)
  ga.addAggregate("COUNT")
  ga.groupBy("sys_import_state")
  ga.query()

  while (ga.next()) {
    var state = ga.getValue("sys_import_state")
    var count = parseInt(ga.getAggregate("COUNT"), 10)

    if (state === "inserted") results.inserted = count
    else if (state === "updated") results.updated = count
    else if (state === "ignored") results.ignored = count
    else if (state === "error") results.error = count
  }

  return results
}
```

## Data Export (ES5)

### Export to CSV

```javascript
// Export table data to CSV (ES5 ONLY!)
function exportToCSV(tableName, encodedQuery, fields) {
  var fieldList = fields.split(",")
  var csv = ""

  // Header row
  csv += fieldList.join(",") + "\n"

  // Data rows
  var gr = new GlideRecord(tableName)
  if (encodedQuery) {
    gr.addEncodedQuery(encodedQuery)
  }
  gr.query()

  while (gr.next()) {
    var row = []
    for (var i = 0; i < fieldList.length; i++) {
      var field = fieldList[i].trim()
      var value = gr.getDisplayValue(field) || ""

      // Escape for CSV
      if (value.indexOf(",") !== -1 || value.indexOf('"') !== -1 || value.indexOf("\n") !== -1) {
        value = '"' + value.replace(/"/g, '""') + '"'
      }
      row.push(value)
    }
    csv += row.join(",") + "\n"
  }

  return csv
}

// Example
var csvData = exportToCSV("incident", "active=true^priority<=2", "number,short_description,priority,state,assigned_to")
```

### Export to JSON

```javascript
// Export to JSON (ES5 ONLY!)
function exportToJSON(tableName, encodedQuery, fields) {
  var fieldList = fields.split(",")
  var records = []

  var gr = new GlideRecord(tableName)
  if (encodedQuery) {
    gr.addEncodedQuery(encodedQuery)
  }
  gr.query()

  while (gr.next()) {
    var record = {}
    for (var i = 0; i < fieldList.length; i++) {
      var field = fieldList[i].trim()
      record[field] = {
        value: gr.getValue(field),
        display_value: gr.getDisplayValue(field),
      }
    }
    record.sys_id = gr.getUniqueValue()
    records.push(record)
  }

  return JSON.stringify(records, null, 2)
}
```

### Export to XML

```javascript
// Export records to XML (ES5 ONLY!)
function exportToXML(tableName, encodedQuery) {
  var exporter = new GlideRecordXMLSerializer()

  var gr = new GlideRecord(tableName)
  if (encodedQuery) {
    gr.addEncodedQuery(encodedQuery)
  }
  gr.query()

  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
  xml += "<records>\n"

  while (gr.next()) {
    xml += exporter.serialize(gr) + "\n"
  }

  xml += "</records>"

  return xml
}
```

## Scheduled Imports (ES5)

### Create Scheduled Import

```javascript
// Create scheduled data import (ES5 ONLY!)
var dataSource = new GlideRecord("sys_data_source")
dataSource.initialize()

// Data source config
dataSource.setValue("name", "Daily Employee Sync")
dataSource.setValue("type", "File")
dataSource.setValue("format", "CSV")

// File location
dataSource.setValue("file_path", "/import/employees.csv")

// Import set table
dataSource.setValue("import_set_table_name", "u_employee_import")

// Schedule
dataSource.setValue("schedule", scheduleId) // Reference to scheduled job

// Active
dataSource.setValue("active", true)

dataSource.insert()
```

### Scheduled Export

```javascript
// Scheduled export job (ES5 ONLY!)
;(function executeScheduledJob() {
  var LOG_PREFIX = "[ScheduledExport] "

  // Export data
  var csvData = exportToCSV(
    "incident",
    "closed_at>=javascript:gs.daysAgoStart(1)^closed_at<javascript:gs.daysAgoStart(0)",
    "number,short_description,resolved_at,resolution_code,resolved_by",
  )

  // Create attachment on export record
  var exportRecord = new GlideRecord("sys_export_set")
  exportRecord.initialize()
  exportRecord.setValue("name", "Daily Incident Export - " + new GlideDateTime().getLocalDate())
  exportRecord.setValue("table", "incident")
  var exportSysId = exportRecord.insert()

  // Attach CSV
  var attachment = new GlideSysAttachment()
  attachment.write(
    "sys_export_set",
    exportSysId,
    "incident_export_" + new GlideDateTime().getLocalDate() + ".csv",
    "text/csv",
    csvData,
  )

  gs.info(LOG_PREFIX + "Export completed")

  // Notify
  gs.eventQueue("export.complete", exportRecord, "", "")
})()
```

## Bulk Operations (ES5)

### Bulk Update

```javascript
// Bulk update records (ES5 ONLY!)
function bulkUpdate(tableName, encodedQuery, updates) {
  var updateCount = 0
  var errors = []

  var gr = new GlideRecord(tableName)
  if (encodedQuery) {
    gr.addEncodedQuery(encodedQuery)
  }
  gr.query()

  while (gr.next()) {
    try {
      for (var field in updates) {
        if (updates.hasOwnProperty(field) && gr.isValidField(field)) {
          gr.setValue(field, updates[field])
        }
      }
      gr.update()
      updateCount++
    } catch (e) {
      errors.push({
        sys_id: gr.getUniqueValue(),
        error: e.message,
      })
    }
  }

  return {
    updated: updateCount,
    errors: errors,
  }
}

// Example: Close old incidents
var result = bulkUpdate("incident", "active=true^sys_updated_on<javascript:gs.daysAgo(90)", {
  state: 7,
  close_code: "Closed/Resolved by Caller",
  close_notes: "Auto-closed due to inactivity",
})
```

### Bulk Delete

```javascript
// Bulk delete with safety checks (ES5 ONLY!)
function bulkDelete(tableName, encodedQuery, maxRecords) {
  maxRecords = maxRecords || 1000

  var gr = new GlideRecord(tableName)
  if (encodedQuery) {
    gr.addEncodedQuery(encodedQuery)
  }
  gr.setLimit(maxRecords)
  gr.query()

  var count = gr.getRowCount()

  if (count > maxRecords) {
    return {
      success: false,
      message: "Too many records (" + count + "). Max allowed: " + maxRecords,
    }
  }

  // Use deleteMultiple for efficiency
  gr = new GlideRecord(tableName)
  gr.addEncodedQuery(encodedQuery)
  gr.setLimit(maxRecords)
  gr.deleteMultiple()

  return {
    success: true,
    deleted: count,
  }
}
```

## MCP Tool Integration

### Available Tools

| Tool                              | Purpose            |
| --------------------------------- | ------------------ |
| `snow_create_import_set`          | Create import sets |
| `snow_create_transform_map`       | Create transforms  |
| `snow_execute_script`             | Test import/export |
| `snow_query_table`                | Query data         |

### Example Workflow

```javascript
// 1. Query import sets
await snow_query_table({
  table: "sys_import_set",
  query: "state=loaded",
  fields: "table_name,row_count,state,sys_created_on",
})

// 2. Export data
await snow_execute_script({
  script: `
        var csv = exportToCSV('incident', 'active=true', 'number,short_description,state');
        gs.info('Exported ' + csv.split('\\n').length + ' rows');
    `,
})

// 3. Check transform maps
await snow_query_table({
  table: "sys_transform_map",
  query: "active=true",
  fields: "name,source_table,target_table",
})
```

## Best Practices

1. **Validation** - Validate data before import
2. **Coalesce** - Use coalesce for updates
3. **Batch Size** - Limit batch operations
4. **Logging** - Track import/export activity
5. **Error Handling** - Handle row-level errors
6. **Scheduling** - Off-peak for large operations
7. **Backup** - Backup before bulk changes
8. **ES5 Only** - No modern JavaScript syntax
