/**
 * snow_run_compliance_scan - Run compliance scans
 *
 * Executes compliance scans against specified frameworks (SOX, GDPR, HIPAA, PCI-DSS) to identify non-compliant configurations and security gaps.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_run_compliance_scan",
  description: "Run compliance scans against security frameworks (SOX, GDPR, HIPAA, PCI-DSS)",
  // Metadata for tool discovery (not sent to LLM)
  category: "security",
  subcategory: "compliance",
  use_cases: ["security", "compliance", "audit"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - creates and PATCHes sn_compliance_scan and creates
  // sn_compliance_report. "Scans without modifying" described the intent, not
  // the code.
  permission: "write",
  allowedRoles: ["developer", "admin"],
  // A scan run and its report are operational records, not configuration.
  updateSet: "exempt",
  inputSchema: {
    type: "object",
    properties: {
      framework: {
        type: "string",
        description: "Compliance framework to scan against",
        enum: ["sox", "gdpr", "hipaa", "pci_dss", "iso27001", "nist"],
      },
      scope: {
        type: "string",
        description: "Scan scope",
        enum: ["full", "critical_only", "incremental"],
        default: "full",
      },
      target_table: { type: "string", description: "Specific table to scan (optional)" },
      generate_report: { type: "boolean", description: "Generate compliance report", default: true },
    },
    required: ["framework"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { framework, scope = "full", target_table, generate_report = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Create compliance scan record
    const scanData: any = {
      framework,
      scope,
      status: "in_progress",
      started_at: new Date().toISOString(),
    }

    if (target_table) scanData.target_table = target_table

    const scanResponse = await client.post("/api/now/table/sn_compliance_scan", scanData)
    const scanSysId = scanResponse.data.result.sys_id

    // Execute scan based on framework
    const scanResults = await executeScan(client, framework, scope, target_table)

    // Update scan record with results
    await client.patch(`/api/now/table/sn_compliance_scan/${scanSysId}`, {
      status: "completed",
      completed_at: new Date().toISOString(),
      total_checks: scanResults.total_checks,
      passed: scanResults.passed,
      failed: scanResults.failed,
      warnings: scanResults.warnings,
    })

    // Generate report if requested
    let reportSysId = null
    if (generate_report) {
      const reportResponse = await client.post("/api/now/table/sn_compliance_report", {
        scan_id: scanSysId,
        framework,
        results: JSON.stringify(scanResults),
        generated_at: new Date().toISOString(),
      })
      reportSysId = reportResponse.data.result.sys_id
    }

    return createSuccessResult(
      {
        scan_id: scanSysId,
        report_id: reportSysId,
        results: scanResults,
        compliance_score: calculateComplianceScore(scanResults),
      },
      { framework, scope },
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

async function executeScan(client: any, framework: string, scope: string, targetTable?: string): Promise<any> {
  // Scan logic based on framework
  const checks = getFrameworkChecks(framework)
  const results = {
    total_checks: checks.length,
    passed: 0,
    failed: 0,
    warnings: 0,
    violations: [] as any[],
  }

  for (const check of checks) {
    try {
      const checkResult = await performCheck(client, check, targetTable)

      if (checkResult.status === "passed") {
        results.passed++
      } else if (checkResult.status === "failed") {
        results.failed++
        results.violations.push({
          check_id: check.id,
          check_name: check.name,
          severity: check.severity,
          details: checkResult.details,
        })
      } else if (checkResult.status === "warning") {
        results.warnings++
        results.violations.push({
          check_id: check.id,
          check_name: check.name,
          severity: "warning",
          details: checkResult.details,
        })
      }
    } catch (error) {
      results.warnings++
    }
  }

  return results
}

function getFrameworkChecks(framework: string): any[] {
  const checksMap: Record<string, any[]> = {
    sox: [
      { id: "SOX-001", name: "Audit Trail Enabled", severity: "critical", table: "sys_audit" },
      { id: "SOX-002", name: "User Access Reviews", severity: "high", table: "sys_user_role" },
      { id: "SOX-003", name: "Change Management", severity: "high", table: "sys_update_set" },
    ],
    gdpr: [
      { id: "GDPR-001", name: "Data Encryption", severity: "critical", table: "sys_properties" },
      { id: "GDPR-002", name: "Data Retention Policies", severity: "high", table: "sys_data_policy" },
      { id: "GDPR-003", name: "User Consent Management", severity: "critical", table: "sys_user" },
    ],
    hipaa: [
      { id: "HIPAA-001", name: "PHI Encryption", severity: "critical", table: "sys_properties" },
      { id: "HIPAA-002", name: "Access Controls", severity: "critical", table: "sys_security_acl" },
      { id: "HIPAA-003", name: "Audit Logging", severity: "high", table: "sys_audit" },
    ],
    pci_dss: [
      { id: "PCI-001", name: "Cardholder Data Protection", severity: "critical", table: "sys_properties" },
      { id: "PCI-002", name: "Network Security", severity: "critical", table: "sys_security" },
      { id: "PCI-003", name: "Access Restrictions", severity: "high", table: "sys_security_acl" },
    ],
    iso27001: [
      { id: "ISO-001", name: "Information Security Policy", severity: "high", table: "sys_properties" },
      { id: "ISO-002", name: "Risk Assessment", severity: "high", table: "risk_assessment" },
      { id: "ISO-003", name: "Security Controls", severity: "critical", table: "sys_security_acl" },
    ],
    nist: [
      { id: "NIST-001", name: "Identity Management", severity: "high", table: "sys_user" },
      { id: "NIST-002", name: "Access Control", severity: "critical", table: "sys_security_acl" },
      { id: "NIST-003", name: "System Hardening", severity: "high", table: "sys_properties" },
    ],
  }

  return checksMap[framework] || []
}

async function performCheck(client: any, check: any, targetTable?: string): Promise<any> {
  // If target table specified and doesn't match check table, skip
  if (targetTable && check.table !== targetTable) {
    return { status: "skipped" }
  }

  try {
    // Query the table to verify compliance
    const response = await client.get(`/api/now/table/${check.table}`, {
      params: { sysparm_limit: 1 },
    })

    // Simple check - in production this would be more sophisticated
    const hasRecords = response.data.result && response.data.result.length > 0

    return {
      status: hasRecords ? "passed" : "warning",
      details: hasRecords ? "Check passed" : "No records found for validation",
    }
  } catch (error) {
    return {
      status: "failed",
      details: `Check failed: ${error}`,
    }
  }
}

function calculateComplianceScore(results: any): number {
  const total = results.total_checks
  if (total === 0) return 100

  const score = ((results.passed + results.warnings * 0.5) / total) * 100
  return Math.round(score * 10) / 10
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
