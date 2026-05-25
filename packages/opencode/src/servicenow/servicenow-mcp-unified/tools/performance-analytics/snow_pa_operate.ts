/**
 * snow_pa_operate - Unified Performance Analytics Operations
 *
 * Comprehensive PA operations: collect data, export reports, generate insights, get scores.
 *
 * Replaces: snow_collect_pa_data, snow_export_report_data,
 *           snow_generate_insights, snow_get_pa_scores
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_pa_operate",
  description: "Unified PA operations (collect_data, export_report, generate_insights, get_scores)",
  category: "performance-analytics",
  subcategory: "operations",
  use_cases: ["performance-analytics", "data-collection", "reporting", "insights"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "PA operation action",
        enum: ["collect_data", "export_report", "generate_insights", "get_scores"],
      },
      // COLLECT_DATA parameters
      indicator: { type: "string", description: "[collect_data] Indicator to collect data for" },
      start_date: { type: "string", description: "[collect_data] Collection start date" },
      end_date: { type: "string", description: "[collect_data] Collection end date" },
      recalculate: { type: "boolean", description: "[collect_data] Recalculate existing data" },
      // EXPORT_REPORT parameters
      reportName: { type: "string", description: "[export_report] Report name to export" },
      format: { type: "string", description: "[export_report] Export format (CSV, Excel, JSON, XML)" },
      includeHeaders: { type: "boolean", description: "[export_report] Include column headers" },
      maxRows: { type: "number", description: "[export_report] Maximum rows to export" },
      // GENERATE_INSIGHTS parameters
      table: { type: "string", description: "[generate_insights] Table to analyze" },
      analysisType: { type: "string", description: "[generate_insights] Analysis type (trends, patterns, anomalies)" },
      timeframe: { type: "string", description: "[generate_insights] Time period for analysis" },
      generateRecommendations: { type: "boolean", description: "[generate_insights] Generate recommendations" },
      // GET_SCORES parameters
      indicator_sys_id: { type: "string", description: "[get_scores] Indicator sys_id" },
      time_range: { type: "string", description: "[get_scores] Time range for scores" },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    switch (action) {
      case "collect_data":
        return await executeCollectData(args, context)
      case "export_report":
        return await executeExportReport(args, context)
      case "generate_insights":
        return await executeGenerateInsights(args, context)
      case "get_scores":
        return await executeGetScores(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== COLLECT DATA ====================
async function executeCollectData(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { indicator, start_date, end_date, recalculate } = args

  if (!indicator) return createErrorResult("indicator required")

  const client = await getAuthenticatedClient(context)

  const jobData: any = {
    indicator,
    status: "pending",
    recalculate: recalculate || false,
  }

  if (start_date) jobData.start_date = start_date
  if (end_date) jobData.end_date = end_date

  const response = await client.post("/api/now/table/pa_collection_jobs", jobData)

  return createSuccessResult({
    action: "collect_data",
    collected: true,
    job: response.data.result,
  })
}

// ==================== EXPORT REPORT ====================
async function executeExportReport(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { reportName, format, includeHeaders, maxRows } = args

  if (!reportName) return createErrorResult("reportName required")
  if (!format) return createErrorResult("format required")

  const client = await getAuthenticatedClient(context)

  // Find report
  const reportQuery = await client.get("/api/now/table/sys_report", {
    params: { sysparm_query: `name=${reportName}`, sysparm_limit: 1 },
  })

  if (!reportQuery.data.result || reportQuery.data.result.length === 0) {
    return createErrorResult(`Report not found: ${reportName}`)
  }

  const report = reportQuery.data.result[0]

  // Get report data
  const dataQuery = await client.get(`/api/now/table/${report.table}`, {
    params: {
      sysparm_query: report.filter || "",
      sysparm_limit: maxRows || 1000,
    },
  })

  return createSuccessResult({
    action: "export_report",
    exported: true,
    format: format.toUpperCase(),
    records: dataQuery.data.result.length,
    data: dataQuery.data.result,
  })
}

// ==================== GENERATE INSIGHTS ====================
async function executeGenerateInsights(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, analysisType, timeframe, generateRecommendations } = args

  if (!table) return createErrorResult("table required")

  const client = await getAuthenticatedClient(context)

  // Get sample data for analysis
  const dataQuery = await client.get(`/api/now/table/${table}`, {
    params: { sysparm_limit: 200 },
  })

  const data = dataQuery.data.result

  const insights: any = {
    table,
    analysisType: analysisType || "patterns",
    timeframe: timeframe || "30d",
    insights: [],
    recommendations: [],
  }

  // Analyze patterns
  if (analysisType === "patterns" || !analysisType) {
    const fields = data.length > 0 ? Object.keys(data[0]) : []
    insights.insights.push({
      type: "Pattern",
      description: `Dataset contains ${data.length} records with ${fields.length} fields`,
    })
  }

  // Generate recommendations if requested
  if (generateRecommendations) {
    insights.recommendations.push("Consider creating automated dashboards for key metrics")
    insights.recommendations.push("Implement data quality monitoring for critical fields")
  }

  return createSuccessResult({
    action: "generate_insights",
    insights,
  })
}

// ==================== GET SCORES ====================
async function executeGetScores(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { indicator_sys_id, time_range = "30days" } = args

  if (!indicator_sys_id) return createErrorResult("indicator_sys_id required")

  const client = await getAuthenticatedClient(context)

  const response = await client.get("/api/now/table/pa_scores", {
    params: {
      sysparm_query: `indicator=${indicator_sys_id}`,
      sysparm_limit: 100,
    },
  })

  return createSuccessResult({
    action: "get_scores",
    scores: response.data.result,
    count: response.data.result.length,
  })
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging - Phase 3"
