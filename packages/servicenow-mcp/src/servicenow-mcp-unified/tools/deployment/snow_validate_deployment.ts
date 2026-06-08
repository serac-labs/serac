/**
 * snow_validate_deployment - Pre-deployment validation
 *
 * Validates artifacts before deployment to catch issues early.
 * Checks ES5 syntax, coherence, dependencies, and security.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_validate_deployment",
  description: "Validate artifact before deployment (ES5, coherence, dependencies, security)",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "deployment",
  use_cases: ["deployment", "validation", "quality"],
  complexity: "advanced",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["widget", "page", "flow", "script_include", "business_rule"],
        description: "Artifact type to validate",
      },
      artifact: {
        type: "object",
        description: "Artifact configuration to validate",
      },
      checks: {
        type: "array",
        items: {
          type: "string",
          enum: ["es5", "coherence", "dependencies", "security", "performance"],
        },
        description: "Validation checks to perform",
        default: ["es5", "coherence", "dependencies"],
      },
    },
    required: ["type", "artifact"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { type, artifact, checks = ["es5", "coherence", "dependencies"] } = args

  try {
    const client = await getAuthenticatedClient(context)
    const results: any = {
      valid: true,
      critical_failures: 0,
      warnings: 0,
      checks: [],
    }

    // ES5 validation
    if (checks.includes("es5") && artifact.script) {
      const es5Result = await validateES5(artifact.script)
      results.checks.push({
        name: "ES5 Syntax",
        status: es5Result.valid ? "PASS" : "FAIL",
        critical: true,
        violations: es5Result.violations,
      })
      if (!es5Result.valid) {
        results.valid = false
        results.critical_failures++
      }
    }

    // Widget coherence validation
    if (checks.includes("coherence") && type === "widget") {
      const coherenceResult = await validateCoherence(artifact)
      const criticalIssues = coherenceResult.issues.filter((i: any) => i.severity === "critical")
      results.checks.push({
        name: "Widget Coherence",
        status: criticalIssues.length === 0 ? "PASS" : "FAIL",
        critical: true,
        issues: coherenceResult.issues,
        analysis: coherenceResult.analysis,
      })
      if (criticalIssues.length > 0) {
        results.valid = false
        results.critical_failures += criticalIssues.length
      }
      results.warnings += coherenceResult.issues.filter((i: any) => i.severity === "warning").length
    }

    // Dependency validation
    if (checks.includes("dependencies")) {
      const depResult = await validateDependencies(client, artifact)
      results.checks.push({
        name: "Dependencies",
        status: depResult.allExist ? "PASS" : "FAIL",
        critical: true,
        missing: depResult.missing,
      })
      if (!depResult.allExist) {
        results.valid = false
        results.critical_failures += depResult.missing.length
      }
    }

    // Security scan
    if (checks.includes("security")) {
      const securityResult = await scanSecurity(artifact)
      results.checks.push({
        name: "Security",
        status: securityResult.critical.length === 0 ? "PASS" : "WARNING",
        critical: false,
        issues: securityResult,
      })
      results.warnings += securityResult.warnings.length
    }

    // Performance scan
    if (checks.includes("performance")) {
      const perfResult = await scanPerformance(artifact)
      results.checks.push({
        name: "Performance",
        status: perfResult.issues.length === 0 ? "PASS" : "WARNING",
        critical: false,
        issues: perfResult.issues,
      })
      results.warnings += perfResult.issues.length
    }

    // Recommendation
    results.recommendation =
      results.critical_failures > 0
        ? "FIX_ERRORS_BEFORE_DEPLOY"
        : results.warnings > 0
          ? "PROCEED_WITH_CAUTION"
          : "PROCEED"

    return createSuccessResult(results)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

async function validateES5(code: string) {
  const violations: any[] = []

  // ES6+ patterns
  const patterns = [
    { regex: /\b(const|let)\s+/g, type: "const/let", fix: "Use 'var'" },
    { regex: /\([^)]*\)\s*=>/g, type: "arrow_function", fix: "Use function() {}" },
    { regex: /`[^`]*`/g, type: "template_literal", fix: "Use string concatenation" },
    { regex: /\{[^}]*\}\s*=\s*/g, type: "destructuring", fix: "Use explicit properties" },
    { regex: /for\s*\([^)]*\s+of\s+/g, type: "for_of", fix: "Use traditional for loop" },
  ]

  patterns.forEach(({ regex, type, fix }) => {
    let match
    while ((match = regex.exec(code)) !== null) {
      violations.push({
        type,
        line: code.substring(0, match.index).split("\n").length,
        code: match[0],
        fix,
      })
    }
  })

  return { valid: violations.length === 0, violations }
}

