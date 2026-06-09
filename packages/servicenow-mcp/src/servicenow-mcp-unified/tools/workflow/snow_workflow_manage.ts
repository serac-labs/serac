/**
 * snow_workflow_manage - Comprehensive legacy workflow management
 *
 * ⚠️ LEGACY FEATURE WARNING:
 * ServiceNow Workflow (wf_workflow) is a LEGACY feature. ServiceNow recommends
 * using Flow Designer for new automation needs. Flow Designer is NOT currently
 * supported programmatically via Serac MCP tools.
 *
 * Before using this tool, consider:
 * 1. Do you need legacy workflow specifically for backwards compatibility?
 * 2. Would Flow Designer be a better fit for this automation?
 *
 * If Flow Designer is preferred, Serac can generate a specification document
 * that describes the flow logic, triggers, and actions you need to implement
 * manually in ServiceNow Flow Designer.
 *
 * Manage ServiceNow legacy workflows (wf_workflow) with full CRUD operations,
 * execution control, and debugging capabilities.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { summary, formatSysId, formatBoolean } from "../../shared/output-formatter.js"

/**
 * Legacy workflow warning message to be included in tool responses
 */
const LEGACY_WARNING = `
⚠️ LEGACY FEATURE NOTICE:
ServiceNow Workflow (wf_workflow) is deprecated in favor of Flow Designer.
Flow Designer provides a modern, visual interface for building automations.

Use snow_manage_flow to create and manage Flow Designer flows programmatically.

RECOMMENDATIONS:
1. For NEW automations → Use snow_manage_flow (action: create)
2. For EXISTING workflows → This tool can manage legacy workflows
3. For MIGRATION → Use snow_manage_flow to recreate workflows as flows
`

