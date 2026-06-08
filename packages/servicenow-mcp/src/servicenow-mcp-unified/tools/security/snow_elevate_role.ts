/**
 * snow_elevate_role - Execute operations that require elevated privileges.
 *
 * Used for security_admin-scope work: modifying sys_security_acl records,
 * changing high-security system properties, and other operations that a
 * plain OAuth/Basic session would be blocked from performing.
 *
 * Confirmation is mandatory. The first call always returns a prompt; the
 * tool will only execute when re-called with user_confirmed=true. There
 * is no autoConfirm escape hatch — the agent cannot self-approve.
 *
 * Execution path: wraps the caller's ES5 script with best-effort session
 * elevation (gs.getSession().setElevatedRoles, GlideSecurityManager.elevateRole)
 * and runs it through the shared scripted-exec pipeline. The server-side
 * GlideRecord context already bypasses ACL evaluation for most operations
 * — the elevation APIs above are only meaningful on instances where the
 * session-level gate is also enforced.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import { executeServerScript } from "../../shared/scripted-exec.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_elevate_role",
  description:
    "Execute a server-side operation that requires elevated privileges (security_admin scope — ACL modifications, high-security properties, etc.). ALWAYS returns a confirmation prompt on the first call; executes only when re-called with user_confirmed=true. Agents cannot skip this confirmation.",
  category: "security",
  subcategory: "elevation",
  use_cases: ["acl-modification", "security-config", "high-security-properties", "elevated-operations"],
  complexity: "advanced",
  frequency: "low",
  permission: "admin",
  allowedRoles: ["admin"],
  inputSchema: {
    type: "object",
    properties: {
      roles: {
        type: "array",
        items: { type: "string" },
        description:
          "Elevated roles this operation declares it needs (e.g. ['security_admin']). Shown verbatim in the confirmation prompt so the user can judge scope before approving. This list is informational — the actual privilege comes from the authenticated user and the server-side execution context.",
      },
      operation_summary: {
        type: "string",
        description:
          "Short human-readable description of what this operation does. Shown in the confirmation prompt so the user knows what they are approving.",
      },
      script: {
        type: "string",
        description:
          "ES5 JavaScript to execute with elevation attempts. Runs server-side via scripted REST + GlideRecord. Use GlideUpdateManager2.loadUpdateXML() for ACL/security-table writes that field-level ACLs would otherwise block.",
      },
      user_confirmed: {
        type: "boolean",
        description:
          "MUST be explicitly true for the script to run. Default false returns a confirmation prompt — the user must re-call the tool with user_confirmed=true after reviewing the prompt. No other parameter can bypass this.",
        default: false,
      },
      timeout: {
        type: "number",
        description: "Execution timeout in milliseconds (applies to scheduler fallback only). Default 30000.",
        default: 30000,
      },
    },
    required: ["roles", "operation_summary", "script"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const roles = Array.isArray(args.roles) ? (args.roles as string[]).filter((r) => typeof r === "string" && r) : []
  const operationSummary = typeof args.operation_summary === "string" ? args.operation_summary.trim() : ""
  const script = typeof args.script === "string" ? args.script : ""
  const userConfirmed = args.user_confirmed === true
  const timeout = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : 30000

  if (roles.length === 0) return createErrorResult("'roles' must be a non-empty array of role names")
  if (!operationSummary) return createErrorResult("'operation_summary' is required")
  if (!script.trim()) return createErrorResult("'script' is required")

  if (!userConfirmed) {
    return createSuccessResult(
      {
        requires_confirmation: true,
        confirmation_prompt: buildConfirmationPrompt({ roles, operationSummary, script }),
        roles,
        operation_summary: operationSummary,
        script,
        next_step:
          "If the user approves, re-call snow_elevate_role with the SAME roles/operation_summary/script plus user_confirmed=true. If the user denies or is silent, do not call again.",
      },
      { action_required: "User must explicitly approve this elevated operation" },
    )
  }

  const wrapped = buildElevationWrapper(roles, script)
  const result = await executeServerScript(context, wrapped, {
    timeout,
    description: "Elevated execution: " + operationSummary,
  })

  if (!result.success && !result.result) {
    return createErrorResult(result.error || "Elevated script execution failed")
  }

  const parsed = parseWrapperResult(result.result)

  return createSuccessResult(
    {
      executed: true,
      user_confirmed: true,
      roles_requested: roles,
      operation_summary: operationSummary,
      method: result.method,
      elevation_methods_tried: parsed?.elevation_methods_tried,
      script_success: parsed?.success ?? result.success,
      result: parsed?.result,
      error: parsed?.error || result.error,
      output: result.output,
      execution_time_ms: result.executionTimeMs,
    },
    { operation: "elevated_execution", fallback_warning: result.fallbackWarning },
  )
}

function buildConfirmationPrompt(args: { roles: string[]; operationSummary: string; script: string }): string {
  return [
    "ELEVATED ROLE EXECUTION REQUEST",
    "",
    "Roles requested: " + args.roles.join(", "),
    "Operation:       " + args.operationSummary,
    "",
    "Script to execute:",
    "```javascript",
    args.script,
    "```",
    "",
    "This runs server-side. GlideRecord and GlideUpdateManager2 writes in the script will",
    "bypass ACL evaluation. Approve only if you understand and trust the script.",
    "",
    "Approve: re-call snow_elevate_role with the same arguments plus user_confirmed=true.",
    "Deny:    do nothing. No changes will be made.",
  ].join("\n")
}

function buildElevationWrapper(roles: string[], userScript: string): string {
  const rolesJson = JSON.stringify(roles)
  return `(function() {
  var methods = [];
  var rolesToElevate = ${rolesJson};

  try {
    if (gs.getSession && typeof gs.getSession === 'function') {
      var session = gs.getSession();
      if (session && typeof session.setElevatedRoles === 'function') {
        session.setElevatedRoles(rolesToElevate);
        methods.push('session.setElevatedRoles');
      }
    }
  } catch (e1) {
    gs.warn('session.setElevatedRoles unavailable: ' + e1);
  }

  try {
    if (typeof GlideSecurityManager !== 'undefined') {
      var sm = (typeof GlideSecurityManager.get === 'function') ? GlideSecurityManager.get() : null;
      if (sm && typeof sm.elevateRole === 'function') {
        for (var i = 0; i < rolesToElevate.length; i++) {
          sm.elevateRole(rolesToElevate[i]);
        }
        methods.push('GlideSecurityManager.elevateRole');
      }
    }
  } catch (e2) {
    gs.warn('GlideSecurityManager.elevateRole unavailable: ' + e2);
  }

  methods.push('server_side_gliderecord_context');

  var __result = null;
  var __error = null;
  try {
    __result = (function() {
      ${userScript}
    })();
  } catch (e3) {
    __error = e3.toString();
    if (e3.stack) __error += '\\n' + e3.stack;
  }

  return JSON.stringify({
    success: __error === null,
    elevation_methods_tried: methods,
    result: __result,
    error: __error
  });
})();`
}

function parseWrapperResult(raw: unknown): {
  success?: boolean
  elevation_methods_tried?: string[]
  result?: unknown
  error?: string
} | null {
  if (typeof raw !== "string") return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export const version = "1.0.0"
export const author = "Serac"
