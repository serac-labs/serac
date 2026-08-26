/**
 * snow_start_workflow - Start a workflow on a record
 *
 * ⚠️ LEGACY FEATURE WARNING:
 * ServiceNow Workflow (wf_workflow) is a LEGACY feature. ServiceNow recommends
 * using Flow Designer for new automation needs. Flow Designer is NOT currently
 * supported programmatically via Serac MCP tools.
 *
 * Note: Uses the standard workflow start approach via GlideRecord update
 * which triggers any associated workflow.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { resolveWorkflowVersion } from "../../shared/workflow-version.js"

const LEGACY_WARNING =
  "⚠️ LEGACY: ServiceNow Workflow is deprecated. For new automations, consider Flow Designer (not programmable via Serac, but specs can be generated)."

export const toolDefinition: MCPToolDefinition = {
  name: "snow_start_workflow",
  description:
    "⚠️ LEGACY: Start a workflow on a record (deprecated - ServiceNow recommends Flow Designer). Workflows run asynchronously.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "workflow",
  use_cases: ["workflow", "workflow-execution", "automation"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      workflow_sys_id: {
        type: "string",
        description:
          "wf_workflow sys_id, or a wf_workflow_version sys_id. A workflow id is resolved to the published version.",
      },
      workflow_name: {
        type: "string",
        description: "Workflow name (alternative to sys_id). Resolved to the published wf_workflow_version.",
      },
      table: {
        type: "string",
        description: "Table name the record belongs to",
      },
      record_sys_id: {
        type: "string",
        description: "Record sys_id to run workflow on",
      },
    },
    required: ["record_sys_id", "table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { workflow_sys_id, workflow_name, table, record_sys_id } = args

  try {
    const client = await getAuthenticatedClient(context)
    const input = workflow_sys_id || workflow_name
    const resolved = input ? await resolveWorkflowVersion(client, input) : undefined
    const versionSysId = resolved?.versionSysId

    // Verify record exists
    const recordCheck = await client.get(`/api/now/table/${table}/${record_sys_id}`, {
      params: {
        sysparm_fields: "sys_id",
      },
    })

    if (!recordCheck.data?.result) {
      throw new SnowFlowError(ErrorType.NOT_FOUND, `Record not found: ${table}/${record_sys_id}`, { retryable: false })
    }

    // Start workflow by creating a workflow context
    // This is the standard way to programmatically start workflows
    const contextResponse = await client.post("/api/now/table/wf_context", {
      workflow_version: versionSysId,
      table: table,
      id: record_sys_id,
      state: "executing",
      started_by: "snow-flow",
    })

    if (contextResponse.data?.result?.sys_id) {
      return createSuccessResult(
        {
          started: true,
          workflow_sys_id: resolved?.workflowSysId ?? versionSysId,
          workflow_version_sys_id: versionSysId,
          workflow_name: resolved?.name || "Unknown",
          record_sys_id,
          table,
          context_sys_id: contextResponse.data.result.sys_id,
          message: "Workflow started successfully. It will run asynchronously.",
          note: "Check wf_context table for execution status",
          legacy_notice: LEGACY_WARNING,
        },
        {
          operation: "start_workflow",
          method: "wf_context",
        },
        LEGACY_WARNING,
      )
    }

    // Fallback: Try to trigger via record update (which may fire associated workflows)
    return createSuccessResult(
      {
        started: false,
        workflow_sys_id: resolved?.workflowSysId ?? versionSysId,
        workflow_version_sys_id: versionSysId,
        workflow_name: resolved?.name || "Unknown",
        record_sys_id,
        table,
        message:
          "Could not create workflow context directly. The workflow may need to be triggered via record state change or business rule.",
        suggestion: "Try updating the record state to trigger associated workflows",
      },
      {
        operation: "start_workflow",
        method: "fallback",
      },
    )
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, error.message, { originalError: error }),
    )
  }
}

export const version = "2.0.0"
export const author = "Serac SDK"
