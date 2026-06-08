/**
 * snow_execute_script - Execute server-side JavaScript on ServiceNow
 *
 * Thin wrapper around shared/scripted-exec.ts that adds ES5 validation,
 * security analysis, and confirmation prompts for user-triggered scripts.
 *
 * ES5 only! ServiceNow runs on Rhino engine.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { executeServerScript } from "../../shared/scripted-exec.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_execute_script",
  description:
    "Execute server-side JavaScript on ServiceNow. Primary: synchronous execution via Scripted REST API (~1-3s). Fallback: scheduled job if endpoint unavailable. Auto-deploys the executor endpoint on first use. ES5 only (Rhino engine)!",
  category: "automation",
  subcategory: "script-execution",
  use_cases: ["automation", "scripts", "scheduled-jobs", "debugging", "verification"],
  complexity: "advanced",
  frequency: "high",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description: "ES5 ONLY! JavaScript code to execute (no const/let/arrows/templates - Rhino engine)",
      },
      description: {
        type: "string",
        description: "Clear description of what the script does (required if requireConfirmation=true)",
      },
      scope: {
        type: "string",
        description: "Scope to execute in",
        default: "global",
        enum: ["global", "rhino"],
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds for polling execution results (fallback mode only)",
        default: 30000,
      },
      validate_es5: {
        type: "boolean",
        description: "Validate ES5 syntax before execution",
        default: true,
      },
      requireConfirmation: {
        type: "boolean",
        description: "Require user confirmation before execution (shows security analysis)",
        default: false,
      },
      autoConfirm: {
        type: "boolean",
        description: "Skip user confirmation even if requireConfirmation would normally be required",
        default: false,
      },
      allowDataModification: {
        type: "boolean",
        description: "Whether script is allowed to modify data (for security analysis)",
        default: false,
      },
      runAsUser: {
        type: "string",
        description: "User to execute script as (optional, defaults to current user)",
      },
    },
    required: ["script"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const script = args.script as string
  const description = (args.description as string) || "Script executed via snow_execute_script"
  const timeout = (args.timeout as number) || 30000
  const validate = args.validate_es5 !== false
  const confirmation = args.requireConfirmation === true
  const auto = args.autoConfirm === true
  const modification = args.allowDataModification === true
  const user = args.runAsUser as string | undefined

  const warnings: string[] = []

  try {
    if (validate) {
      const validation = validateES5(script)
      if (!validation.valid) {
        warnings.push(
          `Script contains ES6+ syntax (${validation.violations.map((v) => v.type).join(", ")}). This may cause runtime errors in ServiceNow's Rhino engine. Consider using ES5 syntax.`,
        )
      }
    }

    const security = analyzeScriptSecurity(script)

    if (confirmation && !auto) {
      const prompt = generateConfirmationPrompt({
        script,
        description,
        runAsUser: user,
        allowDataModification: modification,
        securityAnalysis: security,
      })

      return createSuccessResult(
        {
          requires_confirmation: true,
          confirmation_prompt: prompt,
          script_to_execute: script,
          execution_context: {
            runAsUser: user || "current",
            allowDataModification: modification,
            securityLevel: security.riskLevel,
          },
          next_step: "Call snow_confirm_script_execution with userConfirmed=true to execute",
        },
        {
          action_required: "User must approve script execution via snow_confirm_script_execution",
        },
      )
    }

    const result = await executeServerScript(context, script, { timeout, description })

    const output = result.output || []
    const organized = {
      print: output.filter((o) => o.level === "print").map((o) => o.message),
      info: output.filter((o) => o.level === "info").map((o) => o.message),
      warn: output.filter((o) => o.level === "warn").map((o) => o.message),
      error: output.filter((o) => o.level === "error").map((o) => o.message),
      success: result.success,
    }

    const data: Record<string, unknown> = {
      executed: result.method !== "scheduled_job_pending",
      success: result.success,
      result: result.result,
      error: result.error,
      output: organized,
      raw_output: result.output,
      execution_time_ms: result.executionTimeMs,
      execution_id: result.executionId,
      auto_confirmed: auto,
      security_analysis: security,
    }

    if (result.fallbackWarning) data.fallback_warning = result.fallbackWarning
    if (result.scheduledJobSysId) data.scheduled_job_sys_id = result.scheduledJobSysId
    if (result.actionRequired) data.action_required = result.actionRequired
    if (result.manualUrl) data.manual_url = result.manualUrl
    if (warnings.length > 0) data.warnings = warnings

    return createSuccessResult(data, {
      script_length: script.length,
      method: result.method,
      description,
    })
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, err.message, { originalError: err }),
    )
  }
}

function validateES5(code: string): {
  valid: boolean
  violations: Array<{ type: string; line: number; code: string; fix: string }>
} {
  const violations: Array<{ type: string; line: number; code: string; fix: string }> = []

  const patterns = [
    { regex: /\b(const|let)\s+/g, type: "const/let", fix: "Use 'var'" },
    { regex: /\([^)]*\)\s*=>/g, type: "arrow_function", fix: "Use function() {}" },
    { regex: /`[^`]*`/g, type: "template_literal", fix: "Use string concatenation" },
    { regex: /\{[^}]+\}\s*=\s*/g, type: "destructuring", fix: "Use explicit properties" },
    { regex: /for\s*\([^)]*\s+of\s+/g, type: "for_of", fix: "Use traditional for loop" },
    { regex: /class\s+\w+/g, type: "class", fix: "Use function constructor" },
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.regex.exec(code)) !== null) {
      violations.push({
        type: pattern.type,
        line: code.substring(0, match.index).split("\n").length,
        code: match[0],
        fix: pattern.fix,
      })
    }
  }

  return { valid: violations.length === 0, violations }
}

