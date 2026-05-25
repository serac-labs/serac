/**
 * snow_detect_code_patterns - Code pattern detection and analysis
 *
 * Detect common code patterns, anti-patterns, and best practices
 * in ServiceNow scripts.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_detect_code_patterns",
  description: "Detect code patterns, anti-patterns, and best practices in ServiceNow scripts",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "code-analysis",
  use_cases: ["integration", "code-quality", "analysis"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "JavaScript code to analyze",
      },
      check_es5: {
        type: "boolean",
        description: "Check for ES5 compliance",
        default: true,
      },
      check_performance: {
        type: "boolean",
        description: "Check for performance anti-patterns",
        default: true,
      },
      check_security: {
        type: "boolean",
        description: "Check for security issues",
        default: true,
      },
      check_best_practices: {
        type: "boolean",
        description: "Check ServiceNow best practices",
        default: true,
      },
    },
    required: ["code"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { code, check_es5 = true, check_performance = true, check_security = true, check_best_practices = true } = args

  try {
    const patterns: any = {
      es5_violations: [],
      performance_issues: [],
      security_issues: [],
      best_practice_violations: [],
      good_patterns: [],
    }

    // ES5 Compliance Check
    if (check_es5) {
      // Remove strings and comments before analyzing to avoid false positives
      const codeWithoutStrings = code
        .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, '""') // Single-quoted strings
        .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""') // Double-quoted strings
        .replace(/\/\/[^\n]*/g, "") // Single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, "") // Multi-line comments

      const es5Patterns = [
        { regex: /\bconst\s+/g, type: "const", message: "Use var instead of const" },
        { regex: /\blet\s+/g, type: "let", message: "Use var instead of let" },
        { regex: /=>\s*{|=>\s*\(/g, type: "arrow_function", message: "Use function() {} instead of arrow functions" },
        {
          regex: /`[^`]*`/g,
          type: "template_literal",
          message: "Use string concatenation instead of template literals",
          checkOriginal: true,
        },
        { regex: /\.\.\.[\w\[]/g, type: "spread", message: "Spread operator not supported in ES5" }, // Improved: must be followed by identifier
        { regex: /class\s+\w+/g, type: "class", message: "Use function constructors instead of classes" },
      ]

      es5Patterns.forEach((pattern: any) => {
        // For template literals, check original code
        const codeToCheck = pattern.checkOriginal ? code : codeWithoutStrings
        const matches = codeToCheck.match(pattern.regex)
        if (matches) {
          patterns.es5_violations.push({
            type: pattern.type,
            count: matches.length,
            message: pattern.message,
            severity: "warning", // Changed from 'error' to 'warning' - ES6 often works
          })
        }
      })
    }

    // Performance Anti-patterns
    if (check_performance) {
      const performancePatterns = [
        {
          regex: /while\s*\(\s*gr\.next\(\)/g,
          type: "unbounded_while_loop",
          message: "Use for loop with limit instead of unbounded while(gr.next())",
          severity: "high",
        },
        {
          regex: /new\s+GlideRecord\([^)]+\)[^}]*\{[^}]*new\s+GlideRecord/g,
          type: "nested_gliderecord",
          message: "Nested GlideRecord queries can cause performance issues",
          severity: "high",
        },
        {
          regex: /gr\.query\(\)[^}]*while[^}]*gr\.getValue/g,
          type: "getValue_in_loop",
          message: "Repeated getValue() calls in loop - cache values instead",
          severity: "medium",
        },
        {
          regex: /gs\.getUser\(\)\.getID\(\)/g,
          type: "repeated_getUser",
          message: "Cache gs.getUser() result instead of calling repeatedly",
          severity: "low",
        },
      ]

      performancePatterns.forEach((pattern) => {
        if (pattern.regex.test(code)) {
          patterns.performance_issues.push({
            type: pattern.type,
            message: pattern.message,
            severity: pattern.severity,
          })
        }
      })
    }

    // Security Issues
    if (check_security) {
      const securityPatterns = [
        {
          regex: /eval\s*\(/g,
          type: "eval_usage",
          message: "eval() is a security risk - avoid using it",
          severity: "critical",
        },
        {
          regex: /gs\.executeNow\s*\(/g,
          type: "executeNow",
          message: "gs.executeNow() can bypass security - use with caution",
          severity: "high",
        },
        {
          regex: /setWorkflow\s*\(\s*false\s*\)/g,
          type: "workflow_bypass",
          message: "Disabling workflow can bypass business rules",
          severity: "medium",
        },
        {
          regex: /password|pwd|secret|api[_-]?key/gi,
          type: "hardcoded_credentials",
          message: "Possible hardcoded credentials - use system properties instead",
          severity: "critical",
        },
      ]

      securityPatterns.forEach((pattern) => {
        if (pattern.regex.test(code)) {
          patterns.security_issues.push({
            type: pattern.type,
            message: pattern.message,
            severity: pattern.severity,
          })
        }
      })
    }

    // ServiceNow Best Practices
    if (check_best_practices) {
      const bestPractices = [
        {
          regex: /gr\.query\(\)[^}]*if\s*\(\s*gr\.next/g,
          type: "missing_query_limit",
          message: "Add setLimit() before query() for better performance",
          severity: "medium",
        },
        {
          regex: /current\./g,
          type: "current_object",
          message: "Using current object - ensure it exists in context",
          severity: "info",
          isGood: true,
        },
        {
          regex: /try\s*\{[^}]*\}\s*catch/g,
          type: "error_handling",
          message: "Good: Error handling implemented",
          severity: "info",
          isGood: true,
        },
        {
          regex: /gs\.(info|warn|error|debug)\(/g,
          type: "logging",
          message: "Good: Logging statements present",
          severity: "info",
          isGood: true,
        },
      ]

      bestPractices.forEach((pattern) => {
        if (pattern.regex.test(code)) {
          if (pattern.isGood) {
            patterns.good_patterns.push({
              type: pattern.type,
              message: pattern.message,
            })
          } else {
            patterns.best_practice_violations.push({
              type: pattern.type,
              message: pattern.message,
              severity: pattern.severity,
            })
          }
        }
      })
    }

    // Calculate overall score
    const criticalIssues = [
      ...patterns.es5_violations.filter((v: any) => v.severity === "error"),
      ...patterns.security_issues.filter((i: any) => i.severity === "critical"),
    ].length

    const highIssues = [
      ...patterns.performance_issues.filter((i: any) => i.severity === "high"),
      ...patterns.security_issues.filter((i: any) => i.severity === "high"),
    ].length

    const totalIssues =
      patterns.es5_violations.length +
      patterns.performance_issues.length +
      patterns.security_issues.length +
      patterns.best_practice_violations.length

    let codeQuality = "excellent"
    if (criticalIssues > 0) {
      codeQuality = "critical"
    } else if (highIssues > 2) {
      codeQuality = "poor"
    } else if (totalIssues > 5) {
      codeQuality = "moderate"
    } else if (totalIssues > 0) {
      codeQuality = "good"
    }

    return createSuccessResult({
      patterns,
      summary: {
        total_issues: totalIssues,
        critical_issues: criticalIssues,
        high_priority_issues: highIssues,
        good_patterns_found: patterns.good_patterns.length,
        code_quality: codeQuality,
      },
      recommendations: generateRecommendations(patterns),
      es5_compliant: patterns.es5_violations.length === 0,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function generateRecommendations(patterns: any): string[] {
  const recommendations: string[] = []

  if (patterns.es5_violations.length > 0) {
    recommendations.push("Convert all ES6+ syntax to ES5 for ServiceNow compatibility")
  }

  if (patterns.security_issues.some((i: any) => i.severity === "critical")) {
    recommendations.push("Address critical security issues immediately")
  }

  if (patterns.performance_issues.length > 0) {
    recommendations.push("Optimize performance by addressing identified anti-patterns")
  }

  if (patterns.best_practice_violations.length > 3) {
    recommendations.push("Review ServiceNow best practices and update code accordingly")
  }

  if (recommendations.length === 0) {
    recommendations.push("Code follows ServiceNow best practices")
  }

  return recommendations
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
