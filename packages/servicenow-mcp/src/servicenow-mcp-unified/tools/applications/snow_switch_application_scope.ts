/**
 * snow_switch_application_scope - Switch Application Scope
 *
 * Switches the current application scope for development. This determines
 * which application context artifacts will be created in.
 *
 * In ServiceNow, application scope controls:
 * - Which application artifacts belong to
 * - Access control and permissions
 * - Update Set tracking
 * - Cross-scope access rules
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_switch_application_scope",
  description: `Switch the current application scope for the OAuth service account by writing to sys_user_preference (name=sys_scope). All NEW artifacts created after the switch belong to that scope; existing artifacts stay in their original scope.

Resolves the target by trying, in order: sys_id, scope name (e.g. "x_myco_hr_portal"), application name. Pass "global" for the cross-application/system-wide scope.

Tracking: the active Update Set should match the target scope. Set create_update_set=true to bootstrap a matching one in the same call (named "Development: <app_name>" by default), otherwise switch the Update Set separately via snow_update_set_manage.`,
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "applications",
  use_cases: ["app-development", "scoped-apps", "development", "scope-management"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Modifies user preferences
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        description:
          'Target scope to switch to. Can be "global", application sys_id, scope name (e.g., "x_myco_app"), or application name.',
      },
      create_update_set: {
        type: "boolean",
        description:
          "Create a new Update Set in the target scope (default: false). Useful when starting new development work.",
        default: false,
      },
      update_set_name: {
        type: "string",
        description: 'Name for the new Update Set (if create_update_set=true). Defaults to "Development: <app_name>"',
      },
      update_set_description: {
        type: "string",
        description: "Description for the new Update Set (if create_update_set=true)",
      },
      servicenow_username: {
        type: "string",
        description: "Optional: Also switch scope for this ServiceNow user (for UI visibility)",
      },
    },
    required: ["scope"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { scope, create_update_set = false, update_set_name, update_set_description, servicenow_username } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Resolve the target scope
    let targetApplicationId: string
    let targetApplicationName: string
    let targetApplicationScope: string
    let isGlobal = false

    if (scope === "global" || scope === "Global" || !scope) {
      targetApplicationId = "global"
      targetApplicationName = "Global"
      targetApplicationScope = "global"
      isGlobal = true
    } else {
      // Try to find by sys_id first
      let appResponse = await client.get("/api/now/table/sys_app", {
        params: {
          sysparm_query: `sys_id=${scope}`,
          sysparm_fields: "sys_id,name,scope,version,short_description",
          sysparm_limit: 1,
        },
      })

      // Try by scope name
      if (!appResponse.data.result || appResponse.data.result.length === 0) {
        appResponse = await client.get("/api/now/table/sys_app", {
          params: {
            sysparm_query: `scope=${scope}`,
            sysparm_fields: "sys_id,name,scope,version,short_description",
            sysparm_limit: 1,
          },
        })
      }

      // Try by name
      if (!appResponse.data.result || appResponse.data.result.length === 0) {
        appResponse = await client.get("/api/now/table/sys_app", {
          params: {
            sysparm_query: `name=${scope}`,
            sysparm_fields: "sys_id,name,scope,version,short_description",
            sysparm_limit: 1,
          },
        })
      }

      if (!appResponse.data.result || appResponse.data.result.length === 0) {
        // List available applications for helpful error message
        const availableApps = await client.get("/api/now/table/sys_app", {
          params: {
            sysparm_fields: "name,scope",
            sysparm_limit: 10,
            sysparm_query: "active=true",
          },
        })

        const appList =
          availableApps.data.result?.map((app: any) => `  - "${app.name}" (${app.scope})`).join("\n") ||
          "  (no applications found)"

        return createErrorResult(
          `Application not found: "${scope}"\n\n` +
            `Available options:\n` +
            `  - "global" (Global scope)\n` +
            `${appList}\n\n` +
            `Provide a valid application sys_id, scope name, or application name.`,
        )
      }

      const app = appResponse.data.result[0]
      targetApplicationId = app.sys_id
      targetApplicationName = app.name
      targetApplicationScope = app.scope
    }

    // Switch scope for service account
    const scopePrefResponse = await client.get("/api/now/table/sys_user_preference", {
      params: {
        sysparm_query: "name=sys_scope^user=javascript:gs.getUserID()",
        sysparm_limit: 1,
      },
    })

    if (scopePrefResponse.data.result && scopePrefResponse.data.result.length > 0) {
      await client.patch(`/api/now/table/sys_user_preference/${scopePrefResponse.data.result[0].sys_id}`, {
        value: isGlobal ? "global" : targetApplicationId,
      })
    } else {
      await client.post("/api/now/table/sys_user_preference", {
        name: "sys_scope",
        value: isGlobal ? "global" : targetApplicationId,
        user: "javascript:gs.getUserID()",
      })
    }

    // Build result
    const result: any = {
      scope_switched: true,
      previous_scope: null, // We don't have this info easily
      current_scope: {
        sys_id: targetApplicationId,
        name: targetApplicationName,
        scope: targetApplicationScope,
        is_global: isGlobal,
      },
      update_set: null,
      user_scope_switched: null,
    }

    // Also switch for specific user if requested
    if (servicenow_username) {
      try {
        // Get user sys_id
        const userResponse = await client.get("/api/now/table/sys_user", {
          params: {
            sysparm_query: `user_name=${servicenow_username}`,
            sysparm_fields: "sys_id,user_name,name",
            sysparm_limit: 1,
          },
        })

        if (userResponse.data.result && userResponse.data.result.length > 0) {
          const userSysId = userResponse.data.result[0].sys_id

          const userScopePref = await client.get("/api/now/table/sys_user_preference", {
            params: {
              sysparm_query: `name=sys_scope^user=${userSysId}`,
              sysparm_limit: 1,
            },
          })

          if (userScopePref.data.result && userScopePref.data.result.length > 0) {
            await client.patch(`/api/now/table/sys_user_preference/${userScopePref.data.result[0].sys_id}`, {
              value: isGlobal ? "global" : targetApplicationId,
            })
          } else {
            await client.post("/api/now/table/sys_user_preference", {
              name: "sys_scope",
              value: isGlobal ? "global" : targetApplicationId,
              user: userSysId,
            })
          }

          result.user_scope_switched = {
            username: servicenow_username,
            success: true,
          }
        } else {
          result.user_scope_switched = {
            username: servicenow_username,
            success: false,
            error: "User not found",
          }
        }
      } catch (userError: any) {
        result.user_scope_switched = {
          username: servicenow_username,
          success: false,
          error: userError.message,
        }
      }
    }

    // Create Update Set if requested
    if (create_update_set) {
      try {
        const usName = update_set_name || `Development: ${targetApplicationName}`
        const usDescription =
          update_set_description || `Development Update Set for ${targetApplicationName} (${targetApplicationScope})`

        const updateSetResponse = await client.post("/api/now/table/sys_update_set", {
          name: usName,
          description: usDescription,
          state: "in progress",
          application: isGlobal ? "global" : targetApplicationId,
        })

        const updateSet = updateSetResponse.data.result

        // Set as current Update Set
        const updateSetPref = await client.get("/api/now/table/sys_user_preference", {
          params: {
            sysparm_query: "name=sys_update_set^user=javascript:gs.getUserID()",
            sysparm_limit: 1,
          },
        })

        if (updateSetPref.data.result && updateSetPref.data.result.length > 0) {
          await client.patch(`/api/now/table/sys_user_preference/${updateSetPref.data.result[0].sys_id}`, {
            value: updateSet.sys_id,
          })
        } else {
          await client.post("/api/now/table/sys_user_preference", {
            name: "sys_update_set",
            value: updateSet.sys_id,
            user: "javascript:gs.getUserID()",
          })
        }

        result.update_set = {
          sys_id: updateSet.sys_id,
          name: updateSet.name,
          description: updateSet.description,
          state: "in progress",
          is_current: true,
          application_scope: targetApplicationScope,
        }
      } catch (usError: any) {
        result.update_set = {
          created: false,
          error: usError.message,
        }
      }
    }

    // Build message
    let message = `Switched to ${isGlobal ? "Global" : `"${targetApplicationName}"`} scope (${targetApplicationScope})`
    if (result.update_set?.sys_id) {
      message += `. Update Set "${result.update_set.name}" created and activated.`
    }
    if (result.user_scope_switched?.success) {
      message += ` Also switched for user: ${servicenow_username}.`
    }
    result.message = message

    // Add guidance
    result.guidance = isGlobal
      ? "You are now in Global scope. Artifacts created will be available across all applications."
      : `You are now in "${targetApplicationName}" scope. Artifacts created will belong to this application.`

    if (!result.update_set) {
      result.guidance += " Consider creating an Update Set for change tracking."
    }

    return createSuccessResult(result)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Application Scope Enhancement"
