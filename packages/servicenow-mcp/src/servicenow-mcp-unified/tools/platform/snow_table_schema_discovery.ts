/**
 * snow_table_schema_discovery - Discover table schemas
 *
 * Comprehensive table schema discovery including fields, relationships, ACLs, and business rules.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_table_schema_discovery",
  description: "Discover comprehensive table schema including fields, relationships, ACLs, and business rules",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "discovery",
  use_cases: ["schema-discovery", "table-analysis", "metadata"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Query/analysis operation
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      table_name: { type: "string", description: "Table name to discover schema" },
      include_fields: { type: "boolean", description: "Include field definitions", default: true },
      include_relationships: { type: "boolean", description: "Include table relationships", default: true },
      include_acls: { type: "boolean", description: "Include access control rules", default: false },
      include_business_rules: { type: "boolean", description: "Include business rules", default: false },
      include_ui_policies: { type: "boolean", description: "Include UI policies", default: false },
    },
    required: ["table_name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    table_name,
    include_fields = true,
    include_relationships = true,
    include_acls = false,
    include_business_rules = false,
    include_ui_policies = false,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    const schema: any = {
      table_name,
      discovered_at: new Date().toISOString(),
    }

    // Get table metadata
    const tableResponse = await client.get("/api/now/table/sys_db_object", {
      params: {
        sysparm_query: `name=${table_name}`,
        sysparm_limit: 1,
      },
    })

    if (!tableResponse.data.result || tableResponse.data.result.length === 0) {
      return createErrorResult(`Table '${table_name}' not found`)
    }

    const tableData = tableResponse.data.result[0]
    schema.label = tableData.label
    schema.extends_table = tableData.super_class?.value || null
    schema.is_extendable = tableData.is_extendable
    schema.number_ref = tableData.number_ref

    // Get fields
    if (include_fields) {
      schema.fields = await discoverFields(client, table_name)
    }

    // Get relationships
    if (include_relationships) {
      schema.relationships = await discoverRelationships(client, table_name)
    }

    // Get ACLs
    if (include_acls) {
      schema.access_controls = await discoverACLs(client, table_name)
    }

    // Get business rules
    if (include_business_rules) {
      schema.business_rules = await discoverBusinessRules(client, table_name)
    }

    // Get UI policies
    if (include_ui_policies) {
      schema.ui_policies = await discoverUIPolicies(client, table_name)
    }

    return createSuccessResult({ schema }, { table_name })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

async function discoverFields(client: any, tableName: string): Promise<any[]> {
  const fieldsResponse = await client.get("/api/now/table/sys_dictionary", {
    params: {
      sysparm_query: `name=${tableName}`,
      sysparm_limit: 500,
      sysparm_fields: "element,column_label,internal_type,max_length,mandatory,read_only,reference,default_value",
    },
  })

  const fields = fieldsResponse.data.result || []

  return fields.map((field: any) => ({
    name: field.element,
    label: field.column_label,
    type: field.internal_type,
    max_length: field.max_length,
    mandatory: field.mandatory === "true",
    read_only: field.read_only === "true",
    reference: field.reference?.value || null,
    default_value: field.default_value,
  }))
}

async function discoverRelationships(client: any, tableName: string): Promise<any> {
  const relationships: any = {
    references_from: [],
    references_to: [],
    extensions: [],
  }

  // Find fields that reference this table
  const referencesFromResponse = await client.get("/api/now/table/sys_dictionary", {
    params: {
      sysparm_query: `reference=${tableName}`,
      sysparm_limit: 100,
      sysparm_fields: "name,element,column_label",
    },
  })

  const referencesFrom = referencesFromResponse.data.result || []
  relationships.references_from = referencesFrom.map((ref: any) => ({
    table: ref.name,
    field: ref.element,
    label: ref.column_label,
  }))

  // Find fields in this table that reference other tables
  const referencesToResponse = await client.get("/api/now/table/sys_dictionary", {
    params: {
      sysparm_query: `name=${tableName}^referenceISNOTEMPTY`,
      sysparm_limit: 100,
      sysparm_fields: "element,reference,column_label",
    },
  })

  const referencesTo = referencesToResponse.data.result || []
  relationships.references_to = referencesTo.map((ref: any) => ({
    field: ref.element,
    references_table: ref.reference?.value || ref.reference,
    label: ref.column_label,
  }))

  // Find tables that extend this table
  const extensionsResponse = await client.get("/api/now/table/sys_db_object", {
    params: {
      sysparm_query: `super_class.name=${tableName}`,
      sysparm_limit: 50,
      sysparm_fields: "name,label",
    },
  })

  const extensions = extensionsResponse.data.result || []
  relationships.extensions = extensions.map((ext: any) => ({
    table: ext.name,
    label: ext.label,
  }))

  return relationships
}

async function discoverACLs(client: any, tableName: string): Promise<any[]> {
  const aclResponse = await client.get("/api/now/table/sys_security_acl", {
    params: {
      sysparm_query: `name=${tableName}^ORname=*${tableName}.*`,
      sysparm_limit: 100,
      sysparm_fields: "name,operation,admin_overrides,active",
    },
  })

  const acls = aclResponse.data.result || []

  return acls.map((acl: any) => ({
    name: acl.name,
    operation: acl.operation,
    admin_overrides: acl.admin_overrides === "true",
    active: acl.active === "true",
  }))
}

async function discoverBusinessRules(client: any, tableName: string): Promise<any[]> {
  const rulesResponse = await client.get("/api/now/table/sys_script", {
    params: {
      sysparm_query: `collection=${tableName}`,
      sysparm_limit: 100,
      sysparm_fields: "name,when,order,active,filter_condition",
    },
  })

  const rules = rulesResponse.data.result || []

  return rules.map((rule: any) => ({
    name: rule.name,
    when: rule.when,
    order: rule.order,
    active: rule.active === "true",
    has_condition: !!rule.filter_condition,
  }))
}

async function discoverUIPolicies(client: any, tableName: string): Promise<any[]> {
  const policiesResponse = await client.get("/api/now/table/sys_ui_policy", {
    params: {
      sysparm_query: `table=${tableName}`,
      sysparm_limit: 100,
      sysparm_fields: "short_description,on_load,reverse_if_false,active",
    },
  })

  const policies = policiesResponse.data.result || []

  return policies.map((policy: any) => ({
    description: policy.short_description,
    on_load: policy.on_load === "true",
    reverse_if_false: policy.reverse_if_false === "true",
    active: policy.active === "true",
  }))
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
