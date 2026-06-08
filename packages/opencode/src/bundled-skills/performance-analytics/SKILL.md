---
name: performance-analytics
description: Build ServiceNow Performance Analytics — pa_indicators (count/sum/avg/percentage), pa_breakdowns, pa_thresholds with severity colors, pa_widgets, and pa_dashboards for KPI tracking.
license: Apache-2.0
compatibility: Designed for Snow-Code and ServiceNow development
metadata:
  author: serac
  version: "1.0.0"
  category: servicenow
tools:
  - snow_pa_indicator_create
  - snow_pa_breakdown_create
  - snow_query_table
  - snow_find_artifact
---

# Performance Analytics for ServiceNow

Performance Analytics (PA) provides advanced reporting and KPI tracking capabilities for measuring and improving business processes.

## PA Architecture

### Component Hierarchy

```
PA Dashboard
├── Widgets
│   ├── Scorecard Widget
│   ├── Time Series Chart
│   ├── Breakdown Pie Chart
│   └── Single Score
├── Indicators
│   ├── Number of Open Incidents
│   ├── Average Resolution Time
│   └── SLA Compliance Rate
├── Breakdowns
│   ├── By Priority
│   ├── By Assignment Group
│   └── By Category
└── Thresholds
    ├── Critical: > 100
    └── Warning: > 50
```

### Key Tables

| Table                     | Purpose                   |
| ------------------------- | ------------------------- |
| `pa_indicators`           | KPI definitions           |
| `pa_indicator_breakdowns` | Indicator-breakdown links |
| `pa_breakdowns`           | Breakdown definitions     |
| `pa_thresholds`           | Threshold rules           |
| `pa_widgets`              | Dashboard widgets         |
| `pa_dashboards`           | Dashboard containers      |

## Indicators

### Indicator Types

| Type           | Aggregation      | Example             |
| -------------- | ---------------- | ------------------- |
| **Count**      | COUNT(\*)        | Number of incidents |
| **Sum**        | SUM(field)       | Total cost          |
| **Average**    | AVG(field)       | Avg resolution time |
| **Percentage** | (A/B)\*100       | SLA compliance %    |
| **Duration**   | Time calculation | Avg time to resolve |

### Creating Count Indicator (ES5)

```javascript
// Create "Open Incidents" indicator
var indicator = new GlideRecord("pa_indicators")
indicator.initialize()
indicator.setValue("name", "Open Incidents")
indicator.setValue("description", "Number of currently open incidents")

// Source configuration
indicator.setValue("cube", "pa_cubes_incident") // or table-based
indicator.setValue("facts_table", "incident")
indicator.setValue("conditions", "active=true")

// Aggregation
indicator.setValue("aggregate", "COUNT") // COUNT, SUM, AVG

// Display settings
indicator.setValue("direction", 2) // 1=Up is good, 2=Down is good
indicator.setValue("unit", "Incidents")
indicator.setValue("precision", 0) // Decimal places

// Scoring
indicator.setValue("frequency", "daily")

indicator.insert()
```

### Creating Average Indicator (ES5)

```javascript
// Create "Average Resolution Time" indicator
var indicator = new GlideRecord("pa_indicators")
indicator.initialize()
indicator.setValue("name", "Avg Resolution Time")
indicator.setValue("description", "Average time to resolve incidents")

indicator.setValue("facts_table", "incident")
indicator.setValue("conditions", "state=6") // Resolved

// Aggregation on duration
indicator.setValue("aggregate", "AVG")
indicator.setValue("field", "calendar_duration") // Duration field

// Time unit
indicator.setValue("unit", "Hours")
indicator.setValue("unit_conversion", 3600) // Seconds to hours

indicator.setValue("direction", 2) // Lower is better
indicator.setValue("frequency", "daily")

indicator.insert()
```

### Creating Percentage Indicator (ES5)

```javascript
// Create "SLA Compliance" percentage indicator
var indicator = new GlideRecord("pa_indicators")
indicator.initialize()
indicator.setValue("name", "SLA Compliance Rate")
indicator.setValue("description", "Percentage of incidents meeting SLA")

indicator.setValue("facts_table", "task_sla")
indicator.setValue("conditions", "task.sys_class_name=incident")

// Formula-based percentage
indicator.setValue("aggregate", "FORMULA")
indicator.setValue("formula", "(COUNT(has_breached=false) / COUNT(*)) * 100")

indicator.setValue("unit", "%")
indicator.setValue("direction", 1) // Higher is better
indicator.setValue("precision", 1)

indicator.insert()
```

## Breakdowns

### Common Breakdowns

| Breakdown | Field            | Use Case              |
| --------- | ---------------- | --------------------- |
| Priority  | priority         | Incidents by P1/P2/P3 |
| Category  | category         | Incidents by type     |
| Group     | assignment_group | Team performance      |
| Location  | location         | Geographic analysis   |
| Time      | opened_at        | Trend analysis        |

### Creating Breakdown (ES5)

```javascript
// Create "Priority" breakdown
var breakdown = new GlideRecord("pa_breakdowns")
breakdown.initialize()
breakdown.setValue("name", "Priority")
breakdown.setValue("description", "Breakdown by incident priority")

breakdown.setValue("facts_table", "incident")
breakdown.setValue("dimension_field", "priority")

// Sorting
breakdown.setValue("sort_field", "priority")
breakdown.setValue("sort_order", "ASC")

// Element mapping (optional)
breakdown.setValue("use_element_mapping", true)

breakdown.insert()
```

### Linking Breakdown to Indicator (ES5)

```javascript
// Link breakdown to indicator
var link = new GlideRecord("pa_indicator_breakdowns")
link.initialize()
link.setValue("indicator", indicatorSysId)
link.setValue("breakdown", breakdownSysId)
link.setValue("active", true)
link.insert()
```

