/**
 * snow_validate_workspace_configuration - Validate workspace config
 *
 * Validate workspace configuration for completeness, best practices,
 * and potential issues across all workspace types.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_validate_workspace_configuration",
  description:
    "Validate workspace configuration for completeness, best practices, and potential issues across all workspace types.",
  // Metadata for tool discovery (not sent to LLM)
  category: "ui-frameworks",
  subcategory: "workspace",
  use_cases: ["workspace", "validation", "quality"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      workspace_sys_id: {
        type: "string",
        description: "Workspace sys_id to validate",
      },
      workspace_type: {
        type: "string",
        enum: ["ux_experience", "agent_workspace", "ui_builder"],
        description: "Type of workspace to validate",
      },
      check_performance: {
        type: "boolean",
        default: true,
        description: "Include performance analysis",
      },
      check_security: {
        type: "boolean",
        default: true,
        description: "Include security validation",
      },
    },
    required: ["workspace_sys_id", "workspace_type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { workspace_sys_id, workspace_type, check_performance = true, check_security = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    const validation = {
      workspace_sys_id,
      workspace_type,
      issues: [] as string[],
      warnings: [] as string[],
      recommendations: [] as string[],
      score: 0,
      max_score: 100,
    }

    if (workspace_type === "ux_experience") {
      // Validate UX Experience workspace
      const experienceResponse = await client.get(`/api/now/table/sys_ux_experience/${workspace_sys_id}`)

      if (!experienceResponse.data.result) {
        throw new SnowFlowError(ErrorType.VALIDATION_ERROR, `Experience '${workspace_sys_id}' not found`, {
          details: { workspace_sys_id },
        })
      }

      const expData = experienceResponse.data.result

      // Check if experience is active
      if (!expData.active) {
        validation.issues.push("Experience is not active")
      } else {
        validation.score += 25
      }

      // Check if it has app config
      const appConfigResponse = await client.get("/api/now/table/sys_ux_app_config", {
        params: {
          sysparm_query: `experience_assoc=${workspace_sys_id}`,
          sysparm_limit: 1,
        },
      })

      if (!appConfigResponse.data.result || appConfigResponse.data.result.length === 0) {
        validation.issues.push("No app configuration found for experience")
      } else {
        validation.score += 25

        // Check if app config has list configuration
        const appConfig = appConfigResponse.data.result[0]
        if (!appConfig.list_config_id) {
          validation.warnings.push("No list configuration linked to app config")
        } else {
          validation.score += 25
        }
      }

      // Check for page properties
      const pagePropsResponse = await client.get("/api/now/table/sys_ux_page_property", {
        params: {
          sysparm_query: `experience=${workspace_sys_id}`,
          sysparm_limit: 10,
        },
      })

      if (pagePropsResponse.data.result && pagePropsResponse.data.result.length > 0) {
        validation.score += 25
      } else {
        validation.warnings.push("No page properties configured (chrome_tab, chrome_main)")
      }
    } else if (workspace_type === "agent_workspace") {
      // Validate Agent Workspace
      const routeResponse = await client.get(`/api/now/table/sys_ux_app_route/${workspace_sys_id}`)

      if (!routeResponse.data.result) {
        throw new SnowFlowError(ErrorType.VALIDATION_ERROR, `Agent Workspace route '${workspace_sys_id}' not found`, {
          details: { workspace_sys_id },
        })
      }

      const routeData = routeResponse.data.result

      // Check if route is active
      if (!routeData.active) {
        validation.issues.push("Workspace route is not active")
      } else {
        validation.score += 30
      }

      // Check for screen types
      const screenTypesResponse = await client.get("/api/now/table/sys_ux_screen_type", {
        params: {
          sysparm_query: `app_route=${workspace_sys_id}`,
          sysparm_limit: 10,
        },
      })

      if (screenTypesResponse.data.result && screenTypesResponse.data.result.length > 0) {
        validation.score += 40
        if (screenTypesResponse.data.result.length === 1) {
          validation.warnings.push("Only one screen type configured - consider adding more for better functionality")
        }
      } else {
        validation.issues.push("No screen types configured for agent workspace")
      }

      // Check route format
      if (!routeData.route || !routeData.route.startsWith("/")) {
        validation.warnings.push("Route format should start with /")
      } else {
        validation.score += 30
      }
    } else if (workspace_type === "ui_builder") {
      // Validate UI Builder page
      const pageResponse = await client.get(`/api/now/table/sys_ux_page/${workspace_sys_id}`)

      if (!pageResponse.data.result) {
        throw new SnowFlowError(ErrorType.VALIDATION_ERROR, `UI Builder page '${workspace_sys_id}' not found`, {
          details: { workspace_sys_id },
        })
      }

      const pageData = pageResponse.data.result

      if (!pageData.active) {
        validation.issues.push("UI Builder page is not active")
      } else {
        validation.score += 50
      }

      if (pageData.name && pageData.title) {
        validation.score += 50
      } else {
        validation.warnings.push("Page should have both name and title configured")
      }
    }

    // Performance recommendations
    if (check_performance && validation.score > 50) {
      validation.recommendations.push("Consider enabling caching for better performance")
      validation.recommendations.push("Add loading indicators for better user experience")
      validation.recommendations.push("Optimize queries to reduce page load time")
    }

    // Security recommendations
    if (check_security) {
      validation.recommendations.push("Review access controls and role requirements")
      validation.recommendations.push("Validate data privacy settings for workspace")
      validation.recommendations.push("Ensure sensitive data is properly masked")
    }

    // Overall status
    let status = "excellent"
    if (validation.issues.length > 0) {
      status = "critical"
    } else if (validation.warnings.length > 2) {
      status = "needs_improvement"
    } else if (validation.score < 75) {
      status = "good"
    }

    return createSuccessResult({
      validation: {
        ...validation,
        status,
        passed: validation.issues.length === 0,
      },
      summary: {
        score: `${validation.score}/${validation.max_score}`,
        status,
        issues_count: validation.issues.length,
        warnings_count: validation.warnings.length,
        recommendations_count: validation.recommendations.length,
      },
      message:
        validation.issues.length === 0
          ? `Workspace validation passed with score ${validation.score}/${validation.max_score}`
          : `Workspace validation found ${validation.issues.length} critical issues`,
    })
  } catch (error: any) {
    return createErrorResult(error instanceof SnowFlowError ? error : error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
