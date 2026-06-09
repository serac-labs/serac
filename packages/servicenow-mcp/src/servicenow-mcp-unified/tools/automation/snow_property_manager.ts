/**
 * snow_property_manager - Enhanced property management
 *
 * Unified tool for getting, setting, and validating system properties with
 * automatic sensitive value masking.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_property_manager",
  description: "Enhanced property management with get, set, and validation in one tool",
  // Metadata for tool discovery (not sent to LLM)
  category: "automation",
  subcategory: "configuration",
  use_cases: ["automation", "properties", "configuration"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: WRITE - Management function - manages properties
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["get", "set", "validate"],
        description: "Action to perform: get, set, or validate",
      },
      name: {
        type: "string",
        description: "Property name",
      },
      value: {
        type: "string",
        description: "Property value (required for set action)",
      },
      mask_sensitive: {
        type: "boolean",
        description: "Mask sensitive values like API keys",
        default: true,
      },
    },
    required: ["action", "name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action, name, value, mask_sensitive = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    switch (action) {
      case "get":
        return await getProperty(client, name, mask_sensitive)

      case "set":
        if (!value) {
          throw new SnowFlowError(ErrorType.INVALID_REQUEST, "value is required for set action", { retryable: false })
        }
        return await setProperty(client, name, value)

      case "validate":
        return await validateProperty(client, name)

      default:
        throw new SnowFlowError(ErrorType.INVALID_REQUEST, `Invalid action: ${action}`, { retryable: false })
    }
  } catch (error: any) {
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, error.message, { originalError: error }),
    )
  }
}

async function getProperty(client: any, name: string, maskSensitive: boolean): Promise<ToolResult> {
  const response = await client.get(`/api/now/table/sys_properties?sysparm_query=name=${name}&sysparm_limit=1`)

  if (!response.data.result || response.data.result.length === 0) {
    throw new SnowFlowError(ErrorType.NOT_FOUND, `Property not found: ${name}`, { retryable: false })
  }

  const property = response.data.result[0]
  let propertyValue = property.value

  // Mask sensitive values
  if (maskSensitive && isSensitiveProperty(name)) {
    propertyValue = maskValue(propertyValue)
  }

  return createSuccessResult(
    {
      name: property.name,
      value: propertyValue,
      description: property.description || "",
      type: property.type || "string",
      sys_id: property.sys_id,
      is_masked: maskSensitive && isSensitiveProperty(name),
    },
    {
      operation: "get_property",
      property_name: name,
    },
  )
}

async function setProperty(client: any, name: string, value: string): Promise<ToolResult> {
  // First check if property exists
  const existingResponse = await client.get(`/api/now/table/sys_properties?sysparm_query=name=${name}&sysparm_limit=1`)

  let result
  if (existingResponse.data.result && existingResponse.data.result.length > 0) {
    // Update existing property
    const propertyId = existingResponse.data.result[0].sys_id
    const updateResponse = await client.patch(`/api/now/table/sys_properties/${propertyId}`, {
      value: value,
    })
    result = updateResponse.data.result
  } else {
    // Create new property
    const createResponse = await client.post("/api/now/table/sys_properties", {
      name: name,
      value: value,
      type: "string",
    })
    result = createResponse.data.result
  }

  return createSuccessResult(
    {
      name: result.name,
      value: isSensitiveProperty(name) ? maskValue(value) : value,
      sys_id: result.sys_id,
      operation: existingResponse.data.result.length > 0 ? "updated" : "created",
    },
    {
      operation: "set_property",
      property_name: name,
    },
  )
}

async function validateProperty(client: any, name: string): Promise<ToolResult> {
  const response = await client.get(`/api/now/table/sys_properties?sysparm_query=name=${name}&sysparm_limit=1`)

  const exists = response.data.result && response.data.result.length > 0
  const property = exists ? response.data.result[0] : null

  const validation = {
    exists,
    name,
    is_valid: exists,
    issues: [] as string[],
  }

  if (exists) {
    // Validate property structure
    if (!property.value || property.value === "") {
      validation.issues.push("Property value is empty")
      validation.is_valid = false
    }
    if (!property.type) {
      validation.issues.push("Property type is not defined")
    }
  } else {
    validation.issues.push("Property does not exist")
  }

  return createSuccessResult(validation, {
    operation: "validate_property",
    property_name: name,
  })
}

function isSensitiveProperty(name: string): boolean {
  const sensitivePatterns = [/password/i, /api[_-]?key/i, /secret/i, /token/i, /credential/i, /private[_-]?key/i]

  return sensitivePatterns.some((pattern) => pattern.test(name))
}

function maskValue(value: string): string {
  if (!value || value.length <= 4) {
    return "****"
  }
  return value.substring(0, 2) + "****" + value.substring(value.length - 2)
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
