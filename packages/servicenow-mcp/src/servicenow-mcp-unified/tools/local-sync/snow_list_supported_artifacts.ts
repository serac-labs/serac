/**
 * snow_list_supported_artifacts - List supported artifact types for local sync
 *
 * Returns comprehensive list of ServiceNow artifact types that can be pulled/pushed via local sync.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { createSuccessResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_list_supported_artifacts",
  description: "List all ServiceNow artifact types supported by local sync",
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "local-sync",
  use_cases: ["local-sync", "artifact-discovery", "sync-capabilities"],
  complexity: "beginner",
  frequency: "low",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      include_details: { type: "boolean", description: "Include field mappings and sync capabilities", default: false },
      category: {
        type: "string",
        description: "Filter by artifact category",
        enum: ["ui", "script", "flow", "data", "integration", "all"],
        default: "all",
      },
    },
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { include_details = false, category = "all" } = args

  const artifacts = getSupportedArtifacts(category)

  if (include_details) {
    return createSuccessResult(
      {
        total_count: artifacts.length,
        artifacts: artifacts.map((a) => ({
          ...a,
          fields: getArtifactFields(a.table),
          capabilities: getArtifactCapabilities(a.table),
        })),
      },
      { category },
    )
  }

  return createSuccessResult(
    {
      total_count: artifacts.length,
      artifacts: artifacts.map((a) => ({
        table: a.table,
        name: a.name,
        category: a.category,
        description: a.description,
      })),
    },
    { category },
  )
}

function getSupportedArtifacts(category: string): any[] {
  const allArtifacts = [
    // UI Artifacts
    {
      table: "sp_widget",
      name: "Service Portal Widget",
      category: "ui",
      description: "Service Portal widgets with HTML/CSS/JS",
    },
    { table: "sys_ux_page", name: "UI Builder Page", category: "ui", description: "UI Builder / Experience pages" },
    { table: "sys_ui_page", name: "UI Page", category: "ui", description: "Classic UI pages with HTML/Jelly" },
    { table: "sys_ui_macro", name: "UI Macro", category: "ui", description: "Reusable UI macros" },
    {
      table: "sys_ux_lib_component",
      name: "UI Component",
      category: "ui",
      description: "UI Builder custom components",
    },

    // Script Artifacts
    {
      table: "sys_script_include",
      name: "Script Include",
      category: "script",
      description: "Server-side reusable scripts",
    },
    {
      table: "sys_script",
      name: "Business Rule",
      category: "script",
      description: "Business rules for table operations",
    },
    { table: "sys_script_client", name: "Client Script", category: "script", description: "Client-side form scripts" },
    { table: "sys_ui_script", name: "UI Script", category: "script", description: "Global client-side scripts" },
    { table: "sys_script_fix", name: "Fix Script", category: "script", description: "One-time fix scripts" },
    { table: "sysauto_script", name: "Scheduled Job", category: "script", description: "Scheduled background scripts" },

    // Flow Artifacts
    { table: "sys_hub_flow", name: "Flow Designer Flow", category: "flow", description: "Flow Designer workflows" },
    { table: "sys_hub_action_type", name: "Flow Action", category: "flow", description: "Custom flow actions" },
    { table: "wf_workflow", name: "Workflow", category: "flow", description: "Classic workflow engine" },

    // Data Artifacts
    { table: "sys_transform_map", name: "Transform Map", category: "data", description: "Data transformation maps" },
    { table: "sys_import_set_row", name: "Import Set", category: "data", description: "Data import staging" },

    // Integration Artifacts
    {
      table: "sys_rest_message",
      name: "REST Message",
      category: "integration",
      description: "Outbound REST integrations",
    },
    { table: "sys_web_service", name: "Web Service", category: "integration", description: "SOAP web services" },
    { table: "sys_rest_message_fn", name: "REST Method", category: "integration", description: "REST message methods" },
  ]

  if (category === "all") {
    return allArtifacts
  }

  return allArtifacts.filter((a) => a.category === category)
}

function getArtifactFields(table: string): any {
  const fieldMappings: Record<string, any> = {
    sp_widget: {
      files: ["template.html", "script.js", "client_script.js", "css.css", "option_schema.json"],
      metadata: ["name", "description", "data_table", "public", "roles"],
    },
    sys_script_include: {
      files: ["script.js"],
      metadata: ["name", "description", "api_name", "client_callable", "access"],
    },
    sys_script: {
      files: ["script.js", "condition.js"],
      metadata: ["name", "table", "when", "order", "active", "filter_condition"],
    },
    sys_hub_flow: {
      files: ["flow_definition.json"],
      metadata: ["name", "description", "trigger_type", "active"],
    },
    sys_ux_page: {
      files: ["page_config.json"],
      metadata: ["name", "title", "route", "experience"],
    },
  }

  return fieldMappings[table] || { files: ["main.txt"], metadata: ["name"] }
}

function getArtifactCapabilities(table: string): any {
  return {
    supports_pull: true,
    supports_push: true,
    supports_es5_validation: ["sys_script_include", "sys_script", "sp_widget"].includes(table),
    supports_coherence_check: ["sp_widget"].includes(table),
    requires_update_set: true,
    supports_versioning: true,
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
