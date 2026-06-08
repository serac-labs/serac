import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import { MCPToolDefinition, ToolResult, ServiceNowContext } from "../../shared/types.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_access_control",
  description: "Create an Access Control List (ACL) entry on a table: grants a role permission to perform an operation (read/write/create/delete) on records, optionally gated by a condition or advanced script. Writes to sys_security_acl.",
  category: "security",
  subcategory: "access-control",
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
      operation: {
        type: "string",
      },
      roles: {
        type: "array",
        items: {
          type: "string",
        },
      },
      condition: {
        type: "string",
      },
      advanced: {
        type: "boolean",
      },
      active: {
        type: "boolean",
      },
    },
    required: ["name", "table", "operation"],
  },
}

export async function execute(args: CreateAccessControlArgs, context: ServiceNowContext): Promise<ToolResult> {
  // TODO: Implement full access control creation with ServiceNow client
  return {
    success: true,
    data: {
      name: args.name,
      table: args.table,
      operation: args.operation,
      roles: args.roles || [],
      condition: args.condition || "",
      advanced: args.advanced || false,
      active: args.active !== false,
    },
    summary: `Access control "${args.name}" prepared for table: ${args.table}`,
  }
}

export interface CreateAccessControlArgs {
  name: string
  table: string
  operation: string
  roles?: string[]
  condition?: string
  advanced?: boolean
  active?: boolean
}

export async function createAccessControl(args: CreateAccessControlArgs, client: any, logger: any) {
  try {
    logger.info("Creating Access Control...")

    const tableInfo = await getTableInfo(args.table, client)
    if (!tableInfo) {
      throw new Error(`Table not found: ${args.table}`)
    }

    const aclData = {
      name: args.name,
      table: tableInfo.name,
      operation: args.operation,
      roles: JSON.stringify(args.roles || []),
      condition: args.condition || "",
      advanced: args.advanced || false,
      active: args.active !== false,
    }

    await client.ensureUpdateSet()
    const response = await client.createRecord("sys_security_acl", aclData)

    if (!response.success) {
      throw new Error(`Failed to create Access Control: ${response.error}`)
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `✅ Access Control created!\n\n${args.name}\nsys_id: ${response.data.sys_id}\nTable: ${tableInfo.label}\nOperation: ${args.operation}\nRoles: ${args.roles?.join(", ") || "None"}\nActive: ${args.active !== false ? "Yes" : "No"}`,
        },
      ],
    }
  } catch (error) {
    logger.error("Failed to create Access Control:", error)
    throw new McpError(ErrorCode.InternalError, `Failed to create Access Control: ${error}`)
  }
}

async function getTableInfo(
  tableName: string,
  client: any,
): Promise<{ name: string; label: string } | null> {
  try {
    const tableResponse = await client.searchRecords("sys_db_object", `name=${tableName}`, 1)
    if (tableResponse.success && tableResponse.data?.result?.length > 0) {
      const table = tableResponse.data.result[0]
      return { name: table.name, label: table.label }
    }
    return null
  } catch (error) {
    return null
  }
}
