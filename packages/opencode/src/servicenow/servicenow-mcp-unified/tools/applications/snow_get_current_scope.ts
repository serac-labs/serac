/**
 * snow_get_current_scope - Get Current Application Scope
 *
 * Returns the current application scope for the OAuth service account,
 * including details about the scope and the active Update Set.
 *
 * Useful for verifying which scope you're working in before creating artifacts.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_current_scope",
  description: `Get the current application scope and active Update Set.

🔍 USE THIS TO:
- Verify which scope you're currently working in before creating artifacts
- Check if you have an active Update Set in the current scope
- Understand the development context before starting work

📋 RETURNS:
- Current application scope (name, sys_id, scope prefix)
- Whether it's global or a scoped application
- Current active Update Set (if any)
- Recommendations for next steps`,
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "applications",
  use_cases: ["app-development", "scoped-apps", "development", "context-check"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Query only, no modifications
  permission: "read",
  allowedRoles: ["developer", "admin", "stakeholder"],
  inputSchema: {
    type: "object",
    properties: {
      include_update_set: {
        type: "boolean",
        description: "Include information about the current Update Set (default: true)",
        default: true,
      },
      include_recent_artifacts: {
        type: "boolean",
        description: "Include count of recent artifacts created in current scope (default: false)",
        default: false,
      },
    },
    required: [],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { include_update_set = true, include_recent_artifacts = false } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Get current scope preference
    const scopePrefResponse = await client.get("/api/now/table/sys_user_preference", {
      params: {
        sysparm_query: "name=sys_scope^user=javascript:gs.getUserID()",
        sysparm_fields: "value",
        sysparm_limit: 1,
      },
    })

    let currentScope: any = {
      sys_id: "global",
      name: "Global",
      scope: "global",
      is_global: true,
    }

    // If we have a scope preference, look up the application details
    if (scopePrefResponse.data.result && scopePrefResponse.data.result.length > 0) {
      const scopeValue = scopePrefResponse.data.result[0].value

      if (scopeValue && scopeValue !== "global") {
        // Look up the application
        const appResponse = await client.get(`/api/now/table/sys_app/${scopeValue}`, {
          params: {
            sysparm_fields: "sys_id,name,scope,version,short_description,vendor,active",
          },
        })

        if (appResponse.data.result) {
          const app = appResponse.data.result
          currentScope = {
            sys_id: app.sys_id,
            name: app.name,
            scope: app.scope,
            version: app.version || null,
            short_description: app.short_description || null,
            vendor: app.vendor || null,
            is_global: false,
            is_active: app.active === "true" || app.active === true,
          }
        }
      }
    }

    // Build result
    const result: any = {
      current_scope: currentScope,
      update_set: null,
      recommendations: [],
    }

    // Get current Update Set if requested
    if (include_update_set) {
      const updateSetPrefResponse = await client.get("/api/now/table/sys_user_preference", {
        params: {
          sysparm_query: "name=sys_update_set^user=javascript:gs.getUserID()",
          sysparm_fields: "value",
          sysparm_limit: 1,
        },
      })

      if (updateSetPrefResponse.data.result && updateSetPrefResponse.data.result.length > 0) {
        const updateSetId = updateSetPrefResponse.data.result[0].value

        if (updateSetId) {
          const updateSetResponse = await client.get(`/api/now/table/sys_update_set/${updateSetId}`, {
            params: {
              sysparm_fields: "sys_id,name,description,state,application,sys_created_on",
            },
          })

          if (updateSetResponse.data.result) {
            const us = updateSetResponse.data.result

            // Get application name for the Update Set
            let usAppName = "Global"
            let usAppScope = "global"
            if (us.application && us.application !== "global") {
              try {
                const usAppResponse = await client.get(`/api/now/table/sys_app/${us.application}`, {
                  params: {
                    sysparm_fields: "name,scope",
                  },
                })
                if (usAppResponse.data.result) {
                  usAppName = usAppResponse.data.result.name
                  usAppScope = usAppResponse.data.result.scope
                }
              } catch (e) {
                // Ignore - might be global
              }
            }

            result.update_set = {
              sys_id: us.sys_id,
              name: us.name,
              description: us.description || null,
              state: us.state,
              created_at: us.sys_created_on,
              application: {
                sys_id: us.application || "global",
                name: usAppName,
                scope: usAppScope,
              },
              scope_matches:
                us.application === currentScope.sys_id || (us.application === "global" && currentScope.is_global),
            }

            // Check for scope mismatch - this is informational, not blocking
            if (!result.update_set.scope_matches) {
              result.recommendations.push(
                `ℹ️ Note: Current scope is "${currentScope.name}" but Update Set "${us.name}" is in "${usAppName}". ` +
                  `This is fine for global artifacts. If you need scoped artifacts, switch scope first.`,
              )
            }
          }
        }
      }

      if (!result.update_set) {
        result.recommendations.push(
          "⚠️ No active Update Set! Create one with snow_update_set_manage before making changes.",
        )
      }
    }

    // Get recent artifact count if requested
    if (include_recent_artifacts && !currentScope.is_global) {
      try {
        // Count artifacts in the current scope from the last 24 hours
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

        const artifactCountResponse = await client.get("/api/now/table/sys_metadata", {
          params: {
            sysparm_query: `sys_scope=${currentScope.sys_id}^sys_created_on>=${oneDayAgo}`,
            sysparm_fields: "sys_id",
            sysparm_limit: 100,
          },
        })

        result.recent_artifacts = {
          count: artifactCountResponse.data.result?.length || 0,
          period: "last 24 hours",
          scope: currentScope.scope,
        }
      } catch (e) {
        // Ignore - optional feature
      }
    }

    // Add general recommendations
    if (currentScope.is_global) {
      result.recommendations.push(
        "You are in Global scope. Artifacts created will be available across all applications.",
      )
      result.recommendations.push("Consider creating a scoped application if building a complete feature set.")
    } else {
      result.recommendations.push(
        `You are in "${currentScope.name}" scope (${currentScope.scope}). ` +
          `Artifacts created will belong to this application.`,
      )
    }

    // Build summary message
    let message = `Current scope: ${currentScope.is_global ? "Global" : `"${currentScope.name}" (${currentScope.scope})`}`
    if (result.update_set) {
      message += ` | Update Set: "${result.update_set.name}" (${result.update_set.state})`
      if (!result.update_set.scope_matches) {
        message += ` (Update Set in ${result.update_set.application.name} - OK for global artifacts)`
      }
    } else {
      message += " | No active Update Set"
    }
    result.message = message

    // Add explicit "ready to proceed" indicator to prevent agent loops
    result.ready_to_proceed = true
    result.status = "ok"

    return createSuccessResult(result)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Application Scope Enhancement"
