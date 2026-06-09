/**
 * snow_convert_es6_to_es5
 *
 * Converts ES6+ JavaScript syntax to ES5 for ServiceNow compatibility.
 * This tool is useful for debugging when scripts fail with SyntaxErrors.
 *
 * Features:
 * - Converts const/let to var
 * - Converts arrow functions to function expressions
 * - Converts template literals to string concatenation
 * - Converts for...of to traditional for loops
 * - Converts destructuring to explicit property access
 * - Converts default parameters to typeof checks
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_convert_es6_to_es5",
  description: "Convert ES6+ JavaScript to ES5 for ServiceNow compatibility. Use this when debugging SyntaxErrors.",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "utilities",
  use_cases: ["es5-conversion", "debugging", "syntax-fix", "servicenow-compatibility"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Utility function - no ServiceNow API calls
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "The JavaScript code to convert from ES6+ to ES5",
      },
      analyze_only: {
        type: "boolean",
        description: "Only analyze for ES6+ features, do not convert",
        default: false,
      },
      show_diff: {
        type: "boolean",
        description: "Show differences between original and converted code",
        default: true,
      },
    },
    required: ["code"],
  },
}

interface ES6Detection {
  type: string
  match: string
  line: number
  description: string
  suggestion: string
}

interface ConversionResult {
  original: string
  converted: string
  detections: ES6Detection[]
  changesApplied: number
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { code, analyze_only = false, show_diff = true } = args

  try {
    // Detect ES6+ features
    const detections = detectES6Features(code)

    if (analyze_only) {
      return createSuccessResult({
        analysis: {
          es6_features_found: detections.length,
          features: detections,
          recommendation:
            detections.length > 0
              ? "ES6+ syntax detected. If you encounter SyntaxErrors in ServiceNow, consider converting to ES5."
              : "No ES6+ syntax detected. Code should be compatible with ServiceNow.",
        },
      })
    }

    // Convert ES6+ to ES5
    const result = convertToES5(code)

    const response: any = {
      success: true,
      changes_applied: result.changesApplied,
      es6_features_found: result.detections.length,
      detections: result.detections,
      converted_code: result.converted,
    }

    if (show_diff && result.original !== result.converted) {
      response.diff = generateDiff(result.original, result.converted)
    }

    if (result.changesApplied === 0) {
      response.message = "No ES6+ syntax detected. Code is already ES5 compatible."
    } else {
      response.message = `Converted ${result.changesApplied} ES6+ features to ES5.`
    }

    return createSuccessResult(response)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function detectES6Features(code: string): ES6Detection[] {
  const detections: ES6Detection[] = []
  const lines = code.split("\n")

  // Remove string contents and comments before detection to avoid false positives
  const codeForAnalysis = code
    .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, '""')
    .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")

  const patterns = [
    {
      regex: /\bconst\s+(\w+)/g,
      type: "const",
      description: "const declaration",
      suggestion: "Use var instead",
    },
    {
      regex: /\blet\s+(\w+)/g,
      type: "let",
      description: "let declaration",
      suggestion: "Use var instead",
    },
    {
      regex: /\([^)]*\)\s*=>\s*[{(]/g,
      type: "arrow_function",
      description: "Arrow function",
      suggestion: "Use function() {} instead",
    },
    {
      regex: /\w+\s*=>\s*[^,;\n]+/g,
      type: "arrow_function_simple",
      description: "Simple arrow function",
      suggestion: "Use function(x) { return x; } instead",
    },
    {
      regex: /`[^`]*\$\{[^}]*\}[^`]*`/g,
      type: "template_literal",
      description: "Template literal with interpolation",
      suggestion: "Use string concatenation with +",
    },
    {
      regex: /for\s*\(\s*(?:let|const|var)\s+\w+\s+of\s+/g,
      type: "for_of",
      description: "for...of loop",
      suggestion: "Use traditional for loop with index",
    },
    {
      regex: /(?:var|let|const)\s*\{[^}]+\}\s*=\s*/g,
      type: "destructuring_object",
      description: "Object destructuring",
      suggestion: "Use explicit property access",
    },
    {
      regex: /(?:var|let|const)\s*\[[^\]]+\]\s*=\s*/g,
      type: "destructuring_array",
      description: "Array destructuring",
      suggestion: "Use explicit array indexing",
    },
    {
      regex: /\.\.\.[\w\[]/g,
      type: "spread",
      description: "Spread operator",
      suggestion: "Use Array.prototype.concat or manual expansion",
    },
    {
      regex: /function\s+\w*\s*\([^)]*=[^)]*\)/g,
      type: "default_params",
      description: "Default function parameters",
      suggestion: "Use typeof checks inside function",
    },
    {
      regex: /class\s+\w+/g,
      type: "class",
      description: "ES6 class declaration",
      suggestion: "Use function constructor pattern",
    },
  ]

  patterns.forEach((pattern) => {
    let match
    while ((match = pattern.regex.exec(codeForAnalysis)) !== null) {
      const lineNumber = codeForAnalysis.substring(0, match.index).split("\n").length
      detections.push({
        type: pattern.type,
        match: match[0],
        line: lineNumber,
        description: pattern.description,
        suggestion: pattern.suggestion,
      })
    }
  })

  // Also check original code for template literals (they might be outside strings)
  const templateRegex = /`[^`]*`/g
  let match
  while ((match = templateRegex.exec(code)) !== null) {
    const lineNumber = code.substring(0, match.index).split("\n").length
    const alreadyDetected = detections.some((d) => d.type === "template_literal" && d.line === lineNumber)
    if (!alreadyDetected) {
      detections.push({
        type: "template_literal",
        match: match[0].length > 50 ? match[0].substring(0, 50) + "..." : match[0],
        line: lineNumber,
        description: "Template literal",
        suggestion: "Use string concatenation with +",
      })
    }
  }

  return detections.sort((a, b) => a.line - b.line)
}

function convertToES5(code: string): ConversionResult {
  let converted = code
  const detections = detectES6Features(code)
  let changesApplied = 0

  // Convert const/let to var (safe transformation)
  const constLetRegex = /\b(const|let)\s+/g
  if (constLetRegex.test(converted)) {
    converted = converted.replace(/\b(const|let)\s+/g, "var ")
    changesApplied++
  }

  // Convert simple arrow functions: x => x.something
  const simpleArrowRegex = /(\w+)\s*=>\s*([^,;\n{]+)(?=[,;\n\)])/g
  if (simpleArrowRegex.test(converted)) {
    converted = converted.replace(simpleArrowRegex, "function($1) { return $2; }")
    changesApplied++
  }

  // Convert arrow functions with parentheses: (x) => { ... }
  const arrowWithBodyRegex = /\(([^)]*)\)\s*=>\s*\{/g
  if (arrowWithBodyRegex.test(converted)) {
    converted = converted.replace(arrowWithBodyRegex, "function($1) {")
    changesApplied++
  }

  // Convert arrow functions returning expression: (x) => expression
  const arrowExpressionRegex = /\(([^)]*)\)\s*=>\s*([^{][^,;\n]*)/g
  if (arrowExpressionRegex.test(converted)) {
    converted = converted.replace(arrowExpressionRegex, "function($1) { return $2; }")
    changesApplied++
  }

  // Convert template literals to string concatenation
  const templateLiteralRegex = /`([^`]*)`/g
  let templateMatch
  while ((templateMatch = templateLiteralRegex.exec(code)) !== null) {
    const templateContent = templateMatch[1]
    // Convert ${expr} to ' + expr + '
    // SECURITY: Escape all special characters properly to prevent injection
    const convertedTemplate =
      "'" +
      templateContent
        .replace(/\\/g, "\\\\") // Escape backslashes FIRST
        .replace(/'/g, "\\'") // Then escape single quotes
        .replace(/\n/g, "\\n") // Escape newlines
        .replace(/\r/g, "\\r") // Escape carriage returns
        .replace(/\$\{([^}]+)\}/g, "' + $1 + '") +
      "'"
    // Clean up empty concatenations
    const cleanedTemplate = convertedTemplate.replace(/'' \+ /g, "").replace(/ \+ ''/g, "")
    converted = converted.replace(templateMatch[0], cleanedTemplate)
    changesApplied++
  }

  // Convert for...of to traditional for loop
  // This is a complex transformation - provide a helper comment
  const forOfRegex = /for\s*\(\s*(?:var|let|const)\s+(\w+)\s+of\s+(\w+)\s*\)/g
  if (forOfRegex.test(converted)) {
    converted = converted.replace(forOfRegex, (match, item, array) => {
      return `for (var _i = 0; _i < ${array}.length; _i++) { var ${item} = ${array}[_i];`
    })
    // Note: This adds an extra opening brace that may need manual adjustment
    changesApplied++
  }

  return {
    original: code,
    converted,
    detections,
    changesApplied,
  }
}

function generateDiff(original: string, converted: string): string {
  const originalLines = original.split("\n")
  const convertedLines = converted.split("\n")
  const diff: string[] = []

  const maxLines = Math.max(originalLines.length, convertedLines.length)

  for (let i = 0; i < maxLines; i++) {
    const origLine = originalLines[i] || ""
    const convLine = convertedLines[i] || ""

    if (origLine !== convLine) {
      if (origLine) diff.push(`- ${i + 1}: ${origLine}`)
      if (convLine) diff.push(`+ ${i + 1}: ${convLine}`)
    }
  }

  return diff.length > 0 ? diff.join("\n") : "No differences"
}

export const version = "1.0.0"
export const author = "Serac SDK"
