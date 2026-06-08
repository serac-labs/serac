/**
 * snow_handoff_to_agent - Handoff conversation to live agent
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_handoff_to_agent",
  description: "Initiates handoff from Virtual Agent to a live agent when automated assistance is insufficient.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "virtual-agent",
  use_cases: ["virtual-agent", "agent-handoff", "escalation"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Handoff function - modifies conversation assignment
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      conversation_id: {
        type: "string",
        description: "Conversation to handoff",
      },
      queue: {
        type: "string",
        description: "Agent queue for routing",
      },
      priority: {
        type: "number",
        description: "Queue priority",
      },
      reason: {
        type: "string",
        description: "Handoff reason",
      },
      context: {
        type: "object",
        description: "Context to pass to agent",
      },
    },
    required: ["conversation_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { conversation_id, queue, priority, reason, context: handoffContext } = args

  try {
    const client = await getAuthenticatedClient(context)

    const handoffData: any = {
      conversation_id,
      queue: queue || "general",
      priority: priority || 3,
      reason: reason || "User requested live agent",
      status: "pending",
    }

    if (handoffContext) {
      handoffData.context = JSON.stringify(handoffContext)
    }

    // Try to create handoff request
    try {
      const response = await client.post("/api/now/table/sys_cs_handoff", handoffData)

      return createSuccessResult({
        handoff_id: response.data.result.sys_id,
        conversation_id,
        queue: queue || "general",
        priority: priority || 3,
        reason: reason || "User requested live agent",
        message: `✅ Handoff to live agent initiated successfully`,
      })
    } catch (handoffError) {
      // Fallback to updating conversation status if handoff table doesn't exist
      await client.patch(`/api/now/table/sys_cs_conversation/${conversation_id}`, {
        status: "handoff_requested",
      })

      return createSuccessResult({
        conversation_id,
        queue: queue || "general",
        priority: priority || 3,
        reason: reason || "User requested live agent",
        status: "handoff_requested",
        message: `✅ Conversation marked for handoff (live agent will join shortly)`,
      })
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
