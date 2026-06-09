/**
 * snow_uib_component_manage - Unified UI Builder Component Management
 *
 * Comprehensive UIB component operations: create and clone custom components.
 *
 * Replaces: snow_create_uib_component, snow_clone_uib_component
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_uib_component_manage",
  description: "Unified UIB component management (create, clone)",
  category: "ui-frameworks",
  subcategory: "ui-builder",
  use_cases: ["component-creation", "component-cloning", "ui-builder"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Management operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Component management action",
        enum: ["create", "clone"],
      },
      // CREATE parameters
      name: { type: "string", description: "[create/clone] Component name (internal identifier)" },
      label: { type: "string", description: "[create/clone] Component label (display name)" },
      description: { type: "string", description: "[create/clone] Component description" },
      category: { type: "string", description: "[create/clone] Component category" },
      source_code: { type: "string", description: "[create] Component JavaScript source code" },
      template: { type: "string", description: "[create] Component HTML template" },
      styles: { type: "string", description: "[create] Component CSS styles" },
      properties: { type: "object", description: "[create] Component properties schema" },
      version: { type: "string", description: "[create/clone] Component version" },
      // CLONE parameters
      source_component_id: { type: "string", description: "[clone] Source component sys_id to clone" },
      new_name: { type: "string", description: "[clone] Name for cloned component" },
      new_label: { type: "string", description: "[clone] Label for cloned component" },
      modifications: { type: "object", description: "[clone] Specific modifications to apply" },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    switch (action) {
      case "create":
        return await executeCreate(args, context)
      case "clone":
        return await executeClone(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== CREATE ====================
async function executeCreate(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    label,
    description = "",
    category = "custom",
    source_code = "",
    template = "",
    styles = "",
    properties = {},
    version = "1.0.0",
  } = args

  if (!name) return createErrorResult("name required")
  if (!label) return createErrorResult("label required")

  const client = await getAuthenticatedClient(context)

  const payload: any = {
    name,
    label,
    description,
    category,
    version,
  }

  if (source_code) payload.source_code = source_code
  if (template) payload.template = template
  if (styles) payload.styles = styles
  if (Object.keys(properties).length > 0) payload.properties = JSON.stringify(properties)

  const response = await client.post("/api/now/table/sys_ux_lib_component", payload)

  return createSuccessResult({
    action: "create",
    component: {
      sys_id: response.data.result.sys_id,
      name,
      label,
      category,
    },
  })
}

// ==================== CLONE ====================
async function executeClone(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    source_component_id,
    new_name,
    new_label,
    modifications = {},
    category = "custom",
    version = "1.0.0",
    description = "",
  } = args

  if (!source_component_id) return createErrorResult("source_component_id required")
  if (!new_name) return createErrorResult("new_name required")
  if (!new_label) return createErrorResult("new_label required")

  const client = await getAuthenticatedClient(context)

  // Get source component
  const sourceResponse = await client.get(`/api/now/table/sys_ux_lib_component/${source_component_id}`)

  if (!sourceResponse.data.result) {
    return createErrorResult("Source component not found")
  }

  const sourceComponent = sourceResponse.data.result

  // Create cloned component
  const clonedComponent: any = {
    name: new_name,
    label: new_label,
    category,
    version,
    description: description || `Cloned from ${sourceComponent.name}`,
    source_code: sourceComponent.source_code,
    properties: sourceComponent.properties,
    template: sourceComponent.template,
  }

  // Apply modifications
  Object.keys(modifications).forEach((key) => {
    if (modifications[key] !== undefined) {
      clonedComponent[key] = modifications[key]
    }
  })

  const response = await client.post("/api/now/table/sys_ux_lib_component", clonedComponent)

  return createSuccessResult({
    action: "clone",
    component: {
      sys_id: response.data.result.sys_id,
      name: new_name,
      label: new_label,
      cloned_from: source_component_id,
    },
  })
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging - Phase 3"
