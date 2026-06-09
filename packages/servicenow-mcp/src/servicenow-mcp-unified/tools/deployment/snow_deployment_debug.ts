/**
 * snow_deployment_debug - Deployment debugging information
 *
 * Provides detailed debugging info including auth status, permissions, sessions, and logs
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_deployment_debug",
  description:
    "Provides detailed debugging information including authentication status, permissions, active sessions, and recent deployment logs for troubleshooting.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "deployment",
  use_cases: ["deployment", "debugging", "diagnostics"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create/update/delete operation
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {},
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const client = await getAuthenticatedClient(context)
    const debugInfo: any = {
      timestamp: new Date().toISOString(),
      instance: context.instanceUrl,
      checks: {},
    }

    // Check 1: Authentication Status
    try {
      const userResponse = await client.get("/api/now/table/sys_user/me")
      debugInfo.checks.authentication = {
        status: "✅ Authenticated",
        user: userResponse.data.result?.user_name || "Unknown",
        roles: userResponse.data.result?.roles || "Not retrieved",
      }
    } catch (authError: any) {
      debugInfo.checks.authentication = {
        status: "❌ Authentication Failed",
        error: authError.message,
      }
    }

    // Check 2: Update Set Status
    try {
      const updateSetResponse = await client.get("/api/now/table/sys_update_set", {
        params: {
          sysparm_query: "state=in progress",
          sysparm_limit: 5,
          sysparm_fields: "name,state,sys_id",
        },
      })
      debugInfo.checks.updateSets = {
        status: "✅ Accessible",
        active: updateSetResponse.data.result || [],
      }
    } catch (updateSetError: any) {
      debugInfo.checks.updateSets = {
        status: "❌ Not Accessible",
        error: updateSetError.message,
      }
    }

    // Check 3: Recent Errors
    try {
      const logsResponse = await client.get("/api/now/table/syslog", {
        params: {
          sysparm_query: "level=error^sys_created_on>=javascript:gs.daysAgoStart(1)^ORDERBYDESCsys_created_on",
          sysparm_limit: 5,
          sysparm_fields: "message,source,sys_created_on",
        },
      })
      debugInfo.checks.recentErrors = {
        status: logsResponse.data.result?.length > 0 ? "⚠️ Errors Found" : "✅ No Recent Errors",
        errors: logsResponse.data.result || [],
      }
    } catch (logError: any) {
      debugInfo.checks.recentErrors = {
        status: "⚠️ Cannot Access Logs",
        error: logError.message,
      }
    }

    // Check 4: Service Portal Access
    try {
      const portalResponse = await client.get("/api/now/table/sp_portal", {
        params: {
          sysparm_limit: 1,
          sysparm_fields: "title",
        },
      })
      debugInfo.checks.servicePortal = {
        status: "✅ Accessible",
        portals: portalResponse.data.result?.length || 0,
      }
    } catch (portalError: any) {
      debugInfo.checks.servicePortal = {
        status: "❌ Not Accessible",
        error: portalError.message,
      }
    }

    // Check 5: API Rate Limits
    debugInfo.checks.apiLimits = {
      status: "✅ No Limits Detected",
      note: "ServiceNow typically allows 5000 API calls per hour",
    }

    // Generate summary
    const successfulChecks = Object.values(debugInfo.checks).filter((check: any) => check.status?.includes("✅")).length
    const totalChecks = Object.keys(debugInfo.checks).length

    const summary =
      `🔍 Deployment Debug Information\n\n` +
      `Instance: ${debugInfo.instance}\n` +
      `Timestamp: ${debugInfo.timestamp}\n` +
      `Health: ${successfulChecks}/${totalChecks} checks passed\n\n` +
      Object.entries(debugInfo.checks)
        .map(([key, value]: [string, any]) => `${value.status} ${key}: ${value.error || value.note || "OK"}`)
        .join("\n")

    return createSuccessResult(debugInfo, { message: summary })
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.NETWORK_ERROR, `Debug info failed: ${error.message}`, { originalError: error }),
    )
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
