/**
 * snow_get_email_logs - View sent/received email logs
 *
 * Retrieve email records from sys_email table to monitor
 * email notifications, delivery status, and troubleshoot issues.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_get_email_logs",
  description: "Retrieve sent/received email logs from sys_email table for monitoring and debugging",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "monitoring",
  use_cases: ["email", "notifications", "monitoring", "debugging"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Get operation - retrieves data
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["sent", "received", "send-ready", "failed", "all"],
        description: "Email type/status filter",
        default: "all",
      },
      recipient: {
        type: "string",
        description: "Filter by recipient email address",
      },
      sender: {
        type: "string",
        description: "Filter by sender email address",
      },
      subject: {
        type: "string",
        description: "Search in email subject",
      },
      limit: {
        type: "number",
        description: "Maximum number of email records to return",
        default: 50,
        minimum: 1,
        maximum: 500,
      },
      since: {
        type: "string",
        description: 'Get emails since this timestamp (ISO 8601 or relative like "1h", "30m", "7d")',
      },
      include_body: {
        type: "boolean",
        description: "Include email body in response (can be large)",
        default: false,
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var type = args.type || "all"
  var recipient = args.recipient
  var sender = args.sender
  var subject = args.subject
  var limit = args.limit || 50
  var since = args.since
  var include_body = args.include_body || false

  try {
    var client = await getAuthenticatedClient(context)

    // Build query
    var queryParts: string[] = []

    // Type/status filter
    if (type !== "all") {
      queryParts.push("type=" + type)
    }

    // Recipient filter
    if (recipient) {
      queryParts.push("recipientsLIKE" + recipient)
    }

    // Sender filter
    if (sender) {
      queryParts.push("fromLIKE" + sender)
    }

    // Subject search
    if (subject) {
      queryParts.push("subjectLIKE" + subject)
    }

    // Time range filter
    if (since) {
      var sinceTimestamp = parseRelativeTime(since)
      queryParts.push("sys_created_on>" + sinceTimestamp)
    }

    var query = queryParts.join("^")

    // Build fields list
    var fields = "sys_id,sys_created_on,type,subject,recipients,from,cc,bcc,state,error_string,mailbox,content_type"
    if (include_body) {
      fields += ",body,body_text"
    }

    // Get emails from sys_email table
    var response = await client.get("/api/now/table/sys_email", {
      params: {
        sysparm_query: query + "^ORDERBYDESCsys_created_on",
        sysparm_limit: limit,
        sysparm_fields: fields,
      },
    })

    var emails = response.data.result.map(function (email: any) {
      var record: any = {
        sys_id: email.sys_id,
        timestamp: email.sys_created_on,
        type: email.type,
        state: email.state,
        subject: email.subject,
        from: email.from,
        recipients: email.recipients,
        cc: email.cc || null,
        bcc: email.bcc || null,
        mailbox: email.mailbox,
        content_type: email.content_type,
        error: email.error_string || null,
      }

      if (include_body) {
        record.body = email.body || email.body_text
      }

      return record
    })

    // Categorize by type/state
    var byType: any = {
      sent: 0,
      received: 0,
      "send-ready": 0,
      failed: 0,
    }

    emails.forEach(function (e: any) {
      if (e.state === "error" || e.error) {
        byType.failed++
      } else if (byType[e.type] !== undefined) {
        byType[e.type]++
      }
    })

    return createSuccessResult({
      emails: emails,
      count: emails.length,
      by_type: byType,
      filters: { type: type, recipient: recipient, sender: sender, subject: subject, since: since },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

function parseRelativeTime(relative: string): string {
  var now = new Date()
  var match = relative.match(/^(\d+)([mhd])$/)

  if (!match) {
    // Assume it's an absolute timestamp
    return relative
  }

  var value = parseInt(match[1])
  var unit = match[2]

  var milliseconds = 0
  switch (unit) {
    case "m":
      milliseconds = value * 60 * 1000
      break
    case "h":
      milliseconds = value * 60 * 60 * 1000
      break
    case "d":
      milliseconds = value * 24 * 60 * 60 * 1000
      break
  }

  var sinceDate = new Date(now.getTime() - milliseconds)
  return sinceDate.toISOString()
}

export const version = "1.0.0"
export const author = "Serac Team"