export const toolDefinition: MCPToolDefinition = {
  name: "snow_workflow_manage",
  description:
    "⚠️ LEGACY: Manage legacy workflows (deprecated - ServiceNow recommends Flow Designer). Use for backwards compatibility only. For new automations, consider Flow Designer (not programmable via Serac, but specs can be generated). Actions: list, get, stop, retry, clone, enable/disable, delete, get_history",
  category: "automation",
  subcategory: "workflow",
  use_cases: ["workflow", "process-automation", "workflow-management"],
  complexity: "intermediate",
  frequency: "high",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "stop", "retry", "clone", "enable", "disable", "delete", "get_history"],
        description: "Action to perform",
      },
      workflow_id: {
        type: "string",
        description: "Workflow sys_id or name (required for get, stop, retry, clone, enable, disable, delete)",
      },
      context_id: {
        type: "string",
        description: "Workflow context sys_id (required for stop, retry, get_history on specific execution)",
      },
      table: {
        type: "string",
        description: "Filter workflows by table (for list action)",
      },
      active_only: {
        type: "boolean",
        description: "Only list active workflows",
        default: true,
      },
      new_name: {
        type: "string",
        description: "New name for cloned workflow (for clone action)",
      },
      limit: {
        type: "number",
        description: "Max results for list/get_history",
        default: 50,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action, workflow_id, context_id, table, active_only = true, new_name, limit = 50 } = args

  try {
    const client = await getAuthenticatedClient(context)

    switch (action) {
      case "list": {
        var query = ""
        if (table) {
          query = "table=" + table
        }
        if (active_only) {
          query += (query ? "^" : "") + "active=true"
        }

        const response = await client.get("/api/now/table/wf_workflow", {
          params: {
            sysparm_query: query || undefined,
            sysparm_fields: "sys_id,name,table,active,description,sys_created_on,sys_updated_on",
            sysparm_limit: limit,
          },
        })

        const workflows = response.data.result || []
        var workflowList = workflows.map((wf: any) => ({
          sys_id: wf.sys_id,
          name: wf.name,
          table: wf.table,
          active: wf.active === "true",
          description: wf.description,
          created: wf.sys_created_on,
          updated: wf.sys_updated_on,
        }))

        // Build formatted summary
        var listSummary = summary().success(
          "Found " + workflowList.length + " workflow" + (workflowList.length === 1 ? "" : "s"),
        )

        for (var i = 0; i < Math.min(workflowList.length, 10); i++) {
          var wf = workflowList[i]
          listSummary.bullet(wf.name + " (" + wf.table + ")" + (wf.active ? "" : " [inactive]"))
        }
        if (workflowList.length > 10) {
          listSummary.indented("... and " + (workflowList.length - 10) + " more")
        }

        return createSuccessResult(
          {
            action: "list",
            count: workflowList.length,
            workflows: workflowList,
            legacy_notice: LEGACY_WARNING.trim(),
          },
          {},
          listSummary.build() + "\n\n" + LEGACY_WARNING,
        )
      }

      case "get": {
        if (!workflow_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "workflow_id is required for get action")
        }

        // Resolve workflow
        var wfSysId = workflow_id
        if (workflow_id.length !== 32) {
          const lookup = await client.get("/api/now/table/wf_workflow", {
            params: {
              sysparm_query: "name=" + workflow_id,
              sysparm_fields: "sys_id",
              sysparm_limit: 1,
            },
          })
          if (!lookup.data.result?.[0]) {
            throw new SnowFlowError(ErrorType.NOT_FOUND, "Workflow not found: " + workflow_id)
          }
          wfSysId = lookup.data.result[0].sys_id
        }

        // Get workflow details
        const wfResponse = await client.get("/api/now/table/wf_workflow/" + wfSysId)
        const workflow = wfResponse.data.result

        // Get activities
        const activitiesResponse = await client.get("/api/now/table/wf_activity", {
          params: {
            sysparm_query: "workflow=" + wfSysId,
            sysparm_fields: "sys_id,name,activity_definition,x,y,state,out_of_date",
            sysparm_limit: 100,
          },
        })

        // Get transitions
        const transitionsResponse = await client.get("/api/now/table/wf_transition", {
          params: {
            sysparm_query: "workflow=" + wfSysId,
            sysparm_fields: "sys_id,name,from,to,condition",
            sysparm_limit: 200,
          },
        })

        // Get recent executions
        const executionsResponse = await client.get("/api/now/table/wf_context", {
          params: {
            sysparm_query: "workflow=" + wfSysId + "^ORDERBYDESCstarted",
            sysparm_fields: "sys_id,state,started,ended,duration,id,table",
            sysparm_limit: 10,
          },
        })

        var workflowData = {
          sys_id: workflow.sys_id,
          name: workflow.name,
          table: workflow.table,
          active: workflow.active === "true",
          description: workflow.description,
          condition: workflow.condition,
          run_as: workflow.run_as,
          created: workflow.sys_created_on,
          updated: workflow.sys_updated_on,
        }
        var activitiesList = (activitiesResponse.data.result || []).map((a: any) => ({
          sys_id: a.sys_id,
          name: a.name,
          definition: a.activity_definition,
          position: { x: a.x, y: a.y },
          state: a.state,
        }))
        var transitionsList = (transitionsResponse.data.result || []).map((t: any) => ({
          sys_id: t.sys_id,
          name: t.name,
          from: t.from,
          to: t.to,
          condition: t.condition,
        }))
        var executionsList = (executionsResponse.data.result || []).map((e: any) => ({
          context_id: e.sys_id,
          state: e.state,
          record_id: e.id,
          record_table: e.table,
          started: e.started,
          ended: e.ended,
          duration_ms: e.duration,
        }))

        // Build formatted summary
        var getSummary = summary()
          .success("Workflow: " + workflowData.name)
          .field("sys_id", workflowData.sys_id)
          .field("Table", workflowData.table)
          .field("Status", workflowData.active ? "Active" : "Inactive")
          .field("Description", workflowData.description)
          .blank()
          .line("Activities: " + activitiesList.length + " | Transitions: " + transitionsList.length)

        if (executionsList.length > 0) {
          getSummary.blank().line("Recent Executions:")
          for (var j = 0; j < Math.min(executionsList.length, 5); j++) {
            var exec = executionsList[j]
            getSummary.bullet(exec.state + " - " + (exec.started || "pending"))
          }
        }

        return createSuccessResult(
          {
            action: "get",
            workflow: workflowData,
            activities: activitiesList,
            transitions: transitionsList,
            recent_executions: executionsList,
          },
          {},
          getSummary.build(),
        )
      }

      case "stop": {
        if (!context_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "context_id is required for stop action")
        }

        await client.patch("/api/now/table/wf_context/" + context_id, {
          state: "cancelled",
        })

        var stopSummary = summary().success("Stopped workflow execution").field("Context ID", context_id)

        return createSuccessResult(
          {
            action: "stop",
            context_id: context_id,
            message: "Workflow execution cancelled",
          },
          {},
          stopSummary.build(),
        )
      }

      case "retry": {
        if (!context_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "context_id is required for retry action")
        }

        // Get the original context
        const ctxResponse = await client.get("/api/now/table/wf_context/" + context_id, {
          params: {
            sysparm_fields: "workflow,table,id",
          },
        })
        const ctx = ctxResponse.data.result

        if (!ctx) {
          throw new SnowFlowError(ErrorType.NOT_FOUND, "Workflow context not found: " + context_id)
        }

        // Create new context to restart
        const newContext = await client.post("/api/now/table/wf_context", {
          workflow: typeof ctx.workflow === "object" ? ctx.workflow.value : ctx.workflow,
          table: ctx.table,
          id: ctx.id,
          state: "executing",
          started_by: "snow-flow-retry",
        })

        return createSuccessResult({
          action: "retry",
          original_context_id: context_id,
          new_context_id: newContext.data.result.sys_id,
          message: "Workflow restarted",
        })
      }

      case "clone": {
        if (!workflow_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "workflow_id is required for clone action")
        }

        // Resolve workflow
        var cloneSysId = workflow_id
        if (workflow_id.length !== 32) {
          const lookup = await client.get("/api/now/table/wf_workflow", {
            params: {
              sysparm_query: "name=" + workflow_id,
              sysparm_fields: "sys_id,name",
              sysparm_limit: 1,
            },
          })
          if (!lookup.data.result?.[0]) {
            throw new SnowFlowError(ErrorType.NOT_FOUND, "Workflow not found: " + workflow_id)
          }
          cloneSysId = lookup.data.result[0].sys_id
        }

        // Get original workflow
        const origResponse = await client.get("/api/now/table/wf_workflow/" + cloneSysId)
        const orig = origResponse.data.result

        var cloneName = new_name || orig.name + " (Copy)"

        // Create new workflow
        const newWf = await client.post("/api/now/table/wf_workflow", {
          name: cloneName,
          table: orig.table,
          description: orig.description,
          condition: orig.condition,
          run_as: orig.run_as,
          active: false, // Start inactive
        })

        const newWfId = newWf.data.result.sys_id

        // Clone activities
        const activitiesResp = await client.get("/api/now/table/wf_activity", {
          params: {
            sysparm_query: "workflow=" + cloneSysId,
            sysparm_limit: 100,
          },
        })

        var activityMap: Record<string, string> = {}
        for (var i = 0; i < (activitiesResp.data.result || []).length; i++) {
          var act = activitiesResp.data.result[i]
          var newAct = await client.post("/api/now/table/wf_activity", {
            workflow: newWfId,
            name: act.name,
            activity_definition: act.activity_definition,
            x: act.x,
            y: act.y,
            vars: act.vars,
          })
          activityMap[act.sys_id] = newAct.data.result.sys_id
        }

        // Clone transitions
        const transResp = await client.get("/api/now/table/wf_transition", {
          params: {
            sysparm_query: "workflow=" + cloneSysId,
            sysparm_limit: 200,
          },
        })

        for (var j = 0; j < (transResp.data.result || []).length; j++) {
          var trans = transResp.data.result[j]
          var fromId = typeof trans.from === "object" ? trans.from.value : trans.from
          var toId = typeof trans.to === "object" ? trans.to.value : trans.to
          await client.post("/api/now/table/wf_transition", {
            workflow: newWfId,
            name: trans.name,
            from: activityMap[fromId] || fromId,
            to: activityMap[toId] || toId,
            condition: trans.condition,
          })
        }

        return createSuccessResult({
          action: "clone",
          original_id: cloneSysId,
          new_workflow: {
            sys_id: newWfId,
            name: cloneName,
          },
          activities_cloned: Object.keys(activityMap).length,
          transitions_cloned: (transResp.data.result || []).length,
          message: "Workflow cloned successfully (inactive by default)",
        })
      }

      case "enable":
      case "disable": {
        if (!workflow_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "workflow_id is required for " + action + " action")
        }

        var toggleSysId = workflow_id
        if (workflow_id.length !== 32) {
          const lookup = await client.get("/api/now/table/wf_workflow", {
            params: {
              sysparm_query: "name=" + workflow_id,
              sysparm_fields: "sys_id",
              sysparm_limit: 1,
            },
          })
          if (!lookup.data.result?.[0]) {
            throw new SnowFlowError(ErrorType.NOT_FOUND, "Workflow not found: " + workflow_id)
          }
          toggleSysId = lookup.data.result[0].sys_id
        }

        await client.patch("/api/now/table/wf_workflow/" + toggleSysId, {
          active: action === "enable",
        })

        return createSuccessResult({
          action: action,
          workflow_id: toggleSysId,
          active: action === "enable",
          message: "Workflow " + (action === "enable" ? "enabled" : "disabled"),
        })
      }

      case "delete": {
        if (!workflow_id) {
          throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "workflow_id is required for delete action")
        }

        var delSysId = workflow_id
        if (workflow_id.length !== 32) {
          const lookup = await client.get("/api/now/table/wf_workflow", {
            params: {
              sysparm_query: "name=" + workflow_id,
              sysparm_fields: "sys_id",
              sysparm_limit: 1,
            },
          })
          if (!lookup.data.result?.[0]) {
            throw new SnowFlowError(ErrorType.NOT_FOUND, "Workflow not found: " + workflow_id)
          }
          delSysId = lookup.data.result[0].sys_id
        }

        await client.delete("/api/now/table/wf_workflow/" + delSysId)

        return createSuccessResult({
          action: "delete",
          workflow_id: delSysId,
          message: "Workflow deleted",
        })
      }

      case "get_history": {
        var historyQuery = ""
        if (workflow_id) {
          var histWfId = workflow_id
          if (workflow_id.length !== 32) {
            const lookup = await client.get("/api/now/table/wf_workflow", {
              params: {
                sysparm_query: "name=" + workflow_id,
                sysparm_fields: "sys_id",
                sysparm_limit: 1,
              },
            })
            if (lookup.data.result?.[0]) {
              histWfId = lookup.data.result[0].sys_id
            }
          }
          historyQuery = "context.workflow=" + histWfId
        }
        if (context_id) {
          historyQuery = "context=" + context_id
        }

        const histResponse = await client.get("/api/now/table/wf_history", {
          params: {
            sysparm_query: historyQuery + "^ORDERBYDESCsys_created_on",
            sysparm_fields: "sys_id,context,activity,from_state,to_state,message,sys_created_on",
            sysparm_limit: limit,
          },
        })

        return createSuccessResult({
          action: "get_history",
          count: (histResponse.data.result || []).length,
          history: (histResponse.data.result || []).map((h: any) => ({
            sys_id: h.sys_id,
            context: typeof h.context === "object" ? h.context.value : h.context,
            activity: typeof h.activity === "object" ? h.activity.display_value : h.activity,
            from_state: h.from_state,
            to_state: h.to_state,
            message: h.message,
            timestamp: h.sys_created_on,
          })),
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
