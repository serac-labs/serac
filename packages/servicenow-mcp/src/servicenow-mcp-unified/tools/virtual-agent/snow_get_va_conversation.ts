/**
 * snow_get_va_conversation - Get Virtual Agent conversation details
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_va_conversation",
  description: "Retrieves Virtual Agent conversation history and context for a specific session.",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "virtual-agent",
  use_cases: ["virtual-agent", "conversation-history", "analytics"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      conversation_id: {
        type: "string",
        description: "Conversation sys_id",
      },
      user_id: {
        type: "string",
        description: "User sys_id (alternative to conversation_id)",
      },
      include_transcript: {
        type: "boolean",
        description: "Include full transcript",
        default: true,
      },
      limit: {
        type: "number",
        description: "Maximum messages to retrieve",
        default: 50,
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { conversation_id, user_id, include_transcript = true, limit = 50 } = args

  try {
    const client = await getAuthenticatedClient(context)

    let query = ""
    if (conversation_id) {
      query = `sys_id=${conversation_id}`
    } else if (user_id) {
      query = `user=${user_id}`
    } else {
      return createErrorResult("Either conversation_id or user_id must be provided")
    }

    const convResponse = await client.get(`/api/now/table/sys_cs_conversation?sysparm_query=${query}&sysparm_limit=1`)

    if (!convResponse.data.result || convResponse.data.result.length === 0) {
      return createErrorResult("Conversation not found")
    }

    const conversation = convResponse.data.result[0]
    let transcript: any[] = []

    if (include_transcript) {
      const messagesResponse = await client.get(
        `/api/now/table/sys_cs_message?sysparm_query=conversation=${conversation.sys_id}&sysparm_limit=${limit}&sysparm_orderby=sys_created_on`,
      )

      if (messagesResponse.data.result) {
        transcript = messagesResponse.data.result.map((m: any) => ({
          author: m.author,
          text: m.text,
          timestamp: m.sys_created_on,
        }))
      }
    }

    return createSuccessResult({
      conversation: {
        sys_id: conversation.sys_id,
        user: conversation.user,
        status: conversation.status,
        started: conversation.sys_created_on,
      },
      transcript,
      message_count: transcript.length,
      message: `💬 Conversation retrieved with ${transcript.length} message(s)`,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
