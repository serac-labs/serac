/**
 * snow_redeploy_script_endpoint
 *
 * Escape hatch when the Scripted REST executor endpoint that snow_execute_script
 * and the UI-policy tools depend on is stuck — typically because the existing
 * sys_ws_definition or sys_ws_operation was renamed, deactivated, or deleted
 * out from under the auto-deploy. Forces a clean re-deploy and reports every
 * step of the process so failures are actionable.
 *
 * Does three things:
 *   1. Clears the in-memory endpoint cache for this instance.
 *   2. Optionally deletes the existing sys_ws_definition + sys_ws_operation
 *      records (hard reset).
 *   3. Calls ensureEndpointDiagnosed() to deploy fresh and return the URL
 *      where the endpoint is now live (or the diagnostics that explain why
 *      it couldn't be deployed).
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import { ensureEndpointDiagnosed, resetEndpointCache } from "../../shared/scripted-exec.js"

const ENDPOINT_SERVICE_ID = "snow_flow_exec"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_redeploy_script_endpoint",
  description:
    "Force-redeploy the Serac scripted REST executor endpoint (/api/snow_flow_exec/execute). Use when snow_execute_script / UI policy tools fail with 'Requested URI does not represent any resource'. Clears the in-memory cache and runs the auto-deploy with full diagnostics. Set hard_reset=true to delete and recreate the existing definition + operation records.",
  category: "automation",
  subcategory: "script-execution",
  use_cases: ["endpoint-redeploy", "diagnostics", "script-execution"],
  complexity: "advanced",
  frequency: "low",
  permission: "admin",
  allowedRoles: ["admin"],
  inputSchema: {
    type: "object",
    properties: {
      hard_reset: {
        type: "boolean",
        description:
          "If true, deletes the existing sys_ws_definition + sys_ws_operation records before redeploying. Use only when a soft redeploy (default) doesn't recover the endpoint.",
        default: false,
      },
    },
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const hardReset = args.hard_reset === true
  const diagnostics: string[] = []

  try {
    const client = await getAuthenticatedClient(context)
    resetEndpointCache(context)
    diagnostics.push("in-memory endpoint cache cleared")

    if (hardReset) {
      const existing = await client
        .get("/api/now/table/sys_ws_definition", {
          params: {
            sysparm_query: `service_id=${ENDPOINT_SERVICE_ID}`,
            sysparm_fields: "sys_id",
            sysparm_limit: 1,
          },
        })
        .catch(() => null)

      const svcId = existing?.data?.result?.[0]?.sys_id
      if (svcId) {
        diagnostics.push(`hard reset: deleting operations for definition ${svcId}`)
        const ops = await client
          .get("/api/now/table/sys_ws_operation", {
            params: {
              sysparm_query: `web_service_definition=${svcId}`,
              sysparm_fields: "sys_id",
              sysparm_limit: 50,
            },
          })
          .catch(() => null)
        const opRecords = (ops?.data?.result ?? []) as Array<{ sys_id?: string }>
        for (const op of opRecords) {
          if (!op.sys_id) continue
          await client
            .delete("/api/now/table/sys_ws_operation/" + op.sys_id)
            .catch(() => diagnostics.push(`  - failed to delete operation ${op.sys_id}`))
        }
        diagnostics.push(`hard reset: deleted ${opRecords.length} operation record(s)`)
        await client
          .delete("/api/now/table/sys_ws_definition/" + svcId)
          .catch(() => diagnostics.push(`hard reset: failed to delete definition ${svcId}`))
        diagnostics.push(`hard reset: deleted definition ${svcId}`)
      } else {
        diagnostics.push("hard reset: no existing definition found — nothing to delete")
      }
    }

    const result = await ensureEndpointDiagnosed(context)
    diagnostics.push(...result.diagnostics)

    if (!result.ok) {
      return createErrorResult(
        "Endpoint redeploy did not succeed. See diagnostics for the failing step:\n" +
          diagnostics.map((d) => "  - " + d).join("\n"),
      )
    }

    return createSuccessResult({
      redeployed: true,
      hard_reset: hardReset,
      endpoint_url: result.url,
      diagnostics,
      next_steps: [
        "Re-run your failing snow_execute_script / snow_create_ui_policy / snow_elevate_role call",
        "If it still fails, call this tool again with hard_reset=true",
      ],
    })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    return createErrorResult("Endpoint redeploy crashed: " + msg + "\nDiagnostics:\n" + diagnostics.join("\n"))
  }
}

export const version = "1.0.0"
export const author = "Serac"
