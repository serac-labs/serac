/**
 * snow_create_workflow
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
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

/**
 * Legacy workflow warning message
 */
const LEGACY_WARNING = `
⚠️ LEGACY FEATURE NOTICE:
ServiceNow Workflow (wf_workflow) is deprecated in favor of Flow Designer.

BEFORE PROCEEDING, CONSIDER:
• For NEW automations → Build manually in Flow Designer (modern, visual, supported)
• For EXISTING workflows → This tool can create/manage legacy workflows

Flow Designer is NOT programmable via Serac, but you can ask:
"Generate a Flow Designer specification for [describe your automation]"
to get a document describing what to build manually.

Proceeding with legacy workflow creation...
`

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_workflow",
  description:
    "⚠️ LEGACY: Create workflow definition (deprecated - ServiceNow recommends Flow Designer). Use for backwards compatibility only. For new automations, consider Flow Designer and ask Serac to generate a specification document.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "workflow",
  use_cases: ["workflow", "process-automation", "business-logic"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Workflow name" },
      table: { type: "string", description: "Table workflow applies to" },
      description: { type: "string", description: "Workflow description" },
      condition: { type: "string", description: "When to trigger workflow" },
    },
    required: ["name", "table"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, table, description, condition } = args
  try {
    const client = await getAuthenticatedClient(context)
    const workflowData: any = { name, table }
    if (description) workflowData.description = description
    if (condition) workflowData.condition = condition
    const response = await client.post("/api/now/table/wf_workflow", workflowData)
    return createSuccessResult(
      {
        created: true,
        workflow: response.data.result,
        legacy_notice: LEGACY_WARNING.trim(),
      },
      {},
      LEGACY_WARNING,
    )
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
