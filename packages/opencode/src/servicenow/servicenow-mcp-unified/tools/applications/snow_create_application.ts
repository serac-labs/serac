/**
 * snow_create_application - Create Scoped Application
 *
 * Creates a new scoped application in ServiceNow with optional automatic
 * Update Set creation and scope switching for seamless development workflow.
 *
 * Applications (scoped apps) provide isolation, clear ownership, and
 * easy deployment across instances.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_application",
  description: `Create a scoped application (sys_app), optionally bootstrapping an Update Set and switching the OAuth service account into the new scope so subsequent artifacts are tracked there.

Use when: building a complete feature set (HR Portal, Customer Onboarding), bundling functionality for single-unit deployment, building external integrations, or developing for multiple instances. Prefer global scope for small fixes, shared utilities, quick POCs, or cross-application work.

Defaults:
- auto_create_update_set=true — creates a fresh Update Set in the new app scope
- auto_switch_scope=true — switches the OAuth service account to the new scope so subsequent artifacts track there

Set either to false for manual control.`,
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "applications",
  use_cases: ["app-development", "scoped-apps", "development", "deployment"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'Application name (e.g., "HR Self-Service Portal")',
      },
      scope: {
        type: "string",
        description:
          'Application scope prefix (e.g., "x_myco_hr_portal"). Must start with "x_" followed by vendor prefix and app name. Use lowercase with underscores.',
      },
      version: {
        type: "string",
        description: 'Application version (default: "1.0.0")',
        default: "1.0.0",
      },
      short_description: {
        type: "string",
        description: "Brief description of the application purpose",
      },
      vendor: {
        type: "string",
        description: 'Vendor/company name (e.g., "My Company")',
      },
      vendor_prefix: {
        type: "string",
        description: 'Vendor prefix for scope (e.g., "myco"). Used in scope: x_<vendor_prefix>_<app>',
      },
      auto_create_update_set: {
        type: "boolean",
        description:
          "Automatically create an Update Set for this application (default: true). The Update Set will be scoped to this application for proper change tracking.",
        default: true,
      },
      auto_switch_scope: {
        type: "boolean",
        description:
          "Automatically switch to this application scope after creation (default: true). Enables immediate development within the new application.",
        default: true,
      },
      update_set_name: {
        type: "string",
        description:
          'Custom name for the auto-created Update Set. If not provided, defaults to "Initial Setup: <app_name>"',
      },
      runtime_access_tracking: {
        type: "string",
        description: "Runtime access tracking level",
        enum: ["none", "tracking", "enforcing"],
        default: "tracking",
      },
      licensable: {
        type: "boolean",
        description: "Whether the application is licensable",
        default: false,
      },
    },
    required: ["name", "scope"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    scope,
    version = "1.0.0",
    short_description,
    vendor,
    vendor_prefix,
    auto_create_update_set = true,
    auto_switch_scope = true,
    update_set_name,
    runtime_access_tracking = "tracking",
    licensable = false,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Validate scope format
    if (!scope.startsWith("x_")) {
      return createErrorResult(
        `Invalid scope format: "${scope}". Scope must start with "x_" (e.g., "x_myco_hr_portal"). The format is: x_<vendor_prefix>_<app_name>`,
      )
    }

    // Check if application already exists
    const existingApp = await client.get("/api/now/table/sys_app", {
      params: {
        sysparm_query: `scope=${scope}`,
        sysparm_fields: "sys_id,name,scope",
        sysparm_limit: 1,
      },
    })

    if (existingApp.data.result && existingApp.data.result.length > 0) {
      return createErrorResult(
        `Application with scope "${scope}" already exists: "${existingApp.data.result[0].name}" (sys_id: ${existingApp.data.result[0].sys_id})`,
      )
    }

    // Build application data
    const appData: any = {
      name,
      scope,
      version,
      active: true,
      runtime_access_tracking,
      licensable,
    }

    if (short_description) appData.short_description = short_description
    if (vendor) appData.vendor = vendor
    if (vendor_prefix) appData.vendor_prefix = vendor_prefix

    // Create the application
    const response = await client.post("/api/now/table/sys_app", appData)
    const application = response.data.result

    // Result object to build up
    const result: any = {
      created: true,
      application: {
        sys_id: application.sys_id,
        name: application.name,
        scope: application.scope,
        version: application.version,
        short_description: application.short_description || null,
        vendor: application.vendor || null,
        vendor_prefix: application.vendor_prefix || null,
      },
      update_set: null,
      scope_switched: false,
      next_steps: [],
    }

    // Auto-create Update Set if requested
    if (auto_create_update_set) {
      try {
        const usName = update_set_name || `Initial Setup: ${name}`
        const usDescription = `Development Update Set for ${name} (${scope})`

        const updateSetResponse = await client.post("/api/now/table/sys_update_set", {
          name: usName,
          description: usDescription,
          state: "in progress",
          application: application.sys_id,
        })

        const updateSet = updateSetResponse.data.result
        result.update_set = {
          sys_id: updateSet.sys_id,
          name: updateSet.name,
          description: updateSet.description,
          state: "in progress",
          application_scope: scope,
        }

        // Set as current Update Set for the service account
        if (auto_switch_scope) {
          try {
            // Check if preference exists
            const existingPref = await client.get("/api/now/table/sys_user_preference", {
              params: {
                sysparm_query: "name=sys_update_set^user=javascript:gs.getUserID()",
                sysparm_limit: 1,
              },
            })

            if (existingPref.data.result && existingPref.data.result.length > 0) {
              await client.patch(`/api/now/table/sys_user_preference/${existingPref.data.result[0].sys_id}`, {
                value: updateSet.sys_id,
              })
            } else {
              await client.post("/api/now/table/sys_user_preference", {
                name: "sys_update_set",
                value: updateSet.sys_id,
                user: "javascript:gs.getUserID()",
              })
            }

            result.update_set.is_current = true
          } catch (switchError: any) {
            result.update_set.is_current = false
            result.update_set.switch_error = switchError.message
          }
        }
      } catch (usError: any) {
        result.update_set = {
          created: false,
          error: usError.message,
        }
        result.next_steps.push(`Manually create Update Set for scope "${scope}"`)
      }
    } else {
      result.next_steps.push(`Create Update Set for scope "${scope}" before making changes`)
    }

    // Auto-switch scope if requested (set application scope preference)
    if (auto_switch_scope) {
      try {
        // Set the sys_scope user preference to the new application
        const scopePrefResponse = await client.get("/api/now/table/sys_user_preference", {
          params: {
            sysparm_query: "name=sys_scope^user=javascript:gs.getUserID()",
            sysparm_limit: 1,
          },
        })

        if (scopePrefResponse.data.result && scopePrefResponse.data.result.length > 0) {
          await client.patch(`/api/now/table/sys_user_preference/${scopePrefResponse.data.result[0].sys_id}`, {
            value: application.sys_id,
          })
        } else {
          await client.post("/api/now/table/sys_user_preference", {
            name: "sys_scope",
            value: application.sys_id,
            user: "javascript:gs.getUserID()",
          })
        }

        result.scope_switched = true
        result.current_scope = {
          sys_id: application.sys_id,
          name: application.name,
          scope: application.scope,
        }
      } catch (scopeError: any) {
        result.scope_switched = false
        result.scope_switch_error = scopeError.message
        result.next_steps.push(`Manually switch to scope "${scope}" using snow_switch_application_scope`)
      }
    } else {
      result.next_steps.push(`Switch to scope "${scope}" using snow_switch_application_scope before developing`)
    }

    // Add helpful next steps
    if (result.scope_switched && result.update_set?.is_current) {
      result.next_steps.push(`Ready to develop! All changes will be tracked in scope "${scope}"`)
    }
    result.next_steps.push(`Create widgets, business rules, and other artifacts for your application`)
    result.next_steps.push(`When done, complete the Update Set and export for deployment`)

    // Build success message
    let message = `Application "${name}" created successfully with scope "${scope}"`
    if (result.update_set?.sys_id) {
      message += `. Update Set "${result.update_set.name}" created and activated.`
    }
    if (result.scope_switched) {
      message += ` Scope switched to ${scope}.`
    }
    result.message = message

    return createSuccessResult(result)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "2.0.0"
export const author = "Serac Application Scope Enhancement"
