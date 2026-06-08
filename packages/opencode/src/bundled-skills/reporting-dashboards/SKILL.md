---
name: reporting-dashboards
description: Build ServiceNow reports (list/bar/pie/line/pivot/single-score) on sys_report, sys_dashboard layouts with widget placement, scheduled report delivery, and drill-down configuration.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_create_report
  - snow_create_dashboard
  - snow_schedule_report
  - snow_query_table
---

# Reporting & Dashboards for ServiceNow

ServiceNow provides comprehensive reporting capabilities for data visualization and business intelligence.

## Report Types

| Type             | Use Case            | Example               |
| ---------------- | ------------------- | --------------------- |
| **List**         | Tabular data        | Incident list         |
| **Bar**          | Category comparison | Incidents by priority |
| **Pie/Donut**    | Distribution        | Tickets by category   |
| **Line/Area**    | Trends over time    | Weekly ticket volume  |
| **Pivot Table**  | Multi-dimensional   | Priority x Category   |
| **Single Score** | KPI value           | Open P1 count         |
| **Gauge**        | Progress/threshold  | SLA compliance        |

## Creating Reports

### List Report (ES5)

```javascript
// Create list report
var report = new GlideRecord("sys_report")
report.initialize()

report.setValue("title", "Open High Priority Incidents")
report.setValue("table", "incident")
report.setValue("type", "list")

// Filter condition
report.setValue("filter", "active=true^priority<=2")

// Columns
report.setValue("field", "number,short_description,priority,state,assigned_to,opened_at")

// Sorting
report.setValue("orderby", "priority")
report.setValue("order", "ASC")

// Grouping (optional)
report.setValue("group", "assignment_group")

// Access control
report.setValue("user", gs.getUserID())
report.setValue("roles", "itil")

report.insert()
```

### Bar Chart Report (ES5)

```javascript
// Create bar chart
var barReport = new GlideRecord("sys_report")
barReport.initialize()

barReport.setValue("title", "Incidents by Priority")
barReport.setValue("table", "incident")
barReport.setValue("type", "bar")

// Aggregation
barReport.setValue("aggregate", "COUNT")
barReport.setValue("group", "priority")

// Filter
barReport.setValue("filter", "active=true")

// Chart options
barReport.setValue("show_data_label", true)
barReport.setValue("show_legend", true)
barReport.setValue("chart_color", "blue")

barReport.insert()
```

### Trend Report (ES5)

```javascript
// Create trend line chart
var trendReport = new GlideRecord("sys_report")
trendReport.initialize()

trendReport.setValue("title", "Incident Volume - Last 30 Days")
trendReport.setValue("table", "incident")
trendReport.setValue("type", "line")

// Time-based grouping
trendReport.setValue("trend", "opened_at")
trendReport.setValue("trend_interval", "day")

// Aggregation
trendReport.setValue("aggregate", "COUNT")

// Time filter
var thirtyDaysAgo = new GlideDateTime()
thirtyDaysAgo.addDaysLocalTime(-30)
trendReport.setValue("filter", "opened_at>=" + thirtyDaysAgo.getValue())

// Stacked by category
trendReport.setValue("stack", "priority")

trendReport.insert()
```

### Pivot Table (ES5)

```javascript
// Create pivot table
var pivotReport = new GlideRecord("sys_report")
pivotReport.initialize()

pivotReport.setValue("title", "Incidents: Priority vs Category")
pivotReport.setValue("table", "incident")
pivotReport.setValue("type", "pivot")

// Dimensions
pivotReport.setValue("group", "priority") // Rows
pivotReport.setValue("stack", "category") // Columns

// Aggregation
pivotReport.setValue("aggregate", "COUNT")

// Filter
pivotReport.setValue("filter", "active=true")

// Show totals
pivotReport.setValue("show_row_total", true)
pivotReport.setValue("show_column_total", true)

pivotReport.insert()
```

## Dashboards

### Creating Dashboard (ES5)

```javascript
// Create dashboard
var dashboard = new GlideRecord("sys_dashboard")
dashboard.initialize()

dashboard.setValue("name", "IT Service Desk Dashboard")
dashboard.setValue("description", "Key metrics for service desk operations")

// Layout
dashboard.setValue("layout", "3") // 1, 2, 3, or 4 columns

// Access
dashboard.setValue("view_as", "desktop")
dashboard.setValue("roles", "itil")

var dashboardSysId = dashboard.insert()
```

### Adding Widgets to Dashboard (ES5)

```javascript
// Add report widget
function addReportToDashboard(dashboardId, reportId, row, column, width, height) {
  var widget = new GlideRecord("sys_dashboard_widget")
  widget.initialize()
  widget.setValue("dashboard", dashboardId)
  widget.setValue("report", reportId)
  widget.setValue("row", row)
  widget.setValue("column", column)
  widget.setValue("width", width || 1) // columns wide
  widget.setValue("height", height || 1) // rows tall
  return widget.insert()
}

// Layout example (3-column dashboard)
// Row 0: Three single-score cards
addReportToDashboard(dashboardSysId, openIncidentsReport, 0, 0, 1, 1)
addReportToDashboard(dashboardSysId, avgResolutionReport, 0, 1, 1, 1)
addReportToDashboard(dashboardSysId, slaComplianceReport, 0, 2, 1, 1)

// Row 1: Full-width trend chart
addReportToDashboard(dashboardSysId, trendReport, 1, 0, 3, 2)

// Row 2: Two charts side by side
addReportToDashboard(dashboardSysId, priorityPieChart, 3, 0, 1, 2)
addReportToDashboard(dashboardSysId, categoryBarChart, 3, 1, 2, 2)
```

