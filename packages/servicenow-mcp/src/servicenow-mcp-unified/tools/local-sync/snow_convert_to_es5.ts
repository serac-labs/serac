/**
 * snow_convert_to_es5 - Convert modern JavaScript to ES5
 *
 * Automatically convert ES6+ JavaScript to ES5 for ServiceNow Rhino engine.
 * Handles const/let, arrow functions, template literals, destructuring, etc.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_convert_to_es5",
  description: "Convert modern JavaScript (ES6+) to ES5 for ServiceNow Rhino engine",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "local-sync",
  use_cases: ["es5-conversion", "validation", "development"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "JavaScript code to convert to ES5",
      },
      validate_only: {
        type: "boolean",
        description: "Only validate ES5 compliance without converting",
        default: false,
      },
    },
    required: ["code"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { code, validate_only = false } = args

  try {
    // Detect ES6+ features
    const violations = detectES6Features(code)

    if (validate_only) {
      return createSuccessResult({
        valid: violations.length === 0,
        violations,
        es5_compliant: violations.length === 0,
      })
    }

    // Convert to ES5
    let es5Code = code
    let conversions: any[] = []

    // 1. Convert const/let to var
    es5Code = es5Code.replace(/\b(const|let)\s+/g, (match, keyword) => {
      conversions.push({ from: keyword, to: "var", type: "variable_declaration" })
      return "var "
    })

    // 2. Convert arrow functions
    es5Code = es5Code.replace(/\(([^)]*)\)\s*=>\s*\{/g, (match, params) => {
      conversions.push({ from: `(${params}) => {`, to: `function(${params}) {`, type: "arrow_function" })
      return `function(${params}) {`
    })

    // Single-line arrow functions
    es5Code = es5Code.replace(/\(([^)]*)\)\s*=>\s*([^;{}\n]+)/g, (match, params, body) => {
      conversions.push({
        from: `(${params}) => ${body}`,
        to: `function(${params}) { return ${body}; }`,
        type: "arrow_function_single",
      })
      return `function(${params}) { return ${body}; }`
    })

    // 3. Convert template literals
    es5Code = es5Code.replace(/`([^`]*)`/g, (match, content) => {
      // Extract ${...} expressions
      const withVars = content.replace(/\$\{([^}]+)\}/g, (m, expr) => `' + (${expr}) + '`)
      const converted = `'${withVars}'`.replace(/'' \+ /g, "").replace(/ \+ ''/g, "")
      conversions.push({ from: match, to: converted, type: "template_literal" })
      return converted
    })

    // 4. Convert destructuring (simple cases)
    es5Code = es5Code.replace(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*([^;]+);/g, (match, props, source) => {
      const properties = props.split(",").map((p: string) => p.trim())
      const assignments = properties.map((p: string) => `var ${p} = ${source}.${p};`).join("\n")
      conversions.push({ from: match, to: assignments, type: "destructuring" })
      return assignments
    })

    // 5. Convert for...of to traditional for loop
    es5Code = es5Code.replace(/for\s*\(\s*(?:const|let|var)\s+(\w+)\s+of\s+([^)]+)\)/g, (match, variable, array) => {
      const converted = `for (var __i = 0; __i < ${array}.length; __i++) {\nvar ${variable} = ${array}[__i];`
      conversions.push({ from: match, to: converted, type: "for_of_loop" })
      return converted
    })

    // Validate result
    const finalViolations = detectES6Features(es5Code)

    return createSuccessResult({
      original_code: code,
      es5_code: es5Code,
      conversions,
      conversions_count: conversions.length,
      es5_compliant: finalViolations.length === 0,
      remaining_violations: finalViolations,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function detectES6Features(code: string): any[] {
  const violations: any[] = []

  const patterns = [
    { regex: /\bconst\s+/g, type: "const", severity: "error" },
    { regex: /\blet\s+/g, type: "let", severity: "error" },
    { regex: /\([^)]*\)\s*=>/g, type: "arrow_function", severity: "error" },
    { regex: /`[^`]*`/g, type: "template_literal", severity: "error" },
    { regex: /\{[^}]+\}\s*=/g, type: "destructuring", severity: "error" },
    { regex: /for\s*\([^)]*\s+of\s+/g, type: "for_of", severity: "error" },
    { regex: /class\s+\w+/g, type: "class", severity: "error" },
    { regex: /\.\.\./g, type: "spread_operator", severity: "error" },
  ]

  patterns.forEach(({ regex, type, severity }) => {
    let match
    while ((match = regex.exec(code)) !== null) {
      violations.push({
        type,
        severity,
        line: code.substring(0, match.index).split("\n").length,
        code: match[0],
        fix: getFixSuggestion(type),
      })
    }
  })

  return violations
}

function getFixSuggestion(type: string): string {
  const fixes: Record<string, string> = {
    const: "Use 'var' instead",
    let: "Use 'var' instead",
    arrow_function: "Use function() {} syntax",
    template_literal: "Use string concatenation with +",
    destructuring: "Use explicit property access",
    for_of: "Use traditional for loop with index",
    class: "Use function constructor with prototype",
    spread_operator: "Use Array.prototype methods",
  }
  return fixes[type] || "Convert to ES5 equivalent"
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
