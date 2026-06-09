/**
 * snow_workflow_transition - Manage workflow transitions between activities
 *
 * ⚠️ LEGACY FEATURE WARNING:
 * ServiceNow Workflow (wf_workflow) is a LEGACY feature. ServiceNow recommends
 * using Flow Designer for new automation needs.
 *
 * Create, update, and manage transitions (connections) between workflow activities.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

const LEGACY_WARNING =
  "⚠️ LEGACY: Workflow transitions are deprecated. Consider Flow Designer for new automations (ask Serac to generate a Flow Designer specification)."

export const toolDefinition: MCPToolDefinition = {
  name: "snow_workflow_transition",
  description:
    "⚠️ LEGACY: Manage workflow transitions (deprecated - ServiceNow recommends Flow Designer). Actions: create, update, delete, list",
  category: "automation",
  subcategory: "workflow",
  use_cases: ["workflow", "workflow-design", "activity-connections"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "delete", "list"],
        description: "Action to perform",
      },
      workflow_id: {
        type: "string",
        description: "Workflow sys_id or name (required for create, list)",
      },
      transition_id: {
        type: "string",
        description: "Transition sys_id (required for update, delete)",
      },
      from_activity: {
        type: "string",
        description: "Source activity sys_id (for create)",
      },
      to_activity: {
        type: "string",
        description: "Target activity sys_id (for create)",
      },
      name: {
        type: "string",
        description: "Transition name/label",
      },
      condition: {
        type: "string",
        description: "Condition script for conditional transitions",
      },
      condition_type: {
        type: "string",
        enum: ["always", "condition", "else"],
        description: "Type of condition",
        default: "always",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    action,
    workflow_id,
    transition_id,
    from_activity,
    to_activity,
    name,
    condition,
    condition_type = "always",
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Helper to resolve workflow name to sys_id
    async function resolveWorkflowId(wfId: string): Promise<string> {
      if (wfId.length === 32) return wfId
      const lookup = await client.get("/api/now/table/wf_workflow", {
        params: {
          sysparm_query: "name=" + wfId,
          sysparm_fields: "sys_id",
          sysparm_limit: 1,
        },
      })
      if (!lookup.data.result?.[0]) {
        throw new SnowFlowError(ErrorType.NOT_FOUND, "Workflow not found: " + wfId)
      }
      return lookup.data.result[0].sys_id
    }

    switch (action) {
      case "list": {
        if (!workflow_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "workflow_id is required for list action")
        }

        var wfSysId = await resolveWorkflowId(workflow_id)

        const response = await client.get("/api/now/table/wf_transition", {
          params: {
            sysparm_query: "workflow=" + wfSysId,
            sysparm_fields: "sys_id,name,from,to,condition,condition_type",
            sysparm_limit: 200,
          },
        })

        var transitions = (response.data.result || []).map(function (t: any) {
          return {
            sys_id: t.sys_id,
            name: t.name,
            from: typeof t.from === "object" ? { sys_id: t.from.value, name: t.from.display_value } : t.from,
            to: typeof t.to === "object" ? { sys_id: t.to.value, name: t.to.display_value } : t.to,
            condition: t.condition,
            condition_type: t.condition_type,
          }
        })

        return createSuccessResult({
          action: "list",
          workflow_id: wfSysId,
          count: transitions.length,
          transitions: transitions,
        })
      }

      case "create": {
        if (!workflow_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "workflow_id is required for create action")
        }
        if (!from_activity) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "from_activity is required for create action")
        }
        if (!to_activity) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "to_activity is required for create action")
        }

        var createWfId = await resolveWorkflowId(workflow_id)

        var transitionData: any = {
          workflow: createWfId,
          from: from_activity,
          to: to_activity,
        }

        if (name) transitionData.name = name
        if (condition) transitionData.condition = condition
        if (condition_type) transitionData.condition_type = condition_type

        const createResponse = await client.post("/api/now/table/wf_transition", transitionData)

        return createSuccessResult({
          action: "create",
          created: true,
          transition: {
            sys_id: createResponse.data.result.sys_id,
            name: createResponse.data.result.name,
            from: from_activity,
            to: to_activity,
          },
        })
      }

      case "update": {
        if (!transition_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "transition_id is required for update action")
        }

        var updateData: any = {}
        if (name !== undefined) updateData.name = name
        if (condition !== undefined) updateData.condition = condition
        if (condition_type !== undefined) updateData.condition_type = condition_type
        if (from_activity) updateData.from = from_activity
        if (to_activity) updateData.to = to_activity

        if (Object.keys(updateData).length === 0) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "No fields to update")
        }

        await client.patch("/api/now/table/wf_transition/" + transition_id, updateData)

        return createSuccessResult({
          action: "update",
          updated: true,
          transition_id: transition_id,
          fields_updated: Object.keys(updateData),
        })
      }

      case "delete": {
        if (!transition_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "transition_id is required for delete action")
        }

        await client.delete("/api/now/table/wf_transition/" + transition_id)

        return createSuccessResult({
          action: "delete",
          deleted: true,
          transition_id: transition_id,
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