async function validateCoherence(artifact: any) {
  const issues: any[] = []
  const serverData: string[] = []
  const htmlRefs: string[] = []
  const clientMethods: string[] = []
  const inputActions: string[] = []

  // Extract server data initializations
  if (artifact.script) {
    const dataPattern = /data\.(\w+)\s*=/g
    let match
    while ((match = dataPattern.exec(artifact.script)) !== null) {
      serverData.push(match[1])
    }

    const actionPattern = /input\.action\s*===?\s*['"](\w+)['"]/g
    while ((match = actionPattern.exec(artifact.script)) !== null) {
      inputActions.push(match[1])
    }
  }

  // Extract HTML data references
  if (artifact.template) {
    const htmlPattern = /\{\{data\.(\w+)\}\}/g
    let match
    while ((match = htmlPattern.exec(artifact.template)) !== null) {
      htmlRefs.push(match[1])
      if (!serverData.includes(match[1])) {
        issues.push({
          type: "missing_data",
          severity: "critical",
          description: `HTML references data.${match[1]} but server doesn't initialize it`,
          fix: `Add 'data.${match[1]} = ...;' to server script`,
        })
      }
    }
  }

  // Extract client methods
  if (artifact.client_script) {
    const methodPattern = /(?:c|$scope)\.(\w+)\s*=\s*function/g
    let match
    while ((match = methodPattern.exec(artifact.client_script)) !== null) {
      clientMethods.push(match[1])
    }
  }

  return {
    coherent: issues.filter((i: any) => i.severity === "critical").length === 0,
    issues,
    analysis: { serverData, htmlRefs, clientMethods, inputActions },
  }
}

async function validateDependencies(client: any, artifact: any) {
  const missing: any[] = []

  // Extract table references
  const tablePattern = /new GlideRecord\(['"](\w+)['"]\)/g
  const tables = new Set<string>()

  if (artifact.script) {
    let match
    while ((match = tablePattern.exec(artifact.script)) !== null) {
      tables.add(match[1])
    }
  }

  // Check if tables exist
  for (const table of tables) {
    try {
      const response = await client.get(`/api/now/table/sys_db_object`, {
        params: {
          sysparm_query: `name=${table}`,
          sysparm_limit: 1,
        },
      })
      if (response.data.result.length === 0) {
        missing.push({ type: "table", name: table })
      }
    } catch (error) {
      missing.push({ type: "table", name: table, error: "Check failed" })
    }
  }

  return { allExist: missing.length === 0, missing }
}

async function scanSecurity(artifact: any) {
  const critical: any[] = []
  const warnings: any[] = []

  if (artifact.script || artifact.client_script) {
    const code = (artifact.script || "") + (artifact.client_script || "")

    // Check for hardcoded credentials
    if (/password\s*=\s*['"][^'"]+['"]|api[_-]?key\s*=\s*['"][^'"]+['"]/i.test(code)) {
      critical.push({
        issue: "Hardcoded credentials detected",
        severity: "critical",
        fix: "Use system properties or encrypted credentials",
      })
    }

    // Check for eval usage
    if (/\beval\s*\(/g.test(code)) {
      critical.push({
        issue: "eval() usage detected",
        severity: "critical",
        fix: "Avoid eval() - use safer alternatives",
      })
    }

    // Check for innerHTML usage (XSS risk)
    if (/\.innerHTML\s*=/g.test(code)) {
      warnings.push({
        issue: "innerHTML usage (XSS risk)",
        severity: "warning",
        fix: "Use textContent or sanitize input",
      })
    }
  }

  return { critical, warnings }
}

async function scanPerformance(artifact: any) {
  const issues: any[] = []

  if (artifact.script) {
    // Check for unlimited queries
    if (/new GlideRecord\([^)]+\)[^;]*query\(\)/.test(artifact.script) && !/setLimit\(/.test(artifact.script)) {
      issues.push({
        issue: "Unlimited query detected",
        severity: "warning",
        fix: "Add .setLimit(100) before .query()",
      })
    }

    // Check for getRowCount() usage
    if (/getRowCount\(\)/.test(artifact.script)) {
      issues.push({
        issue: "getRowCount() usage (slow)",
        severity: "warning",
        fix: "Use GlideAggregate for counts",
      })
    }
  }

  return { issues }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
