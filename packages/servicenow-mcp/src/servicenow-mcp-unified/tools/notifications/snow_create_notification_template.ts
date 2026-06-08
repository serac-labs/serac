/**
 * snow_create_notification_template - Create notification templates
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_notification_template",
  description: "Create reusable notification template with multi-channel support",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "notifications",
  use_cases: ["templates", "notifications", "multi-channel"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      template_name: {
        type: "string",
        description: "Template name",
      },
      template_type: {
        type: "string",
        description: "Template type",
        enum: ["incident", "change", "approval", "alert", "reminder"],
      },
      subject_template: {
        type: "string",
        description: 'Subject template with variables (e.g., "Incident ${number} assigned")',
      },
      body_template: {
        type: "string",
        description: "Body template with variables",
      },
      channels: {
        type: "array",
        items: { type: "string" },
        description: "Supported channels",
        default: ["email"],
      },
      active: {
        type: "boolean",
        description: "Template is active",
        default: true,
      },
    },
    required: ["template_name", "template_type", "subject_template", "body_template"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { template_name, template_type, subject_template, body_template, channels = ["email"], active = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Create notification template in sysevent_email_template table
    const response = await client.post("/api/now/table/sysevent_email_template", {
      name: template_name,
      type: template_type,
      subject: subject_template,
      message: body_template,
      active: active,
      description: `Template for ${template_type} notifications - Channels: ${channels.join(", ")}`,
    })

    return createSuccessResult({
      created: true,
      template: response.data.result,
      sys_id: response.data.result.sys_id,
      channels: channels,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