## Thresholds

### Creating Thresholds (ES5)

```javascript
// Create threshold for Open Incidents
var threshold = new GlideRecord("pa_thresholds")
threshold.initialize()
threshold.setValue("indicator", indicatorSysId)
threshold.setValue("name", "Critical Level")

// Threshold conditions
threshold.setValue("operator", ">=") // >=, <=, =, >, <
threshold.setValue("value", 100)

// Visual styling
threshold.setValue("color", "red")
threshold.setValue("icon", "exclamation-circle")

// Notification
threshold.setValue("notification_user", adminSysId)
threshold.setValue("notification_script", thresholdScript)

threshold.insert()

// Add warning threshold
var warning = new GlideRecord("pa_thresholds")
warning.initialize()
warning.setValue("indicator", indicatorSysId)
warning.setValue("name", "Warning Level")
warning.setValue("operator", ">=")
warning.setValue("value", 50)
warning.setValue("color", "orange")
warning.insert()
```

## Widgets

### Widget Types

| Type             | Use Case            | Shows                |
| ---------------- | ------------------- | -------------------- |
| **Single Score** | Current value       | "127 Open Incidents" |
| **Scorecard**    | Value + trend       | Current + sparkline  |
| **Time Series**  | Trend over time     | Line/bar chart       |
| **Breakdown**    | By dimension        | Pie/bar chart        |
| **Comparison**   | Multiple indicators | Side-by-side         |

### Creating Widget (ES5)

```javascript
// Create scorecard widget
var widget = new GlideRecord("pa_widgets")
widget.initialize()
widget.setValue("name", "Open Incidents Scorecard")
widget.setValue("type", "scorecard")

// Indicator
widget.setValue("indicator", indicatorSysId)

// Time range
widget.setValue("time_range", "last_30_days")
widget.setValue("show_trend", true)
widget.setValue("compare_to", "previous_period")

// Display
widget.setValue("show_breakdown", true)
widget.setValue("breakdown", priorityBreakdownSysId)
widget.setValue("chart_type", "bar")

widget.insert()
```

## Dashboards

### Creating Dashboard (ES5)

```javascript
// Create PA Dashboard
var dashboard = new GlideRecord("pa_dashboards")
dashboard.initialize()
dashboard.setValue("name", "Incident Management Dashboard")
dashboard.setValue("description", "Key metrics for incident management")

// Layout
dashboard.setValue("layout", "2-column")

// Access control
dashboard.setValue("public", true)
dashboard.setValue("owner", gs.getUserID())

var dashboardSysId = dashboard.insert()

// Add widgets to dashboard
function addWidgetToDashboard(dashboardId, widgetId, row, column) {
  var placement = new GlideRecord("pa_dashboard_widgets")
  placement.initialize()
  placement.setValue("dashboard", dashboardId)
  placement.setValue("widget", widgetId)
  placement.setValue("row", row)
  placement.setValue("column", column)
  placement.insert()
}

addWidgetToDashboard(dashboardSysId, openIncWidget, 0, 0)
addWidgetToDashboard(dashboardSysId, avgTimeWidget, 0, 1)
addWidgetToDashboard(dashboardSysId, slaWidget, 1, 0)
```

## Data Collection

### Manual Score Collection (ES5)

```javascript
// Collect scores for an indicator
var job = new PAScoreCollector()
job.collectIndicatorScores(indicatorSysId)
```

### Scheduled Collection

```javascript
// PA uses scheduled jobs for data collection
// Default: Daily at midnight
// Configure via: Performance Analytics > Data Collection > Jobs
```

## MCP Tool Integration

### Available PA Tools

| Tool                          | Purpose            |
| ----------------------------- | ------------------ |
| `snow_create_pa_indicator`    | Create indicator   |
| `snow_create_pa_breakdown`    | Create breakdown   |
| `snow_create_pa_threshold`    | Create threshold   |
| `snow_create_pa_widget`       | Create widget      |
| `snow_get_pa_scores`          | Retrieve scores    |
| `snow_collect_pa_data`        | Trigger collection |
| `snow_discover_pa_indicators` | Find indicators    |

### Example Workflow

```javascript
// 1. Create indicator
var indicatorId = await snow_create_pa_indicator({
  name: "Open P1 Incidents",
  table: "incident",
  conditions: "active=true^priority=1",
  aggregate: "COUNT",
  direction: "down_is_good",
})

// 2. Create breakdown
var breakdownId = await snow_create_pa_breakdown({
  name: "By Assignment Group",
  table: "incident",
  field: "assignment_group",
})

// 3. Link breakdown
await snow_create_pa_indicator_breakdown({
  indicator: indicatorId,
  breakdown: breakdownId,
})

// 4. Create threshold
await snow_create_pa_threshold({
  indicator: indicatorId,
  operator: ">=",
  value: 10,
  color: "red",
})

// 5. Create widget
await snow_create_pa_widget({
  name: "P1 Incidents Scorecard",
  type: "scorecard",
  indicator: indicatorId,
  breakdown: breakdownId,
})

// 6. Get current scores
var scores = await snow_get_pa_scores({
  indicator: indicatorId,
  time_range: "last_30_days",
})
```

## Best Practices

1. **Direction Matters** - Set correctly (up/down is good)
2. **Meaningful Thresholds** - Based on business requirements
3. **Consistent Frequency** - Match data volatility
4. **Use Breakdowns** - Enable drill-down analysis
5. **Dashboard Purpose** - One focus per dashboard
6. **Trend Analysis** - Always show comparison
7. **Performance** - Limit active indicators
8. **Documentation** - Clear indicator descriptions
