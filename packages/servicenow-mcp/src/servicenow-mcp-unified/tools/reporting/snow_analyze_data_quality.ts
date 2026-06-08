/**
 * snow_analyze_data_quality - Analyze data quality including completeness, consistency, and accuracy
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_analyze_data_quality",
  description: "Analyze data quality including completeness, consistency, and accuracy metrics",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "data-quality",
  use_cases: ["data-quality", "analysis", "metrics"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Analysis operation - reads data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", description: "Table to analyze" },
      fields: { type: "array", description: "Specific fields to analyze", items: { type: "string" } },
      check_completeness: { type: "boolean", description: "Check data completeness" },
      check_consistency: { type: "boolean", description: "Check data consistency" },
      check_accuracy: { type: "boolean", description: "Check data accuracy" },
    },
    required: ["table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table, fields, check_completeness = true, check_consistency = true, check_accuracy = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Get sample data for analysis
    const sampleSize = 1000
    const response = await client.get(`/api/now/table/${table}?sysparm_limit=${sampleSize}`)
    const data = response.data.result

    if (data.length === 0) {
      return createErrorResult("No data found in table")
    }

    // Analyze data quality
    const analysis: any = {
      table,
      total_records: data.length,
      completeness: check_completeness ? analyzeCompleteness(data, fields) : null,
      consistency: check_consistency ? analyzeConsistency(data, fields) : null,
      accuracy: check_accuracy ? analyzeAccuracy(data, fields) : null,
      issues: [] as string[],
    }

    // Calculate overall quality score
    let scores = []
    if (analysis.completeness) scores.push(analysis.completeness.score)
    if (analysis.consistency) scores.push(analysis.consistency.score)
    if (analysis.accuracy) scores.push(analysis.accuracy.score)

    const qualityScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0

    return createSuccessResult({
      ...analysis,
      overall_quality_score: qualityScore.toFixed(1),
      sample_size: data.length,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function analyzeCompleteness(data: any[], fields?: string[]): any {
  const fieldsToCheck = fields || Object.keys(data[0] || {})
  const total = fieldsToCheck.length
  let complete = 0

  fieldsToCheck.forEach((field) => {
    const filledCount = data.filter((record) => record[field] && record[field] !== "").length
    if (filledCount / data.length > 0.8) complete++
  })

  return {
    score: (complete / total) * 100,
    complete_fields: complete,
    total_fields: total,
  }
}

function analyzeConsistency(data: any[], fields?: string[]): any {
  const fieldsToCheck = fields || Object.keys(data[0] || {})
  const total = fieldsToCheck.length
  let consistent = 0

  fieldsToCheck.forEach((field) => {
    const values = data.map((record) => record[field]).filter((v) => v)
    const uniqueValues = new Set(values)
    // Check if field has reasonable cardinality
    if (uniqueValues.size < values.length * 0.5) consistent++
  })

  return {
    score: (consistent / total) * 100,
    consistent_fields: consistent,
    total_fields: total,
  }
}

function analyzeAccuracy(data: any[], fields?: string[]): any {
  const fieldsToCheck = fields || Object.keys(data[0] || {})
  const total = fieldsToCheck.length
  let accurate = 0

  fieldsToCheck.forEach((field) => {
    const values = data.map((record) => record[field]).filter((v) => v !== null && v !== undefined && v !== "")

    if (values.length === 0) return

    let fieldAccurate = true

    // Perform field-specific validation
    if (field.includes("email")) {
      const validEmails = values.filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email)))
      fieldAccurate = validEmails.length / values.length > 0.8
    } else if (field.includes("phone")) {
      const validPhones = values.filter((phone) => /^[\d\s\+\-\(\)]+$/.test(String(phone)))
      fieldAccurate = validPhones.length / values.length > 0.8
    } else if (field.includes("date")) {
      const validDates = values.filter((date) => !isNaN(Date.parse(String(date))))
      fieldAccurate = validDates.length / values.length > 0.9
    }

    if (fieldAccurate) accurate++
  })

  return {
    score: total > 0 ? (accurate / total) * 100 : 0,
    accurate_fields: accurate,
    total_fields: total,
  }
}

export const version = "1.0.0"
