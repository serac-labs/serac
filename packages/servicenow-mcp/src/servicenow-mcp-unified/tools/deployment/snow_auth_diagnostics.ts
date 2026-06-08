/**
 * snow_auth_diagnostics - Comprehensive authentication and permission diagnostics
 *
 * Tests OAuth tokens, API access, table permissions, and provides remediation steps
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_auth_diagnostics",
  description:
    "Performs comprehensive authentication and permission diagnostics. Tests OAuth tokens, API access, table permissions, and provides specific remediation steps.",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "deployment",
  use_cases: ["deployment", "diagnostics", "authentication"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      run_write_test: {
        type: "boolean",
        description: "Test widget write permissions (creates and deletes test widget)",
        default: true,
      },
      include_recommendations: {
        type: "boolean",
        description: "Include troubleshooting recommendations",
        default: true,
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { run_write_test = true, include_recommendations = true } = args

  try {
    const client = await getAuthenticatedClient(context)
    const realApiTests: any = {}

    // Test 1: Basic System Properties API call
    try {
      const systemResponse = await client.get("/api/now/table/sys_properties", {
        params: {
          sysparm_query: "name=glide.servlet.uri",
          sysparm_limit: 1,
        },
      })
      realApiTests.systemPropertiesAccess = {
        status: "✅ Success",
        description: "Can read system properties",
        details: systemResponse.data.result ? "System API accessible" : "No results returned",
      }
    } catch (systemError: any) {
      realApiTests.systemPropertiesAccess = {
        status: "❌ Failed",
        description: "Cannot access system properties",
        error: systemError.message,
      }
    }

    // Test 2: User Table Access
    try {
      const userResponse = await client.get("/api/now/table/sys_user", {
        params: {
          sysparm_limit: 1,
          sysparm_fields: "sys_id,user_name",
        },
      })
      realApiTests.userTableAccess = {
        status: "✅ Success",
        description: "Can access user table",
        details:
          userResponse.data.result?.length > 0
            ? `Found ${userResponse.data.result.length} user records`
            : "No users found",
      }
    } catch (userError: any) {
      realApiTests.userTableAccess = {
        status: "❌ Failed",
        description: "Cannot access user table",
        error: userError.message,
      }
    }

    // Test 3: Update Set Table Access (critical for deployments)
    try {
      const updateSetResponse = await client.get("/api/now/table/sys_update_set", {
        params: {
          sysparm_limit: 1,
          sysparm_fields: "name,state",
        },
      })
      realApiTests.updateSetAccess = {
        status: "✅ Success",
        description: "Can access Update Sets (deployment ready)",
        details:
          updateSetResponse.data.result?.length > 0
            ? `Found ${updateSetResponse.data.result.length} update sets`
            : "No update sets found",
      }
    } catch (updateSetError: any) {
      realApiTests.updateSetAccess = {
        status: "❌ Critical",
        description: "Cannot access Update Sets - deployments will fail!",
        error: updateSetError.message,
      }
    }

    // Test 4: Service Portal Widget Access (for widget deployments)
    try {
      const widgetResponse = await client.get("/api/now/table/sp_widget", {
        params: {
          sysparm_limit: 1,
          sysparm_fields: "name,title",
        },
      })
      realApiTests.widgetTableAccess = {
        status: "✅ Success",
        description: "Can access Service Portal widgets",
        details:
          widgetResponse.data.result?.length > 0
            ? `Found ${widgetResponse.data.result.length} widgets`
            : "No widgets found",
      }
    } catch (widgetError: any) {
      realApiTests.widgetTableAccess = {
        status: "⚠️ Limited",
        description: "Cannot access Service Portal - widget deployments may fail",
        error: widgetError.message,
      }
    }

    // Test 5: Write Permissions Test (create a test record)
    if (run_write_test) {
      try {
        const testWidget = {
          name: "serac_connectivity_test",
          title: "Serac Connectivity Test",
          template: "<div>Test widget - safe to delete</div>",
          description: "Temporary test widget created by Serac MCP diagnostics",
        }

        const createResponse = await client.post("/api/now/table/sp_widget", testWidget)

        if (createResponse.data.result?.sys_id) {
          const testSysId = createResponse.data.result.sys_id
          // Immediately delete the test widget
          try {
            await client.delete(`/api/now/table/sp_widget/${testSysId}`)
            realApiTests.writePermissions = {
              status: "✅ Full Access",
              description: "Can create and delete artifacts - full deployment capability",
              details: `Successfully created and cleaned up test widget ${testSysId}`,
            }
          } catch (deleteError: any) {
            realApiTests.writePermissions = {
              status: "⚠️ Partial",
              description: "Can create but cannot delete - cleanup may be needed",
              details: `Created test widget ${testSysId} but failed to delete: ${deleteError.message}`,
            }
          }
        }
      } catch (writeError: any) {
        realApiTests.writePermissions = {
          status: "❌ Read-Only",
          description: "Cannot create artifacts - deployments will fail",
          error: writeError.message,
        }
      }
    }

    // Determine overall success
    const successCount = Object.values(realApiTests).filter((test: any) => test.status.includes("✅")).length
    const totalTests = Object.keys(realApiTests).length
    const recommendations: string[] = []

    // Add specific recommendations based on test results
    if (include_recommendations) {
      if (realApiTests.updateSetAccess?.status?.includes("❌")) {
        recommendations.push("Critical: Fix Update Set access for deployment capability")
      }
      if (realApiTests.writePermissions?.status?.includes("❌")) {
        recommendations.push("Request write permissions for artifact creation")
      }
      if (realApiTests.systemPropertiesAccess?.status?.includes("❌")) {
        recommendations.push("Basic API access failed - check authentication and network")
      }
    }

    return createSuccessResult(
      {
        tests: realApiTests,
        summary: {
          successCount,
          totalTests,
          successRate: Math.round((successCount / totalTests) * 100),
        },
        recommendations,
        timestamp: new Date().toISOString(),
        instance_url: context.instanceUrl,
      },
      {
        message: `🔐 Authentication Diagnostics Complete\n\nTests Passed: ${successCount}/${totalTests} (${Math.round((successCount / totalTests) * 100)}%)\n\n${Object.entries(
          realApiTests,
        )
          .map(([key, value]: [string, any]) => `${value.status} ${key}: ${value.description}`)
          .join(
            "\n",
          )}\n\n${recommendations.length > 0 ? "💡 Recommendations:\n" + recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n") : "✅ All checks passed!"}`,
      },
    )
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.UNAUTHORIZED, `Auth diagnostics failed: ${error.message}`, {
            originalError: error,
          }),
    )
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
