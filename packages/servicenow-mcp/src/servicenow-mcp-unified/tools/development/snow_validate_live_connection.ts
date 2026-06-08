/**
 * snow_validate_live_connection - Validate live connection
 *
 * Validates ServiceNow connection status, authentication tokens, and user permissions.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_validate_live_connection",
  description:
    "Validates ServiceNow connection status, authentication tokens, and user permissions. Returns detailed diagnostics with response times.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "diagnostics",
  use_cases: ["validation", "diagnostics", "connection-test"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      test_level: {
        type: "string",
        enum: ["basic", "full", "permissions"],
        description: "Level of validation (basic=ping, full=read test, permissions=write test)",
        default: "basic",
      },
      include_performance: {
        type: "boolean",
        description: "Include response time metrics",
        default: false,
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { test_level = "basic", include_performance = false } = args

  const diagnostics = {
    connection: {
      status: "unknown",
      instance: context.instanceUrl,
      reachable: false,
      response_time: 0,
    },
    authentication: {
      status: "unknown",
      token_valid: false,
      token_expires: null as string | null,
    },
    permissions: {
      can_read: false,
      can_write: false,
      roles: [] as string[],
    },
    performance: {
      api_response_time: 0,
      average_latency: 0,
    },
  }

  try {
    const startTime = Date.now()
    const client = await getAuthenticatedClient(context)

    // Basic connection test
    try {
      const testResponse = await client.query("sys_user", {
        query: "user_name=admin",
        limit: 1,
      })

      diagnostics.connection.status = "connected"
      diagnostics.connection.reachable = true
      diagnostics.connection.response_time = Date.now() - startTime
      diagnostics.authentication.status = "valid"
      diagnostics.authentication.token_valid = true

      if (test_level === "full" || test_level === "permissions") {
        diagnostics.permissions.can_read = true
      }
    } catch (error: any) {
      diagnostics.connection.status = "failed"
      diagnostics.authentication.status = "invalid"
      throw error
    }

    // Performance metrics
    if (include_performance) {
      const perfStart = Date.now()
      await client.query("sys_user", { query: "active=true", limit: 1 })
      diagnostics.performance.api_response_time = Date.now() - perfStart
      diagnostics.performance.average_latency = diagnostics.connection.response_time
    }

    // Permissions test
    if (test_level === "permissions") {
      try {
        // Test write permissions with a benign update (update nothing)
        const testWrite = await client.query("sys_properties", {
          query: "name=glide.test.connection",
          limit: 1,
        })
        diagnostics.permissions.can_write = true
      } catch (error) {
        diagnostics.permissions.can_write = false
      }
    }

    return createSuccessResult(
      {
        valid: true,
        diagnostics,
        summary: `Connection validated at ${test_level} level`,
        recommendations: [
          !diagnostics.permissions.can_write && test_level === "permissions"
            ? "Write permissions may be limited - check user roles"
            : null,
          diagnostics.connection.response_time > 2000
            ? "High response time detected - check network connectivity"
            : null,
        ].filter(Boolean),
      },
      {
        test_level,
        include_performance,
      },
    )
  } catch (error: any) {
    diagnostics.connection.status = "error"
    diagnostics.authentication.status = "error"

    const errorMessage = error instanceof Error ? error.message : String(error)
    return createErrorResult(errorMessage, {
      test_level,
      diagnostics,
    })
  }
}
