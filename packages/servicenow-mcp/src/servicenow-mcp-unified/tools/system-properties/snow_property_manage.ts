/**
 * snow_property_manage - Unified System Property Management
 *
 * Comprehensive tool for system property management: get, set, delete, validate.
 *
 * Replaces: snow_property_get, snow_property_set, snow_property_delete, snow_property_validate
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_property_manage",
  description: "Unified tool for system property management (get, set, delete, validate)",
  // Metadata for tool discovery (not sent to LLM)
  category: "core-operations",
  subcategory: "properties",
  use_cases: ["properties", "configuration", "system-settings"],
  complexity: "beginner",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Management operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Management action to perform",
        enum: ["get", "set", "delete", "validate"],
      },
      name: {
        type: "string",
        description: "Property name (e.g., glide.servlet.uri)",
      },
      // GET parameters
      include_metadata: {
        type: "boolean",
        description: "[get] Include full property metadata",
        default: false,
      },
      // SET parameters
      value: {
        type: "string",
        description: "[set/validate] Property value",
      },
      description: {
        type: "string",
        description: "[set] Property description",
      },
      type: {
        type: "string",
        description: "[set] Property type (string, boolean, integer, etc.)",
        default: "string",
      },
      choices: {
        type: "string",
        description: "[set] Comma-separated list of valid choices",
      },
      is_private: {
        type: "boolean",
        description: "[set] Mark property as private",
        default: false,
      },
      suffix: {
        type: "string",
        description: "[set] Property suffix/scope",
      },
      // DELETE parameters
      confirm: {
        type: "boolean",
        description: "[delete] Confirmation flag (must be true)",
        default: false,
      },
    },
    required: ["action", "name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    switch (action) {
      case "get":
        return await executeGet(args, context)
      case "set":
        return await executeSet(args, context)
      case "delete":
        return await executeDelete(args, context)
      case "validate":
        return await executeValidate(args, context)
      default:
        return createErrorResult(`Unknown action: ${action}`)
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== GET ====================
async function executeGet(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, include_metadata = false } = args
  const client = await getAuthenticatedClient(context)

  const response = await client.get("/api/now/table/sys_properties", {
    params: {
      sysparm_query: `name=${name}`,
      sysparm_limit: 1,
    },
  })

  if (!response.data.result || response.data.result.length === 0) {
    return createErrorResult(`Property not found: ${name}`)
  }

  const property = response.data.result[0]

  if (include_metadata) {
    return createSuccessResult({
      name: property.name,
      value: property.value || "",
      type: property.type || "string",
      description: property.description || "",
      suffix: property.suffix || "global",
      is_private: property.is_private === "true",
      choices: property.choices || "",
      sys_id: property.sys_id,
    })
  } else {
    return createSuccessResult({
      value: property.value || "",
    })
  }
}

// ==================== SET ====================
async function executeSet(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, value, description, type = "string", choices, is_private = false, suffix } = args

  if (!value) {
    return createErrorResult("value is required for set action")
  }

  const client = await getAuthenticatedClient(context)

  // Check if property exists
  const existingResponse = await client.get("/api/now/table/sys_properties", {
    params: {
      sysparm_query: `name=${name}`,
      sysparm_limit: 1,
    },
  })

  let result
  if (existingResponse.data.result && existingResponse.data.result.length > 0) {
    // Update existing property
    const sys_id = existingResponse.data.result[0].sys_id
    const updateData: any = {
      value,
    }

    if (description) updateData.description = description
    if (type) updateData.type = type
    if (choices !== undefined) updateData.choices = choices
    if (suffix) updateData.suffix = suffix
    updateData.is_private = is_private ? "true" : "false"

    result = await client.put(`/api/now/table/sys_properties/${sys_id}`, updateData)

    return createSuccessResult({
      action: "updated",
      name,
      value,
      type,
      description,
      is_private,
      message: "Property updated successfully",
    })
  } else {
    // Create new property
    const createData: any = {
      name,
      value,
      description: description || "Created by Serac",
      type,
      choices: choices || "",
      is_private: is_private ? "true" : "false",
      suffix: suffix || "global",
    }

    result = await client.post("/api/now/table/sys_properties", createData)

    return createSuccessResult({
      action: "created",
      name,
      value,
      type,
      description,
      is_private,
      message: "Property created successfully",
    })
  }
}

// ==================== DELETE ====================
async function executeDelete(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, confirm = false } = args

  if (!confirm) {
    return createErrorResult(
      "Deletion requires confirmation. Set confirm: true to proceed. WARNING: Deleting system properties can affect ServiceNow functionality!",
    )
  }

  const client = await getAuthenticatedClient(context)

  // Find the property
  const response = await client.get("/api/now/table/sys_properties", {
    params: {
      sysparm_query: `name=${name}`,
      sysparm_limit: 1,
    },
  })

  if (!response.data.result || response.data.result.length === 0) {
    return createErrorResult(`Property not found: ${name}`)
  }

  const sys_id = response.data.result[0].sys_id
  await client.delete(`/api/now/table/sys_properties/${sys_id}`)

  return createSuccessResult({
    deleted: true,
    name,
    message:
      "Property deleted successfully. Note: Some properties may be recreated by ServiceNow on next access with default values.",
  })
}

// ==================== VALIDATE ====================
async function executeValidate(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { name, value } = args

  if (!value) {
    return createErrorResult("value is required for validate action")
  }

  const client = await getAuthenticatedClient(context)

  // Get property metadata
  const response = await client.get("/api/now/table/sys_properties", {
    params: {
      sysparm_query: `name=${name}`,
      sysparm_limit: 1,
    },
  })

  if (!response.data.result || response.data.result.length === 0) {
    return createErrorResult(`Property not found: ${name}. Cannot validate.`)
  }

  const property = response.data.result[0]
  const validationResults: string[] = []
  let isValid = true

  // Type validation
  if (property.type) {
    switch (property.type) {
      case "boolean":
        if (!["true", "false", "1", "0"].includes(value.toLowerCase())) {
          validationResults.push("Value must be true/false")
          isValid = false
        } else {
          validationResults.push("Valid boolean value")
        }
        break
      case "integer":
        if (!/^-?\d+$/.test(value)) {
          validationResults.push("Value must be an integer")
          isValid = false
        } else {
          validationResults.push("Valid integer value")
        }
        break
      case "float":
      case "decimal":
        if (!/^-?\d*\.?\d+$/.test(value)) {
          validationResults.push("Value must be a number")
          isValid = false
        } else {
          validationResults.push("Valid numeric value")
        }
        break
      case "string":
      default:
        validationResults.push("Valid string value")
    }
  }

  // Choices validation
  if (property.choices) {
    const validChoices = property.choices.split(",").map((c: string) => c.trim())
    if (!validChoices.includes(value)) {
      validationResults.push(`Value must be one of: ${validChoices.join(", ")}`)
      isValid = false
    } else {
      validationResults.push("Valid choice")
    }
  }

  return createSuccessResult({
    valid: isValid,
    property_name: name,
    current_value: property.value,
    new_value: value,
    type: property.type || "string",
    choices: property.choices || null,
    validation_results: validationResults,
    message: isValid ? "VALID" : "INVALID",
  })
}

export const version = "2.0.0"
export const author = "Serac v8.2.0 Tool Merging"
