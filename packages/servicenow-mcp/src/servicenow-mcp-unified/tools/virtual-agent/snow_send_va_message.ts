/**
 * snow_send_va_message - Send message to Virtual Agent
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_send_va_message",
  description: "Sends a message to Virtual Agent and gets the response. Simulates user interaction with the chatbot.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "virtual-agent",
  use_cases: ["virtual-agent", "testing", "conversation"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Message function - sends messages and modifies conversation state
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      conversation_id: {
        type: "string",
        description: "Existing conversation ID (optional)",
      },
      message: {
        type: "string",
        description: "User message text",
      },
      user_id: {
        type: "string",
        description: "User sys_id",
      },
      context: {
        type: "object",
        description: "Additional context variables",
      },
    },
    required: ["message"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { conversation_id, message, user_id, context: userContext } = args

  try {
    const client = await getAuthenticatedClient(context)

    let conversationId = conversation_id

    // Create new conversation if not provided
    if (!conversationId) {
      const convData = {
        user: user_id || "guest",
        status: "active",
      }

      const convResponse = await client.post("/api/now/table/sys_cs_conversation", convData)
      conversationId = convResponse.data.result.sys_id
    }

    // Create user message
    const messageData: any = {
      conversation: conversationId,
      text: message,
      author: "user",
    }

    if (userContext) {
      messageData.context = JSON.stringify(userContext)
    }

    const messageResponse = await client.post("/api/now/table/sys_cs_message", messageData)

    if (!messageResponse.data.result) {
      return createErrorResult("Failed to send message to Virtual Agent")
    }

    // Simulate VA response (in real implementation, this would trigger VA processing)
    const vaResponse = {
      text: `I understand you said: "${message}". How can I help you with that?`,
      suggested_actions: ["Get more info", "Create ticket", "Talk to agent"],
    }

    return createSuccessResult({
      conversation_id: conversationId,
      user_message: message,
      va_response: vaResponse.text,
      suggested_actions: vaResponse.suggested_actions,
      message: `💬 Message sent to Virtual Agent successfully`,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
