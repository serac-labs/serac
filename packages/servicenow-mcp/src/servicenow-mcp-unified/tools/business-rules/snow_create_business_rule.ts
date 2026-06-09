/**
 * snow_create_business_rule
 *
 * Creates server-side business rules in ServiceNow.
 * Supports all major business rule configurations including:
 * - Trigger conditions (insert/update/delete/query)
 * - Filter conditions (encoded query)
 * - Script conditions
 * - Execution order
 * - Role conditions
 * - Abort actions and messages
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_business_rule",
  description: "Create server-side business rule with full configuration options (ES5 only for scripts!)",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "platform",
  use_cases: ["business-rules", "server-side", "automation"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      // Basic Info
      name: {
        type: "string",
        description: "Business rule name",
      },
      table: {
        type: "string",
        description: "Table name (e.g., incident, task, sys_user)",
      },
      description: {
        type: "string",
        description: "Description of what this business rule does",
      },

      // When to Run
      when: {
        type: "string",
        enum: ["before", "after", "async", "display"],
        default: "before",
        description: "When to execute: before (before DB), after (after DB), async (scheduled), display (form load)",
      },
      order: {
        type: "number",
        default: 100,
        description: "Execution order (lower = runs first). Default: 100",
      },

      // Trigger Operations
      insert: {
        type: "boolean",
        default: false,
        description: "Run on insert operations",
      },
      update: {
        type: "boolean",
        default: false,
        description: "Run on update operations",
      },
      delete: {
        type: "boolean",
        default: false,
        description: "Run on delete operations",
      },
      query: {
        type: "boolean",
        default: false,
        description: "Run on query operations",
      },

      // Conditions
      filter_condition: {
        type: "string",
        description:
          'Encoded query filter (e.g., "active=true^priority=1"). Record must match this to trigger the rule.',
      },
      condition: {
        type: "string",
        description: 'Script condition that must return true (ES5 only!). E.g., "current.priority == 1"',
      },
      role_conditions: {
        type: "string",
        description: "Comma-separated role sys_ids. Only users with these roles trigger the rule.",
      },

      // Script
      script: {
        type: "string",
        description: "Script to execute (ES5 ONLY! No const/let/arrow functions). Use current/previous objects.",
      },

      // Actions
      abort_action: {
        type: "boolean",
        default: false,
        description: 'Abort the database action (only works with "before" rules)',
      },
      add_message: {
        type: "boolean",
        default: false,
        description: "Add an info message to the user",
      },
      message: {
        type: "string",
        description: "Message text to display (requires add_message=true)",
      },

      // Advanced
      active: {
        type: "boolean",
        default: true,
        description: "Whether the business rule is active",
      },
      access: {
        type: "string",
        enum: ["package_private", "public"],
        default: "package_private",
        description: "Access level for the business rule",
      },
      application_scope: {
        type: "string",
        description: "Application scope sys_id (leave empty for global)",
      },
    },
    required: ["name", "table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    // Basic
    name,
    table,
    description,
    // When
    when = "before",
    order = 100,
    // Operations
    insert = false,
    update = false,
    delete: del = false,
    query = false,
    // Conditions
    filter_condition,
    condition,
    role_conditions,
    // Script
    script,
    // Actions
    abort_action = false,
    add_message = false,
    message,
    // Advanced
    active = true,
    access = "package_private",
    application_scope,
  } = args

  // Validate: at least one operation must be selected
  if (!insert && !update && !del && !query) {
    return createErrorResult("At least one operation must be selected: insert, update, delete, or query")
  }

  // Validate: script is required unless it's just an abort action
  if (!script && !abort_action) {
    return createErrorResult("Either script or abort_action is required")
  }

  try {
    const client = await getAuthenticatedClient(context)

    // Build the business rule data object
    const brData: Record<string, any> = {
      name,
      collection: table,
      when,
      order,
      action_insert: insert,
      action_update: update,
      action_delete: del,
      action_query: query,
      active,
      access,
    }

    // Optional fields
    if (description) brData.description = description
    if (filter_condition) brData.filter_condition = filter_condition
    if (condition) brData.condition = condition
    if (role_conditions) brData.role_conditions = role_conditions
    if (script) brData.script = script
    if (abort_action) brData.abort_action = abort_action
    if (add_message) brData.add_message = add_message
    if (message) brData.message = message
    if (application_scope) brData.sys_scope = application_scope

    const response = await client.post("/api/now/table/sys_script", brData)
    const result = response.data.result

    // Build response with helpful info
    const instanceUrl = (client.defaults?.baseURL || "").replace("/api/now", "")

    return createSuccessResult({
      created: true,
      business_rule: {
        sys_id: result.sys_id,
        name: result.name,
        table: result.collection,
        when: result.when,
        order: result.order,
        operations: {
          insert: result.action_insert === "true",
          update: result.action_update === "true",
          delete: result.action_delete === "true",
          query: result.action_query === "true",
        },
        active: result.active === "true",
        url: `${instanceUrl}/sys_script.do?sys_id=${result.sys_id}`,
      },
      tips: [
        'Use "current" to access the current record being processed',
        'Use "previous" to access the previous values (on update)',
        'Use "gs" for GlideSystem methods like gs.info(), gs.addInfoMessage()',
        "Remember: ES5 ONLY - no const, let, arrow functions, or template literals!",
      ],
    })
  } catch (error: any) {
    return createErrorResult(`Failed to create business rule: ${error.response?.data?.error?.message || error.message}`)
  }
}

export const version = "2.0.0"
export const author = "Serac v8.41.15"
