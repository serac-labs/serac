/**
 * snow_asset_compliance_report - Generate comprehensive asset compliance reports for auditing
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_asset_compliance_report",
  description: "Generate comprehensive asset compliance reports for auditing",
  // Metadata for tool discovery (not sent to LLM)
  category: "asset-management",
  subcategory: "reporting",
  use_cases: ["compliance", "reporting", "auditing"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      report_type: {
        type: "string",
        description: "Type of compliance report",
        enum: ["license_usage", "asset_inventory", "warranty_expiration", "cost_analysis"],
      },
      date_range: {
        type: "string",
        description: "Report date range",
        enum: ["30_days", "90_days", "1_year", "all_time"],
      },
      include_details: { type: "boolean", description: "Include detailed breakdown" },
      export_format: {
        type: "string",
        description: "Export format",
        enum: ["json", "csv", "pdf"],
      },
    },
    required: ["report_type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { report_type, date_range = "90_days", include_details = false, export_format = "json" } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Date range calculation
    const dateRangeMap: Record<string, number | null> = {
      "30_days": 30,
      "90_days": 90,
      "1_year": 365,
      all_time: null,
    }

    const days = dateRangeMap[date_range]
    let query = ""
    if (days) {
      const startDate = new Date()
      startDate.setDate(startDate.getDate() - days)
      query = `sys_created_on>=${startDate.toISOString()}`
    }

    let reportData
    let summary = ""

    switch (report_type) {
      case "license_usage":
        reportData = await client.get(`/api/now/table/alm_license?sysparm_query=${query}`)
        summary = generateLicenseUsageReport(reportData.data.result, include_details)
        break

      case "asset_inventory":
        reportData = await client.get(`/api/now/table/alm_asset?sysparm_query=${query}`)
        summary = generateAssetInventoryReport(reportData.data.result, include_details)
        break

      case "warranty_expiration":
        const warrantyQuery = `warranty_expiration>=javascript:gs.daysAgoStart(0)^warranty_expiration<=javascript:gs.daysAgoStart(-90)${query ? "^" + query : ""}`
        reportData = await client.get(`/api/now/table/alm_asset?sysparm_query=${warrantyQuery}`)
        summary = generateWarrantyReport(reportData.data.result, include_details)
        break

      case "cost_analysis":
        reportData = await client.get(`/api/now/table/alm_asset?sysparm_query=${query}`)
        summary = generateCostAnalysisReport(reportData.data.result, include_details)
        break

      default:
        return createErrorResult(`Unknown report type: ${report_type}`)
    }

    return createSuccessResult({
      report_type,
      date_range,
      summary,
      export_format,
      generated_at: new Date().toISOString(),
      record_count: reportData.data.result.length,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function generateLicenseUsageReport(licenses: any[], includeDetails: boolean): string {
  const totalLicenses = licenses.length
  const totalCost = licenses.reduce((sum, lic) => sum + (parseFloat(lic.cost) || 0), 0)

  let report = `Total Licenses: ${totalLicenses}\n`
  report += `Total Annual Cost: $${totalCost.toLocaleString()}\n`

  if (includeDetails && licenses.length > 0) {
    report += "\nLicense Details:\n"
    licenses.slice(0, 10).forEach((lic) => {
      report += `- ${lic.display_name}: ${lic.license_count} licenses\n`
    })
  }

  return report
}

function generateAssetInventoryReport(assets: any[], includeDetails: boolean): string {
  const totalAssets = assets.length
  const byState = assets.reduce(
    (acc, asset) => {
      acc[asset.state || "unknown"] = (acc[asset.state || "unknown"] || 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )

  let report = `Total Assets: ${totalAssets}\n`
  report += "Assets by State:\n"
  Object.entries(byState).forEach(([state, count]) => {
    report += `- ${state}: ${count}\n`
  })

  return report
}

function generateWarrantyReport(assets: any[], includeDetails: boolean): string {
  return (
    `Assets with expiring warranties: ${assets.length}\n` +
    "Recommend planning for replacements or warranty extensions."
  )
}

function generateCostAnalysisReport(assets: any[], includeDetails: boolean): string {
  const totalValue = assets.reduce((sum, asset) => sum + (parseFloat(asset.cost) || 0), 0)
  const avgCost = assets.length > 0 ? totalValue / assets.length : 0

  return (
    `Total Portfolio Value: $${totalValue.toLocaleString()}\n` +
    `Average Asset Cost: $${avgCost.toLocaleString()}\n` +
    `Assets Analyzed: ${assets.length}`
  )
}

export const version = "1.0.0"
