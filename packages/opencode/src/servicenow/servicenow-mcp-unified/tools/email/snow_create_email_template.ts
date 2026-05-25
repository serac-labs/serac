/**
 * snow_create_email_template
 *
 * Creates email templates in the sysevent_email_template table.
 * Supports HTML and plain text content with SMS alternate.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_email_template",
  description: "Create email notification template with HTML/text content and optional SMS alternate",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "notifications",
  use_cases: ["email", "templates", "notifications"],
  complexity: "beginner",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Template name (unique identifier)",
      },
      table: {
        type: "string",
        description: "Associated table name (e.g., incident, change_request)",
      },
      subject: {
        type: "string",
        description: "Email subject line (supports ${field} substitution)",
      },
      message_html: {
        type: "string",
        description: "HTML email body content (supports ${field} substitution for dynamic values)",
      },
      message_text: {
        type: "string",
        description: "Plain text email body (fallback for non-HTML email clients)",
      },
      sms_alternate: {
        type: "string",
        description: "Short SMS message alternate (for SMS notifications)",
      },
      content_type: {
        type: "string",
        enum: ["text/plain", "text/html"],
        default: "text/html",
        description: "Content type of the email template",
      },
      description: {
        type: "string",
        description: "Description of the template purpose",
      },
      active: {
        type: "boolean",
        default: true,
        description: "Whether the template is active",
      },
    },
    required: ["name", "subject"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var name = args.name
  var table = args.table
  var subject = args.subject
  var message_html = args.message_html
  var message_text = args.message_text
  var sms_alternate = args.sms_alternate
  var content_type = args.content_type || "text/html"
  var description = args.description
  var active = args.active !== undefined ? args.active : true

  try {
    var client = await getAuthenticatedClient(context)

    // Build template data with correct ServiceNow field names
    var templateData: any = {
      name: name,
      subject: subject,
      active: active,
    }

    // Map to correct ServiceNow fields
    if (message_html) {
      templateData.message_html = message_html
      // Also set 'message' field which some ServiceNow versions use
      templateData.message = message_html
    }
    if (message_text) {
      templateData.message_text = message_text
    }
    if (sms_alternate) {
      templateData.sms_alternate = sms_alternate
    }
    if (content_type) {
      templateData.content_type = content_type
    }
    if (table) {
      templateData.collection = table // ServiceNow uses 'collection' for table reference
    }
    if (description) {
      templateData.description = description
    }

    var response = await client.post("/api/now/table/sysevent_email_template", templateData)
    var result = response.data.result

    return createSuccessResult({
      created: true,
      template: {
        sys_id: result.sys_id,
        name: result.name,
        subject: result.subject,
        table: result.collection,
        content_type: result.content_type,
        has_html: Boolean(result.message_html || result.message),
        has_text: Boolean(result.message_text),
        has_sms: Boolean(result.sms_alternate),
        active: result.active === "true",
      },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
