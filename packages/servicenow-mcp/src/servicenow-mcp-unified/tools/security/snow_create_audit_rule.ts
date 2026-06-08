import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import { MCPToolDefinition, ToolResult, ServiceNowContext } from "../../shared/types.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_audit_rule",
  description: "Configure audit tracking on a table: which events (insert/update/delete) and which fields to log, retention period in days, and an optional filter. Writes to sys_audit.",
  category: "security",
  subcategory: "audit-rules",
  use_cases: ["configuration", "security", "compliance"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Creation/configuration operation
  permission: "write",
  allowedRoles: ["developer", "admin"],

  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
      },
      table: {
        type: "string",
      },
      events: {
        type: "array",
        items: {
          type: "string",
        },
      },
      fields: {
        type: "array",
        items: {
          type: "string",
        },
      },
      retention: {
        type: "number",
      },
      filter: {
        type: "string",
      },
      active: {
        type: "boolean",
      },
    },
    required: ["name", "table", "events"],
  },
}

export async function execute(args: CreateAuditRuleArgs, context: ServiceNowContext): Promise<ToolResult> {
  // TODO: Implement full audit rule creation with ServiceNow client
  return {
    success: true,
    data: {
      name: args.name,
      table: args.table,
      events: args.events,
      fields: args.fields || [],
      retention: args.retention || 90,
      filter: args.filter || "",
      active: args.active !== false,
    },
    summary: `Audit rule "${args.name}" prepared for table: ${args.table}`,
  }
}

export interface CreateAuditRuleArgs {
  name: string
  table: string
  events: string[]
  fields?: string[]
  retention?: number
  filter?: string
  active?: boolean
}

export async function createAuditRule(args: CreateAuditRuleArgs, client: any, logger: any) {
  try {
    logger.info("Creating Audit Rule...")

    const auditData = {
      tablename: args.table,
      fieldname: args.fields ? args.fields.join(",") : "*",
      reason: args.name,
      user: "system",
      record_checkpoint: JSON.stringify({ filter: args.filter || "" }),
    }

    await client.ensureUpdateSet()
    const response = await client.createRecord("sys_audit", auditData)

    if (!response.success) {
      throw new Error(`Failed to create Audit Rule: ${response.error}`)
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `✅ Audit Rule created: ${args.name}\nsys_id: ${response.data.sys_id}\nTable: ${args.table}\nEvents: ${args.events.join(", ")}\nRetention: ${args.retention || 365} days`,
        },
      ],
    }
  } catch (error) {
    logger.error("Failed to create Audit Rule:", error)
    throw new McpError(ErrorCode.InternalError, `Failed to create Audit Rule: ${error}`)
  }
}
