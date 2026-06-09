/**
 * snow_check_health
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_check_health",
  description: "Check ServiceNow instance health",
  // Metadata for tool discovery (not sent to LLM)
  category: "advanced",
  subcategory: "monitoring",
  use_cases: ["health-check", "monitoring", "diagnostics"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {},
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const client = await getAuthenticatedClient(context)
    const startTime = Date.now()
    await client.get("/api/now/table/sys_user", { params: { sysparm_limit: 1 } })
    const responseTime = Date.now() - startTime

    return createSuccessResult({
      healthy: true,
      response_time_ms: responseTime,
      status: responseTime < 1000 ? "good" : responseTime < 3000 ? "fair" : "slow",
    })
  } catch (error: any) {
    const msg = error.message || ""
    const status = error.response?.status

    // Detect hibernating instance
    if (
      status === 502 || status === 503
      || msg.includes("ECONNREFUSED")
      || msg.includes("ETIMEDOUT")
      || msg.includes("socket hang up")
      || (msg.includes("Failed to obtain access token") && !msg.includes("Invalid credentials"))
    ) {
      return createErrorResult(
        `ServiceNow instance appears to be hibernating or starting up.\n\n` +
        `Developer instances automatically hibernate after periods of inactivity. ` +
        `To wake it up:\n` +
        `1. Open your instance URL in a browser: ${context.instanceUrl}\n` +
        `2. Wait 1-2 minutes for it to fully start\n` +
        `3. Try this command again\n\n` +
        `Technical detail: ${status ? `HTTP ${status}` : msg}`
      )
    }

    // Detect auth issues separately
    if (msg.includes("Failed to obtain access token") || status === 401) {
      return createErrorResult(
        `Authentication failed. Your access token may be expired.\n\n` +
        `Run: serac auth login\n\n` +
        `If you've already logged in, check: serac auth status`
      )
    }

    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
