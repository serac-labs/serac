/**
 * snow_discover_table_fields - Discover table schema
 *
 * Get comprehensive table schema information including fields,
 * relationships, indexes, and ACLs.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_discover_table_fields",
  description: "Discover table schema with fields, types, relationships, and metadata",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "schema",
  use_cases: ["discovery", "schema"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Discovery operation - reads metadata
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table_name: {
        type: "string",
        description: "Table name to discover schema for",
      },
      include_relationships: {
        type: "boolean",
        description: "Include field relationships (reference fields)",
        default: true,
      },
      include_acls: {
        type: "boolean",
        description: "Include ACL information",
        default: false,
      },
      include_indexes: {
        type: "boolean",
        description: "Include index information",
        default: false,
      },
    },
    required: ["table_name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { table_name, include_relationships = true, include_acls = false, include_indexes = false } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Step 1: Get table metadata
    const tableResponse = await client.get("/api/now/table/sys_db_object", {
      params: {
        sysparm_query: `name=${table_name}`,
        sysparm_limit: 1,
      },
    })

    if (tableResponse.data.result.length === 0) {
      return createErrorResult(`Table not found: ${table_name}`)
    }

    const tableInfo = tableResponse.data.result[0]

    // Step 2: Get all fields for the table
    const fieldsResponse = await client.get("/api/now/table/sys_dictionary", {
      params: {
        sysparm_query: `name=${table_name}^element!=NULL^ORDERBYelement`,
        sysparm_limit: 1000,
      },
    })

    const fields = fieldsResponse.data.result.map((field: any) => ({
      name: field.element,
      label: field.column_label,
      type: field.internal_type?.display_value || field.internal_type,
      max_length: field.max_length,
      mandatory: field.mandatory === "true",
      read_only: field.read_only === "true",
      default_value: field.default_value,
      reference: field.reference?.display_value || field.reference,
      help_text: field.help,
    }))

    // Step 3: Get relationships if requested
    let relationships: any[] = []
    if (include_relationships) {
      const refFields = fields.filter((f: any) => f.type === "reference")
      relationships = refFields.map((f: any) => ({
        field: f.name,
        references_table: f.reference,
        type: "many-to-one",
      }))
    }

    // Step 4: Get ACLs if requested
    let acls: any[] = []
    if (include_acls) {
      const aclResponse = await client.get("/api/now/table/sys_security_acl", {
        params: {
          sysparm_query: `name=${table_name}`,
          sysparm_limit: 100,
        },
      })
      acls = aclResponse.data.result.map((acl: any) => ({
        operation: acl.operation,
        roles: acl.roles,
        condition: acl.condition,
        script: acl.script ? "Present" : "None",
      }))
    }

    // Step 5: Get indexes if requested
    let indexes: any[] = []
    if (include_indexes) {
      const indexResponse = await client.get("/api/now/table/sys_db_index", {
        params: {
          sysparm_query: `table=${table_name}`,
          sysparm_limit: 100,
        },
      })
      indexes = indexResponse.data.result.map((idx: any) => ({
        name: idx.name,
        fields: idx.field_list,
        unique: idx.unique === "true",
      }))
    }

    return createSuccessResult({
      table: {
        name: table_name,
        label: tableInfo.label,
        extends: tableInfo.super_class?.display_value || null,
        sys_id: tableInfo.sys_id,
      },
      fields,
      field_count: fields.length,
      relationships,
      acls: include_acls ? acls : undefined,
      indexes: include_indexes ? indexes : undefined,
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
