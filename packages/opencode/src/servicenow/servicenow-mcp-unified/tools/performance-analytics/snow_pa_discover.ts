/**
 * snow_pa_discover - Unified Performance Analytics Discovery
 *
 * Comprehensive PA discovery operations: indicators, report fields, reporting tables.
 *
 * Replaces: snow_discover_pa_indicators, snow_discover_report_fields,
 *           snow_discover_reporting_tables
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_pa_discover",
  description: "Unified PA discovery (indicators, report_fields, reporting_tables)",
  category: "performance-analytics",
  subcategory: "discovery",
  use_cases: ["performance-analytics", "discovery", "reporting"],
  complexity: "beginner",
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
        description: "PA discovery action",
        enum: ["indicators", "report_fields", "reporting_tables"],
      },
      // INDICATORS parameters
      table: { type: "string", description: "[indicators/report_fields] Table filter" },
      active_only: { type: "boolean", description: "[indicators] Show only active indicators" },
      // REPORT_FIELDS parameters
      fieldType: { type: "string", description: "[report_fields] Filter by field type" },
      // REPORTING_TABLES parameters
      category: { type: "string", description: "[reporting_tables] Table category filter" },
      hasData: { type: "boolean", description: "[reporting_tables] Only tables with data" },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    switch (action) {
      case "indicators":
        return await executeIndicators(args, context)
      case "report_fields":
        return await executeReportFields(args, context)
      case "reporting_tables":
        return await executeReportingTables(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== INDICATORS ====================
async function executeIndicators(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, active_only } = args

  const client = await getAuthenticatedClient(context)

  let query = ""
  if (table) query = `facts_table=${table}`
  if (active_only !== false) {
    query += query ? "^" : ""
    query += "active=true"
  }

  const response = await client.get("/api/now/table/pa_indicators", {
    params: {
      sysparm_query: query || "",
      sysparm_limit: 50,
    },
  })

  return createSuccessResult({
    action: "indicators",
    indicators: response.data.result,
    count: response.data.result.length,
  })
}

// ==================== REPORT FIELDS ====================
async function executeReportFields(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, fieldType } = args

  if (!table) {
    return createErrorResult("table is required for report_fields action")
  }

  const client = await getAuthenticatedClient(context)

  let query = `name=${table}^element!=NULL`
  if (fieldType) query += `^internal_type=${fieldType}`

  const response = await client.get("/api/now/table/sys_dictionary", {
    params: {
      sysparm_query: query,
      sysparm_limit: 100,
    },
  })

  return createSuccessResult({
    action: "report_fields",
    table,
    fields: response.data.result,
    count: response.data.result.length,
  })
}

// ==================== REPORTING TABLES ====================
async function executeReportingTables(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { category, hasData } = args

  const client = await getAuthenticatedClient(context)

  let query = ""
  if (category) query = `sys_class_name=${category}`

  const response = await client.get("/api/now/table/sys_db_object", {
    params: {
      sysparm_query: query || "",
      sysparm_limit: 100,
    },
  })

  // Note: hasData parameter is documented but not implemented in original tool
  // Could be added by checking row_count field if needed

  return createSuccessResult({
    action: "reporting_tables",
    tables: response.data.result,
    count: response.data.result.length,
  })
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging - Phase 2"