## Scheduled Reports

### Create Scheduled Report (ES5)

```javascript
// Schedule report for email delivery
var schedule = new GlideRecord("sys_report_schedule")
schedule.initialize()

schedule.setValue("report", reportSysId)
schedule.setValue("name", "Weekly Incident Summary")

// Recipients
schedule.setValue("recipients", "it-managers@company.com")
schedule.setValue("recipient_users", managersSysIds) // comma-separated
schedule.setValue("recipient_groups", itManagersGroup)

// Schedule (cron)
schedule.setValue("run", "weekly")
schedule.setValue("day", "monday")
schedule.setValue("time", "08:00:00")

// Format
schedule.setValue("format", "pdf") // pdf, xlsx, csv

// Email settings
schedule.setValue("subject", "Weekly IT Incident Summary")
schedule.setValue("message", "Please find attached the weekly incident summary report.")

schedule.setValue("active", true)

schedule.insert()
```

## Advanced Reporting

### Report with Formula Field (ES5)

```javascript
// Report with calculated field
var report = new GlideRecord("sys_report")
report.initialize()

report.setValue("title", "SLA Breach Analysis")
report.setValue("table", "task_sla")
report.setValue("type", "bar")

// Custom formula aggregation
report.setValue("aggregate", "SUM")
report.setValue("field", "has_breached") // Boolean to count

// Percentage calculation
report.setValue("formula", "CASE WHEN {has_breached} = 1 THEN 1 ELSE 0 END")

report.setValue("group", "sla.name")

report.insert()
```

### Drill-Down Report (ES5)

```javascript
// Create report with drill-down capability
var summaryReport = new GlideRecord("sys_report")
summaryReport.initialize()

summaryReport.setValue("title", "Incidents by Assignment Group")
summaryReport.setValue("table", "incident")
summaryReport.setValue("type", "bar")
summaryReport.setValue("aggregate", "COUNT")
summaryReport.setValue("group", "assignment_group")

// Enable drill-down
summaryReport.setValue("is_drillable", true)
summaryReport.setValue("drill_down_report", detailReportSysId)

summaryReport.insert()
```

## Export & Integration

### Export Report Data (ES5)

```javascript
// Export report to CSV
function exportReportToCSV(reportSysId) {
  var report = new GlideRecord("sys_report")
  if (!report.get(reportSysId)) return null

  var ga = new GlideAggregate(report.getValue("table"))

  // Apply filter
  var filter = report.getValue("filter")
  if (filter) {
    ga.addEncodedQuery(filter)
  }

  // Apply grouping
  var groupField = report.getValue("group")
  if (groupField) {
    ga.addAggregate("COUNT")
    ga.groupBy(groupField)
  }

  ga.query()

  var results = []
  while (ga.next()) {
    results.push({
      group: ga.getValue(groupField),
      count: ga.getAggregate("COUNT"),
    })
  }

  return results
}
```

### REST API for Reports

```javascript
// Get report data via REST
// GET /api/now/stats/{table}?sysparm_query={filter}&sysparm_count=true&sysparm_group_by={field}

// Example: Incidents by priority
// GET /api/now/stats/incident?sysparm_query=active=true&sysparm_count=true&sysparm_group_by=priority
```

## MCP Tool Integration

### Available Reporting Tools

| Tool                             | Purpose               |
| -------------------------------- | --------------------- |
| `snow_create_report`             | Create report         |
| `snow_create_dashboard`          | Create dashboard      |
| `snow_create_scheduled_report`   | Schedule delivery     |
| `snow_discover_reporting_tables` | Find available tables |
| `snow_discover_report_fields`    | Get field options     |
| `snow_export_report_data`        | Export data           |
| `snow_create_data_visualization` | Create chart          |

### Example Workflow

```javascript
// 1. Discover available tables
var tables = await snow_discover_reporting_tables({
  category: "itsm",
})

// 2. Get fields for table
var fields = await snow_discover_report_fields({
  table: "incident",
})

// 3. Create report
var reportId = await snow_create_report({
  title: "Incident Overview",
  table: "incident",
  type: "bar",
  group: "priority",
  aggregate: "COUNT",
  filter: "active=true",
})

// 4. Create dashboard
var dashboardId = await snow_create_dashboard({
  name: "Service Desk Overview",
  layout: "3-column",
})

// 5. Add report to dashboard
await snow_add_dashboard_widget({
  dashboard: dashboardId,
  report: reportId,
  row: 0,
  column: 0,
})

// 6. Schedule report
await snow_create_scheduled_report({
  report: reportId,
  frequency: "weekly",
  recipients: "managers@company.com",
  format: "pdf",
})
```

## Best Practices

1. **Clear Titles** - Descriptive, action-oriented names
2. **Appropriate Type** - Match chart type to data
3. **Filter Wisely** - Default to relevant subset
4. **Color Meaning** - Consistent color conventions
5. **Mobile Friendly** - Test on smaller screens
6. **Performance** - Limit rows, use aggregations
7. **Access Control** - Role-based visibility
8. **Regular Refresh** - Keep data current
