/**
 * snow_optimize_licenses - Analyze license usage and provide optimization recommendations
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_optimize_licenses",
  description: "Analyze license usage and provide optimization recommendations",
  // Metadata for tool discovery (not sent to LLM)
  category: "asset-management",
  subcategory: "license-management",
  use_cases: ["optimization", "cost-reduction", "sam"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Optimization function - modifies license allocations
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      software_name: { type: "string", description: "Specific software to analyze (optional)" },
      optimization_type: {
        type: "string",
        description: "Type of optimization",
        enum: ["cost_reduction", "compliance", "usage_efficiency"],
      },
      threshold_percentage: { type: "number", description: "Usage threshold for optimization (default 80)" },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { software_name, optimization_type = "cost_reduction", threshold_percentage = 80 } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Get license data
    let query = software_name ? `display_nameCONTAINS${software_name}` : ""
    const licenses = await client.get(`/api/now/table/alm_license?sysparm_query=${query}`)
    const licenseData = licenses.data.result

    if (licenseData.length === 0) {
      return createErrorResult("No licenses found for analysis")
    }

    // Analyze each license
    const optimizations = await Promise.all(
      licenseData.map(async (license: any) => {
        // Get actual usage data
        const usageQuery = `license=${license.sys_id}`
        const usage = await client.get(`/api/now/table/alm_license_usage?sysparm_query=${usageQuery}`)
        const usedLicenses = usage.data.result.length
        const totalLicenses = parseInt(license.license_count) || 0
        const usagePercentage = totalLicenses > 0 ? (usedLicenses / totalLicenses) * 100 : 0

        // Calculate potential savings
        const cost = parseFloat(license.cost) || 0
        let potentialSavings = 0
        let recommendation = ""

        if (usagePercentage < 50) {
          potentialSavings = cost * totalLicenses * 0.5 // Could reduce by 50%
          recommendation = "Consider reducing licenses by 50%"
        } else if (usagePercentage < threshold_percentage) {
          const excessLicenses = totalLicenses - Math.ceil(usedLicenses * 1.2) // Keep 20% buffer
          potentialSavings = cost * excessLicenses
          recommendation = `Consider reducing by ${excessLicenses} licenses`
        } else if (usagePercentage > 95) {
          recommendation = "Consider increasing licenses to avoid compliance issues"
        } else {
          recommendation = "Optimal usage - no changes recommended"
        }

        return {
          license_name: license.display_name,
          publisher: license.publisher,
          total_licenses: totalLicenses,
          used_licenses: usedLicenses,
          usage_percentage: usagePercentage.toFixed(1),
          potential_savings: potentialSavings.toFixed(2),
          recommendation,
        }
      }),
    )

    // Filter optimizations with savings potential
    const savingsOpportunities = optimizations.filter((opt) => parseFloat(opt.potential_savings) > 0)
    const totalSavings = savingsOpportunities.reduce((sum, opt) => sum + parseFloat(opt.potential_savings), 0)

    return createSuccessResult({
      optimization_type,
      threshold_percentage,
      total_licenses_analyzed: licenseData.length,
      optimization_opportunities: savingsOpportunities.length,
      potential_annual_savings: totalSavings.toFixed(2),
      optimizations: savingsOpportunities.slice(0, 10), // Top 10 opportunities
      recommendations: generateRecommendations(optimization_type, savingsOpportunities),
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function generateRecommendations(optimizationType: string, optimizations: any[]): string[] {
  const recommendations = []

  if (optimizationType === "cost_reduction") {
    recommendations.push("Implement license harvesting for unused installations")
    recommendations.push("Negotiate better terms with publishers based on actual usage")
    recommendations.push("Consider switching to concurrent licensing for lower cost")
  } else if (optimizationType === "compliance") {
    recommendations.push("Monitor high-usage licenses to avoid compliance violations")
    recommendations.push("Implement automated license reclamation processes")
    recommendations.push("Regular compliance audits recommended")
  } else {
    recommendations.push("Implement usage monitoring dashboards")
    recommendations.push("Set up alerts for license threshold breaches")
    recommendations.push("Review license types for better efficiency")
  }

  return recommendations
}

export const version = "1.0.0"
