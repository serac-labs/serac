/**
 * snow_inbound_email_action - Manage inbound email actions
 *
 * Manage ServiceNow inbound email actions (sysevent_in_email_action) that process
 * incoming emails and create/update records.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_inbound_email_action",
  description: "Manage inbound email actions: list, get, create, update, delete, enable/disable",
  category: "automation",
  subcategory: "email",
  use_cases: ["email", "inbound-processing", "automation", "record-creation"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "create", "update", "delete", "enable", "disable"],
        description: "Action to perform",
      },
      action_id: {
        type: "string",
        description: "Inbound email action sys_id or name",
      },
      name: {
        type: "string",
        description: "Action name",
      },
      target_table: {
        type: "string",
        description: "Table to create/update records in",
      },
      action_type: {
        type: "string",
        enum: ["record", "forward", "reply", "ignore"],
        description: "What to do with matching emails",
        default: "record",
      },
      stop_processing: {
        type: "boolean",
        description: "Stop processing other actions after this one matches",
        default: true,
      },
      order: {
        type: "number",
        description: "Processing order (lower = earlier)",
        default: 100,
      },
      filter_condition: {
        type: "string",
        description: 'Condition to match emails (e.g., "subject:incident")',
      },
      script: {
        type: "string",
        description: "Script to execute when email matches",
      },
      template: {
        type: "string",
        description: "Template for reply emails",
      },
      active: {
        type: "boolean",
        description: "Whether action is active",
        default: true,
      },
      active_only: {
        type: "boolean",
        description: "Only list active actions",
        default: false,
      },
      limit: {
        type: "number",
        description: "Max results for list",
        default: 50,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    action,
    action_id,
    name,
    target_table,
    action_type = "record",
    stop_processing = true,
    order = 100,
    filter_condition,
    script,
    template,
    active = true,
    active_only = false,
    limit = 50,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Helper to resolve action name to sys_id
    async function resolveActionId(actId: string): Promise<string> {
      if (actId.length === 32 && !/\s/.test(actId)) return actId
      const lookup = await client.get("/api/now/table/sysevent_in_email_action", {
        params: {
          sysparm_query: "name=" + actId,
          sysparm_fields: "sys_id",
          sysparm_limit: 1,
        },
      })
      if (!lookup.data.result?.[0]) {
        throw new SnowFlowError(ErrorType.NOT_FOUND, "Inbound email action not found: " + actId)
      }
      return lookup.data.result[0].sys_id
    }

    switch (action) {
      case "list": {
        var query = ""
        if (active_only) {
          query = "active=true"
        }

        const response = await client.get("/api/now/table/sysevent_in_email_action", {
          params: {
            sysparm_query: query + "^ORDERBYorder",
            sysparm_fields: "sys_id,name,target_table,type,active,order,stop_processing,sys_created_on",
            sysparm_limit: limit,
          },
        })

        var actions = (response.data.result || []).map(function (a: any) {
          return {
            sys_id: a.sys_id,
            name: a.name,
            target_table: a.target_table,
            type: a.type,
            active: a.active === "true",
            order: a.order,
            stop_processing: a.stop_processing === "true",
            created: a.sys_created_on,
          }
        })

        return createSuccessResult({
          action: "list",
          count: actions.length,
          actions: actions,
        })
      }

      case "get": {
        if (!action_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "action_id is required for get action")
        }

        var getSysId = await resolveActionId(action_id)
        const response = await client.get("/api/now/table/sysevent_in_email_action/" + getSysId)
        var act = response.data.result

        return createSuccessResult({
          action: "get",
          email_action: {
            sys_id: act.sys_id,
            name: act.name,
            target_table: act.target_table,
            type: act.type,
            active: act.active === "true",
            order: act.order,
            stop_processing: act.stop_processing === "true",
            filter_condition: act.filter_condition,
            script: act.script,
            template: act.template,
            created: act.sys_created_on,
            updated: act.sys_updated_on,
          },
        })
      }

      case "create": {
        if (!name) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "name is required for create action")
        }

        var createData: any = {
          name: name,
          type: action_type,
          active: active,
          order: order,
          stop_processing: stop_processing,
        }

        if (target_table) createData.target_table = target_table
        if (filter_condition) createData.filter_condition = filter_condition
        if (script) createData.script = script
        if (template) createData.template = template

        const createResponse = await client.post("/api/now/table/sysevent_in_email_action", createData)

        return createSuccessResult({
          action: "create",
          created: true,
          email_action: {
            sys_id: createResponse.data.result.sys_id,
            name: createResponse.data.result.name,
            type: createResponse.data.result.type,
          },
        })
      }

      case "update": {
        if (!action_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "action_id is required for update action")
        }

        var updateSysId = await resolveActionId(action_id)

        var updateData: any = {}
        if (name !== undefined) updateData.name = name
        if (target_table !== undefined) updateData.target_table = target_table
        if (action_type !== undefined) updateData.type = action_type
        if (stop_processing !== undefined) updateData.stop_processing = stop_processing
        if (order !== undefined) updateData.order = order
        if (filter_condition !== undefined) updateData.filter_condition = filter_condition
        if (script !== undefined) updateData.script = script
        if (template !== undefined) updateData.template = template
        if (active !== undefined) updateData.active = active

        if (Object.keys(updateData).length === 0) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "No fields to update")
        }

        await client.patch("/api/now/table/sysevent_in_email_action/" + updateSysId, updateData)

        return createSuccessResult({
          action: "update",
          updated: true,
          action_id: updateSysId,
          fields_updated: Object.keys(updateData),
        })
      }

      case "delete": {
        if (!action_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "action_id is required for delete action")
        }

        var deleteSysId = await resolveActionId(action_id)
        await client.delete("/api/now/table/sysevent_in_email_action/" + deleteSysId)

        return createSuccessResult({
          action: "delete",
          deleted: true,
          action_id: deleteSysId,
        })
      }

      case "enable":
      case "disable": {
        if (!action_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "action_id is required for " + action + " action")
        }

        var toggleSysId = await resolveActionId(action_id)
        await client.patch("/api/now/table/sysevent_in_email_action/" + toggleSysId, {
          active: action === "enable",
        })

        return createSuccessResult({
          action: action,
          action_id: toggleSysId,
          active: action === "enable",
          message: "Inbound email action " + (action === "enable" ? "enabled" : "disabled"),
        })
      }

      default:
        throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "Unknown action: " + action)
    }
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, error.message, { originalError: error }),
    )
  }
}

export const version = "1.0.0"
export const author = "Serac"