function analyzeScriptSecurity(script: string): Record<string, unknown> {
  const analysis = {
    riskLevel: "LOW" as string,
    warnings: [] as string[],
    dataOperations: [] as string[],
    systemAccess: [] as string[],
  }

  const modification = [/\.insert\(\)/gi, /\.update\(\)/gi, /\.deleteRecord\(\)/gi, /\.setValue\(/gi]
  const system = [/gs\.getUser\(\)/gi, /gs\.getUserID\(\)/gi, /gs\.hasRole\(/gi, /gs\.executeNow\(/gi]
  const dangerous = [/eval\(/gi, /new Function\(/gi, /\.setWorkflow\(/gi]

  for (const pattern of modification) {
    const matches = script.match(pattern)
    if (matches) {
      analysis.dataOperations.push(...matches)
      if (analysis.riskLevel === "LOW") analysis.riskLevel = "MEDIUM"
    }
  }

  for (const pattern of system) {
    const matches = script.match(pattern)
    if (matches) {
      analysis.systemAccess.push(...matches)
    }
  }

  for (const pattern of dangerous) {
    const matches = script.match(pattern)
    if (matches) {
      analysis.warnings.push(`Potentially dangerous operation detected: ${matches[0]}`)
      analysis.riskLevel = "HIGH"
    }
  }

  if (script.includes("while") && (script.includes(".next()") || script.includes(".hasNext()"))) {
    analysis.warnings.push("Script contains loops that may process many records")
    if (analysis.riskLevel === "LOW") analysis.riskLevel = "MEDIUM"
  }

  return analysis
}

function generateConfirmationPrompt(ctx: {
  script: string
  description: string
  runAsUser: string | undefined
  allowDataModification: boolean
  securityAnalysis: Record<string, unknown>
}): string {
  const risk = ctx.securityAnalysis.riskLevel as string
  const emoji = risk === "HIGH" ? "RED" : risk === "MEDIUM" ? "YELLOW" : "GREEN"
  const ops = ctx.securityAnalysis.dataOperations as string[]
  const access = ctx.securityAnalysis.systemAccess as string[]
  const warns = ctx.securityAnalysis.warnings as string[]

  return `
SCRIPT EXECUTION REQUEST

Description: ${ctx.description}

Security Risk Level: ${emoji} ${risk}

Run as User: ${ctx.runAsUser || "Current User"}
Data Modification: ${ctx.allowDataModification ? "ALLOWED" : "READ-ONLY"}

Script Analysis:
${ops.length > 0 ? `Data Operations Detected: ${ops.join(", ")}` : ""}
${access.length > 0 ? `System Access: ${access.join(", ")}` : ""}
${warns.length > 0 ? `Warnings: ${warns.join(", ")}` : ""}

Script to Execute:
\`\`\`javascript
${ctx.script}
\`\`\`

Impact: This script will run in ServiceNow's server-side JavaScript context with full API access.

Do you want to proceed with executing this script?

Reply with:
- YES - Execute the script
- NO - Cancel execution
- MODIFY - Make changes before execution

Only proceed if you understand what this script does and trust its source!
`.trim()
}

export const version = "3.1.0"
export const author = "Serac SDK"
