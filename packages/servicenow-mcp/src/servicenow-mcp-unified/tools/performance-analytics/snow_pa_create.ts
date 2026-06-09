/**
 * snow_pa_create - Unified Performance Analytics Creation
 *
 * Comprehensive PA creation operations: indicators, breakdowns, thresholds,
 * widgets, visualizations, scheduled reports.
 *
 * Replaces: snow_create_kpi, snow_create_pa_indicator, snow_create_pa_breakdown,
 *           snow_create_pa_threshold, snow_create_pa_widget, snow_create_data_visualization,
 *           snow_create_scheduled_report
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_pa_create",
  description: "Unified PA creation (indicator, breakdown, threshold, widget, visualization, scheduled_report)",
  category: "performance-analytics",
  subcategory: "creation",
  use_cases: ["performance-analytics", "kpi", "dashboards", "reporting"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create/update/delete operation
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "PA creation action",
        enum: ["indicator", "breakdown", "threshold", "widget", "visualization", "scheduled_report"],
      },
      // INDICATOR parameters
      name: { type: "string", description: "[indicator/breakdown/widget/visualization/scheduled_report] Name" },
      description: { type: "string", description: "[indicator] Description" },
      table: { type: "string", description: "[indicator/breakdown] Source table" },
      field: { type: "string", description: "[indicator/breakdown] Field name" },
      aggregate: { type: "string", description: "[indicator] Aggregation (COUNT, SUM, AVG, MIN, MAX)" },
      metric: { type: "string", description: "[indicator] Metric to measure" },
      aggregation: { type: "string", description: "[indicator] Aggregation function" },
      conditions: { type: "string", description: "[indicator/scheduled_report] Conditions/filters" },
      target: { type: "number", description: "[indicator] Target value" },
      threshold: { type: "object", description: "[indicator] Threshold config" },
      unit: { type: "string", description: "[indicator] Unit of measurement" },
      frequency: { type: "string", description: "[indicator] Update frequency" },
      // BREAKDOWN parameters
      related_field: { type: "string", description: "[breakdown] Related field path" },
      matrix_source: { type: "boolean", description: "[breakdown] Is matrix breakdown" },
      // THRESHOLD parameters
      indicator: { type: "string", description: "[threshold/widget] Indicator sys_id" },
      type: { type: "string", description: "[threshold/widget/visualization] Type" },
      operator: { type: "string", description: "[threshold] Operator (>, <, >=, <=, =)" },
      value: { type: "number", description: "[threshold] Threshold value" },
      duration: { type: "number", description: "[threshold] Duration before alert" },
      notification_group: { type: "string", description: "[threshold] Group to notify" },
      // WIDGET parameters
      breakdown: { type: "string", description: "[widget] Breakdown field" },
      time_range: { type: "string", description: "[widget] Time range (7days, 30days, etc.)" },
      dashboard: { type: "string", description: "[widget] Dashboard sys_id" },
      size_x: { type: "number", description: "[widget] Widget width" },
      size_y: { type: "number", description: "[widget] Widget height" },
      // VISUALIZATION parameters
      dataSource: { type: "string", description: "[visualization] Data source table/report" },
      xAxis: { type: "string", description: "[visualization] X-axis field" },
      yAxis: { type: "string", description: "[visualization] Y-axis field" },
      series: { type: "array", items: { type: "string" }, description: "[visualization] Data series config" },
      filters: { type: "array", items: { type: "string" }, description: "[visualization] Chart filters" },
      colors: { type: "array", items: { type: "string" }, description: "[visualization] Color palette" },
      interactive: { type: "boolean", description: "[visualization] Interactive chart" },
      // SCHEDULED_REPORT parameters
      reportName: { type: "string", description: "[scheduled_report] Source report name" },
      schedule: { type: "string", description: "[scheduled_report] Schedule frequency" },
      recipients: { type: "array", items: { type: "string" }, description: "[scheduled_report] Email recipients" },
      format: { type: "string", description: "[scheduled_report] Report format (PDF, Excel, CSV)" },
      subject: { type: "string", description: "[scheduled_report] Email subject" },
      message: { type: "string", description: "[scheduled_report] Email message" },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    switch (action) {
      case "indicator":
        return await executeIndicator(args, context)
      case "breakdown":
        return await executeBreakdown(args, context)
      case "threshold":
        return await executeThreshold(args, context)
      case "widget":
        return await executeWidget(args, context)
      case "visualization":
        return await executeVisualization(args, context)
      case "scheduled_report":
        return await executeScheduledReport(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== INDICATOR ====================
async function executeIndicator(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    description,
    table,
    field,
    metric,
    aggregate,
    aggregation,
    conditions,
    target,
    threshold,
    unit,
    frequency,
  } = args

  if (!name) return createErrorResult("name required")
  if (!table) return createErrorResult("table required")

  const client = await getAuthenticatedClient(context)

  // Support both simplified (field/aggregate) and complex (metric/aggregation) parameters
  const indicatorField = field || metric
  const indicatorAggregate = aggregate || aggregation

  if (!indicatorField) return createErrorResult("field or metric required")
  if (!indicatorAggregate) return createErrorResult("aggregate or aggregation required")

  const indicatorData: any = {
    name,
    label: name,
    description: description || "",
    facts_table: table,
    aggregate: indicatorAggregate.toUpperCase(),
    field: indicatorField,
    unit: unit || "",
    frequency: frequency || "daily",
    active: true,
  }

  if (conditions) indicatorData.conditions = conditions
  if (target) indicatorData.target = target
  if (threshold) indicatorData.threshold = JSON.stringify(threshold)

  const response = await client.post("/api/now/table/pa_indicators", indicatorData)

  return createSuccessResult({
    action: "indicator",
    created: true,
    indicator: response.data.result,
    sys_id: response.data.result.sys_id,
  })
}

// ==================== BREAKDOWN ====================
async function executeBreakdown(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, table, field, related_field, matrix_source } = args

  if (!name) return createErrorResult("name required")
  if (!table) return createErrorResult("table required")
  if (!field) return createErrorResult("field required")

  const client = await getAuthenticatedClient(context)

  const breakdownData: any = {
    name,
    table,
    field,
    matrix_source: matrix_source || false,
  }

  if (related_field) breakdownData.related_field = related_field

  const response = await client.post("/api/now/table/pa_breakdowns", breakdownData)

  return createSuccessResult({
    action: "breakdown",
    created: true,
    breakdown: response.data.result,
    sys_id: response.data.result.sys_id,
  })
}

// ==================== THRESHOLD ====================
async function executeThreshold(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { indicator, type, operator, value, duration, notification_group } = args

  if (!indicator) return createErrorResult("indicator required")
  if (!type) return createErrorResult("type required")
  if (!operator) return createErrorResult("operator required")
  if (value === undefined) return createErrorResult("value required")

  const client = await getAuthenticatedClient(context)

  const thresholdData: any = {
    indicator,
    type,
    operator,
    value,
    duration: duration || 1,
  }

  if (notification_group) thresholdData.notification_group = notification_group

  const response = await client.post("/api/now/table/pa_thresholds", thresholdData)

  return createSuccessResult({
    action: "threshold",
    created: true,
    threshold: response.data.result,
    sys_id: response.data.result.sys_id,
  })
}

// ==================== WIDGET ====================
async function executeWidget(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, type, indicator, breakdown, time_range, dashboard, size_x, size_y } = args

  if (!name) return createErrorResult("name required")
  if (!type) return createErrorResult("type required")
  if (!indicator) return createErrorResult("indicator required")

  const client = await getAuthenticatedClient(context)

  const widgetData: any = {
    name,
    type,
    indicator,
    time_range: time_range || "30days",
    size_x: size_x || 4,
    size_y: size_y || 3,
  }

  if (breakdown) widgetData.breakdown = breakdown
  if (dashboard) widgetData.dashboard = dashboard

  const response = await client.post("/api/now/table/pa_widgets", widgetData)

  return createSuccessResult({
    action: "widget",
    created: true,
    widget: response.data.result,
    sys_id: response.data.result.sys_id,
  })
}

// ==================== VISUALIZATION ====================
async function executeVisualization(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, type, dataSource, xAxis, yAxis, series, filters, colors, interactive } = args

  if (!name) return createErrorResult("name required")
  if (!type) return createErrorResult("type required")
  if (!dataSource) return createErrorResult("dataSource required")

  const client = await getAuthenticatedClient(context)

  const vizData: any = {
    name,
    title: name,
    type,
    table: dataSource,
    chart_type: type,
    is_real_time: interactive !== false,
    active: true,
  }

  if (xAxis) vizData.x_axis_field = xAxis
  if (yAxis) vizData.y_axis_field = yAxis
  if (series) vizData.series_config = JSON.stringify(series)
  if (filters) vizData.filter = JSON.stringify(filters)
  if (colors) vizData.color_palette = JSON.stringify(colors)

  const response = await client.post("/api/now/table/sys_report_chart", vizData)

  return createSuccessResult({
    action: "visualization",
    created: true,
    visualization: response.data.result,
    sys_id: response.data.result.sys_id,
  })
}

// ==================== SCHEDULED REPORT ====================
async function executeScheduledReport(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { reportName, schedule, recipients, format, conditions, subject, message } = args

  if (!reportName) return createErrorResult("reportName required")
  if (!schedule) return createErrorResult("schedule required")
  if (!recipients || recipients.length === 0) return createErrorResult("recipients required")

  const client = await getAuthenticatedClient(context)

  // Find source report
  const reportQuery = await client.get("/api/now/table/sys_report", {
    params: { sysparm_query: `name=${reportName}`, sysparm_limit: 1 },
  })

  if (!reportQuery.data.result || reportQuery.data.result.length === 0) {
    return createErrorResult(`Report not found: ${reportName}`)
  }

  const reportId = reportQuery.data.result[0].sys_id

  const scheduledData: any = {
    name: `Scheduled: ${reportName}`,
    report: reportId,
    run_time: schedule,
    email_to: recipients.join(","),
    format: (format || "pdf").toLowerCase(),
    subject: subject || `Scheduled Report: ${reportName}`,
    body: message || "Please find the attached report.",
    active: true,
  }

  if (conditions) scheduledData.condition = conditions

  const response = await client.post("/api/now/table/sysauto_report", scheduledData)

  return createSuccessResult({
    action: "scheduled_report",
    created: true,
    scheduled_report: response.data.result,
    sys_id: response.data.result.sys_id,
  })
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging - Phase 2"
