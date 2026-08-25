/**
 * snow_security_risk_assessment - Security risk assessment
 *
 * Performs comprehensive security risk assessments analyzing access controls, vulnerabilities, and security posture.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_security_risk_assessment",
  description:
    "Perform comprehensive security risk assessment analyzing access controls, vulnerabilities, and security posture",
  // Metadata for tool discovery (not sent to LLM)
  category: "security",
  subcategory: "risk-assessment",
  use_cases: ["security", "risk", "assessment"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - creates a risk_assessment record and PATCHes it.
  // It was declared "read" on the strength of the word "assessment"; the five
  // guards that key on this field were all disarmed as a result.
  permission: "write",
  allowedRoles: ["developer", "admin"],
  // A risk_assessment row is a GRC operational record, not configuration —
  // ServiceNow does not capture it in an update set.
  updateSet: "exempt",
  inputSchema: {
    type: "object",
    properties: {
      assessment_type: {
        type: "string",
        description: "Type of security assessment",
        enum: ["access_control", "vulnerability", "configuration", "full"],
        default: "full",
      },
      target_scope: {
        type: "string",
        description: "Assessment scope",
        enum: ["instance", "application", "table", "user"],
        default: "instance",
      },
      target_id: { type: "string", description: "Target identifier (app sys_id, table name, or user sys_id)" },
      risk_threshold: {
        type: "string",
        description: "Minimum risk level to report",
        enum: ["critical", "high", "medium", "low"],
        default: "medium",
      },
    },
    required: ["assessment_type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { assessment_type, target_scope = "instance", target_id, risk_threshold = "medium" } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Create risk assessment record
    const assessmentData: any = {
      assessment_type,
      target_scope,
      risk_threshold,
      status: "in_progress",
      started_at: new Date().toISOString(),
    }

    if (target_id) assessmentData.target_id = target_id

    const assessmentResponse = await client.post("/api/now/table/risk_assessment", assessmentData)
    const assessmentSysId = assessmentResponse.data.result.sys_id

    // Perform assessment based on type
    let risks: any = {}

    switch (assessment_type) {
      case "access_control":
        risks = await assessAccessControlRisks(client, target_scope, target_id)
        break
      case "vulnerability":
        risks = await assessVulnerabilityRisks(client, target_scope, target_id)
        break
      case "configuration":
        risks = await assessConfigurationRisks(client, target_scope, target_id)
        break
      case "full":
        risks = {
          access_control: await assessAccessControlRisks(client, target_scope, target_id),
          vulnerabilities: await assessVulnerabilityRisks(client, target_scope, target_id),
          configuration: await assessConfigurationRisks(client, target_scope, target_id),
        }
        break
    }

    // Calculate overall risk score
    const riskScore = calculateRiskScore(risks, risk_threshold)

    // Update assessment record
    await client.patch(`/api/now/table/risk_assessment/${assessmentSysId}`, {
      status: "completed",
      completed_at: new Date().toISOString(),
      risk_score: riskScore.overall,
      findings: JSON.stringify(risks),
    })

    return createSuccessResult(
      {
        assessment_id: assessmentSysId,
        risk_score: riskScore,
        findings: risks,
        recommendations: generateRecommendations(risks, risk_threshold),
      },
      { assessment_type, target_scope },
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

async function assessAccessControlRisks(client: any, scope: string, targetId?: string): Promise<any> {
  const risks = {
    excessive_permissions: [] as any[],
    weak_acls: [] as any[],
    privileged_users: [] as any[],
  }

  try {
    // Check for excessive admin roles
    const adminResponse = await client.get("/api/now/table/sys_user_has_role", {
      params: {
        sysparm_query: "role.name=admin^ORrole.name=security_admin",
        sysparm_limit: 100,
      },
    })

    const adminUsers = adminResponse.data.result || []
    if (adminUsers.length > 10) {
      risks.excessive_permissions.push({
        severity: "high",
        issue: "Excessive admin users",
        count: adminUsers.length,
        recommendation: "Review and reduce admin role assignments",
      })
    }

    // Check ACL configurations
    const aclResponse = await client.get("/api/now/table/sys_security_acl", {
      params: {
        sysparm_query: "active=true",
        sysparm_limit: 50,
      },
    })

    const acls = aclResponse.data.result || []
    const weakAcls = acls.filter((acl: any) => !acl.script && !acl.condition)

    if (weakAcls.length > 0) {
      risks.weak_acls.push({
        severity: "medium",
        issue: "ACLs without conditions",
        count: weakAcls.length,
        recommendation: "Add conditions to ACL rules",
      })
    }
  } catch (error) {
    risks.excessive_permissions.push({
      severity: "warning",
      issue: "Unable to complete access control assessment",
      details: String(error),
    })
  }

  return risks
}

async function assessVulnerabilityRisks(client: any, scope: string, targetId?: string): Promise<any> {
  const risks = {
    known_vulnerabilities: [] as any[],
    outdated_components: [] as any[],
    security_patches: [] as any[],
  }

  try {
    // Check for known vulnerabilities
    const vulnResponse = await client.get("/api/now/table/sn_vul_vulnerable_item", {
      params: {
        sysparm_query: "state=open",
        sysparm_limit: 100,
      },
    })

    const vulnerabilities = vulnResponse.data.result || []
    const criticalVulns = vulnerabilities.filter((v: any) => v.severity === "1" || v.severity === "2")

    if (criticalVulns.length > 0) {
      risks.known_vulnerabilities.push({
        severity: "critical",
        issue: "Open critical vulnerabilities",
        count: criticalVulns.length,
        recommendation: "Prioritize remediation of critical vulnerabilities",
      })
    }
  } catch (error) {
    // Vulnerability table may not exist in all instances
    risks.known_vulnerabilities.push({
      severity: "info",
      issue: "Vulnerability assessment not available",
      details: "Vulnerability management plugin may not be active",
    })
  }

  return risks
}

async function assessConfigurationRisks(client: any, scope: string, targetId?: string): Promise<any> {
  const risks = {
    security_properties: [] as any[],
    encryption_status: [] as any[],
    authentication: [] as any[],
  }

  try {
    // Check security properties
    const securityProps = [
      "glide.ui.security.allow_codetag",
      "glide.script.block.escape.functions",
      "glide.ui.strict_customer_uploaded_static_content",
    ]

    for (const prop of securityProps) {
      const propResponse = await client.get("/api/now/table/sys_properties", {
        params: {
          sysparm_query: `name=${prop}`,
          sysparm_limit: 1,
        },
      })

      const property = propResponse.data.result?.[0]
      if (property && property.value !== "true") {
        risks.security_properties.push({
          severity: "medium",
          issue: `Insecure property: ${prop}`,
          current_value: property.value,
          recommendation: "Set to true for enhanced security",
        })
      }
    }
  } catch (error) {
    risks.security_properties.push({
      severity: "warning",
      issue: "Unable to assess security properties",
      details: String(error),
    })
  }

  return risks
}

function calculateRiskScore(risks: any, threshold: string): any {
  let criticalCount = 0
  let highCount = 0
  let mediumCount = 0
  let lowCount = 0

  const countRisks = (riskCategory: any) => {
    if (Array.isArray(riskCategory)) {
      riskCategory.forEach((risk: any) => {
        switch (risk.severity) {
          case "critical":
            criticalCount++
            break
          case "high":
            highCount++
            break
          case "medium":
            mediumCount++
            break
          case "low":
            lowCount++
            break
        }
      })
    } else if (typeof riskCategory === "object") {
      Object.values(riskCategory).forEach(countRisks)
    }
  }

  countRisks(risks)

  const overall = criticalCount * 10 + highCount * 5 + mediumCount * 2 + lowCount

  return {
    overall,
    by_severity: {
      critical: criticalCount,
      high: highCount,
      medium: mediumCount,
      low: lowCount,
    },
    risk_level: overall > 50 ? "critical" : overall > 20 ? "high" : overall > 10 ? "medium" : "low",
  }
}

function generateRecommendations(risks: any, threshold: string): string[] {
  const recommendations: string[] = []

  const extractRecommendations = (riskCategory: any) => {
    if (Array.isArray(riskCategory)) {
      riskCategory.forEach((risk: any) => {
        if (risk.recommendation) {
          recommendations.push(`[${risk.severity.toUpperCase()}] ${risk.recommendation}`)
        }
      })
    } else if (typeof riskCategory === "object") {
      Object.values(riskCategory).forEach(extractRecommendations)
    }
  }

  extractRecommendations(risks)

  return recommendations
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
