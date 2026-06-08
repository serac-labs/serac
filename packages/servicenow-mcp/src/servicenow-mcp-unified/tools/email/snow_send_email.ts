/**
 * snow_send_email - Send email notifications via ServiceNow
 *
 * Creates email records in sys_email table which are processed by ServiceNow's
 * email engine. Supports recipients by username, email address, or sys_id.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_send_email",
  description: "Send email notification via sys_email table (supports username, email, or sys_id)",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "notifications",
  use_cases: ["email", "notifications", "communication"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Creates sys_email record
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Recipient: username (admin), email (user@example.com), or sys_id",
      },
      subject: { type: "string", description: "Email subject" },
      body: { type: "string", description: "Email body (HTML supported)" },
      body_text: { type: "string", description: "Plain text email body (alternative to body)" },
      from: { type: "string", description: "Sender email address" },
      reply_to: { type: "string", description: "Reply-to email address" },
      cc: { type: "string", description: "CC recipients (comma-separated)" },
      bcc: { type: "string", description: "BCC recipients (comma-separated)" },
      importance: { type: "string", enum: ["low", "normal", "high"], default: "normal" },
    },
    required: ["to", "subject"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { to, subject, body, body_text, from, reply_to, cc, bcc, importance = "normal" } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Resolve recipient to user sys_id if it's a username
    let recipientsSysId = to
    let recipientsEmail = to

    // Check if 'to' is a username (no @ sign and no sys_id format)
    if (!to.includes("@") && !to.match(/^[0-9a-f]{32}$/i)) {
      // Try to resolve as username
      try {
        const userResponse = await client.get("/api/now/table/sys_user", {
          params: {
            sysparm_query: `user_name=${to}^ORemail=${to}`,
            sysparm_fields: "sys_id,email,user_name,name",
            sysparm_limit: 1,
          },
        })

        if (userResponse.data.result && userResponse.data.result.length > 0) {
          const user = userResponse.data.result[0]
          recipientsSysId = user.sys_id
          recipientsEmail = user.email || to
        }
      } catch (userError) {
        // If user lookup fails, treat as email address
        console.warn(`Could not resolve user '${to}', treating as email address`)
      }
    }

    // Build email record
    const emailData: any = {
      recipients: recipientsEmail,
      subject: subject,
      body: body || body_text || "",
      type: "send-ready",
      state: "ready",
    }

    // Add optional fields
    if (from) {
      emailData.from = from
    }

    if (reply_to) {
      emailData.reply_to = reply_to
    }

    if (cc) {
      emailData.cc = cc
    }

    if (bcc) {
      emailData.bcc = bcc
    }

    // Set importance/priority
    if (importance === "high") {
      emailData.importance = "high"
    } else if (importance === "low") {
      emailData.importance = "low"
    }

    // If 'to' is a user sys_id, also set user field
    if (recipientsSysId.match(/^[0-9a-f]{32}$/i)) {
      emailData.user = recipientsSysId
    }

    // Create email record
    const response = await client.post("/api/now/table/sys_email", emailData)

    const emailRecord = response.data.result

    return createSuccessResult({
      sent: true,
      email_sys_id: emailRecord.sys_id,
      recipients: recipientsEmail,
      subject: emailRecord.subject,
      state: emailRecord.state,
      type: emailRecord.type,
      message: "Email queued for delivery by ServiceNow email engine",
    })
  } catch (error: any) {
    // Extract ServiceNow error details
    const snowError = error.response?.data?.error || {}
    const errorMessage = snowError.message || error.message
    const errorDetail = snowError.detail || ""

    if (error.response?.status === 400) {
      return createErrorResult(
        new SnowFlowError(ErrorType.VALIDATION_ERROR, `Failed to send email: ${errorMessage}`, {
          details: {
            status_code: 400,
            snow_error: snowError,
            error_detail: errorDetail,
            provided_data: { to, subject },
            suggestion: "Verify recipient format (username, email, or sys_id) and that required fields are provided",
          },
        }),
      )
    }

    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, `Failed to send email: ${errorMessage}`, {
            details: {
              snow_error: snowError,
              error_detail: errorDetail,
              status_code: error.response?.status,
            },
          }),
    )
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
