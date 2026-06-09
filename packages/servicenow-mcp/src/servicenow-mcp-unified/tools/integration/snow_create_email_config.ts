/**
 * snow_create_email_config - Email server configuration
 *
 * Create email server configurations for SMTP, POP3, or IMAP.
 * Configures ports, encryption, and authentication.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_email_config",
  description: "Create email server configuration for SMTP, POP3, or IMAP",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "email",
  use_cases: ["integration", "email", "configuration"],
  complexity: "intermediate",
  frequency: "low",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Email configuration name",
      },
      serverType: {
        type: "string",
        enum: ["SMTP", "POP3", "IMAP", "SMTPS", "POP3S", "IMAPS"],
        description: "Email server type",
      },
      serverName: {
        type: "string",
        description: "Email server hostname or IP",
      },
      port: {
        type: "number",
        description: "Server port (default: auto-detect by type)",
      },
      encryption: {
        type: "string",
        enum: ["SSL", "TLS", "None"],
        description: "Encryption type",
        default: "None",
      },
      username: {
        type: "string",
        description: "Authentication username",
      },
      password: {
        type: "string",
        description: "Authentication password",
      },
      description: {
        type: "string",
        description: "Configuration description",
      },
      active: {
        type: "boolean",
        description: "Active flag",
        default: true,
      },
    },
    required: ["name", "serverType", "serverName"],
  },
}

const DEFAULT_PORTS: Record<string, number> = {
  SMTP: 587,
  SMTPS: 465,
  POP3: 110,
  POP3S: 995,
  IMAP: 143,
  IMAPS: 993,
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    serverType,
    serverName,
    port,
    encryption = "None",
    username = "",
    password = "",
    description = "",
    active = true,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Auto-detect port if not specified
    const finalPort = port || DEFAULT_PORTS[serverType] || 25

    const emailConfigData = {
      name,
      type: serverType,
      server: serverName,
      port: finalPort,
      encryption,
      user_name: username,
      password,
      description,
      active,
    }

    const response = await client.post("/api/now/table/sys_email_account", emailConfigData)
    const emailConfig = response.data.result

    return createSuccessResult({
      created: true,
      email_config: {
        sys_id: emailConfig.sys_id,
        name: emailConfig.name,
        type: serverType,
        server: serverName,
        port: finalPort,
        encryption,
        active,
      },
      message: `Email configuration '${name}' created successfully for ${serverType} on ${serverName}:${finalPort}`,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
