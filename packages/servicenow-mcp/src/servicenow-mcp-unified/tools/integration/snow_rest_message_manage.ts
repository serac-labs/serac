/**
 * snow_rest_message_manage - Universal REST Message Management Tool
 *
 * Complete CRUD operations for REST Messages, HTTP Methods, Headers, and Parameters.
 *
 * Tables used:
 * - sys_rest_message: REST Message definitions
 * - sys_rest_message_headers: Headers for REST Message (apply to ALL methods)
 * - sys_rest_message_fn: HTTP Methods (functions) for REST Messages
 * - sys_rest_message_fn_headers: Headers for specific HTTP Methods
 * - sys_rest_message_fn_parameters: Query parameters for HTTP Methods
 *
 * Header Levels:
 * - Message headers (sys_rest_message_headers): Apply to ALL methods in the REST message
 * - Method headers (sys_rest_message_fn_headers): Apply only to specific method
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_rest_message_manage",
  description: `Universal REST Message management tool. CRUD operations for:
• REST Messages (list, get, create, update, delete)
• HTTP Methods (list_methods, get_method, create_method, update_method, delete_method)
• Message-level Headers - apply to ALL methods (list_message_headers, create_message_header, delete_message_header)
• Method-level Headers - apply to specific method (list_method_headers, create_method_header, delete_method_header)
• Query Parameters (list_parameters, create_parameter, delete_parameter)
• Testing (test) - generates ES5-compatible test script for snow_execute_script`,
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "rest",
  use_cases: ["integration", "rest", "api", "crud", "headers", "parameters", "testing"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          // REST Message operations
          "list", // List all REST messages
          "get", // Get a specific REST message with its methods
          "create", // Create a new REST message
          "update", // Update an existing REST message
          "delete", // Delete a REST message
          // Method operations
          "list_methods", // List methods for a REST message
          "get_method", // Get a specific method
          "create_method", // Create a method for a REST message
          "update_method", // Update a method
          "delete_method", // Delete a method
          // Message-level headers (apply to ALL methods)
          "list_message_headers", // List headers at REST message level
          "create_message_header", // Create header at REST message level
          "delete_message_header", // Delete header at REST message level
          // Method-level headers (apply to specific method only)
          "list_method_headers", // List headers for a specific method
          "create_method_header", // Create header for a specific method
          "delete_method_header", // Delete header from a method
          // Query parameters (for methods)
          "list_parameters", // List query parameters for a method
          "create_parameter", // Create query parameter for a method
          "delete_parameter", // Delete query parameter from a method
          // Testing
          "test", // Test a REST message/method
        ],
        description: "Action to perform",
      },
      // For list action
      filter: {
        type: "string",
        description: 'Filter for list action (e.g., "nameLIKEopenai" or "active=true")',
      },
      limit: {
        type: "number",
        description: "Maximum results to return",
        default: 50,
      },
      // For get/update/delete actions
      sys_id: {
        type: "string",
        description: "sys_id of REST message or method",
      },
      name: {
        type: "string",
        description: "Name of REST message (alternative to sys_id for lookup)",
      },
      // For create/update REST message
      endpoint: {
        type: "string",
        description: "Base URL endpoint for REST message",
      },
      description: {
        type: "string",
        description: "Description of the REST message",
      },
      authentication_type: {
        type: "string",
        enum: ["no_authentication", "basic", "oauth2", "api_key", "mutual_auth"],
        description: "Authentication type",
        default: "no_authentication",
      },
      basic_auth_profile: {
        type: "string",
        description: "Basic auth profile sys_id (if authentication_type is basic)",
      },
      oauth_profile: {
        type: "string",
        description: "OAuth profile sys_id (if authentication_type is oauth2)",
      },
      use_mid_server: {
        type: "boolean",
        description: "Route through MID Server",
        default: false,
      },
      mid_server: {
        type: "string",
        description: "MID Server name or sys_id",
      },
      // For method operations
      rest_message_sys_id: {
        type: "string",
        description: "Parent REST message sys_id (for method operations)",
      },
      method_sys_id: {
        type: "string",
        description: "Method sys_id (for method update/delete)",
      },
      http_method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        description: "HTTP method type",
        default: "GET",
      },
      relative_path: {
        type: "string",
        description: 'Relative endpoint path for method (e.g., "/v1/completions")',
      },
      request_body: {
        type: "string",
        description: "Request body template (for POST/PUT/PATCH)",
      },
      // For headers
      header_name: {
        type: "string",
        description: "Header name",
      },
      header_value: {
        type: "string",
        description: "Header value",
      },
      header_sys_id: {
        type: "string",
        description: "Header sys_id (for delete operations)",
      },
      headers: {
        type: "object",
        description: "Multiple headers as key-value pairs",
      },
      // For query parameters
      parameter_name: {
        type: "string",
        description: "Query parameter name",
      },
      parameter_value: {
        type: "string",
        description: "Query parameter value",
      },
      parameter_sys_id: {
        type: "string",
        description: "Parameter sys_id (for delete operations)",
      },
      parameters: {
        type: "object",
        description: "Multiple query parameters as key-value pairs",
      },
      // For test action
      test_params: {
        type: "object",
        description: "Parameters for testing the REST message",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args

  try {
    const client = await getAuthenticatedClient(context)

    switch (action) {
      // REST Message operations
      case "list":
        return await listRestMessages(client, args)
      case "get":
        return await getRestMessage(client, args)
      case "create":
        return await createRestMessage(client, args)
      case "update":
        return await updateRestMessage(client, args)
      case "delete":
        return await deleteRestMessage(client, args)
      // Method operations
      case "list_methods":
        return await listMethods(client, args)
      case "get_method":
        return await getMethod(client, args)
      case "create_method":
        return await createMethod(client, args)
      case "update_method":
        return await updateMethod(client, args)
      case "delete_method":
        return await deleteMethod(client, args)
      // Message-level headers (apply to ALL methods)
      case "list_message_headers":
        return await listMessageHeaders(client, args)
      case "create_message_header":
        return await createMessageHeader(client, args)
      case "delete_message_header":
        return await deleteMessageHeader(client, args)
      // Method-level headers (apply to specific method only)
      case "list_method_headers":
        return await listMethodHeaders(client, args)
      case "create_method_header":
        return await createMethodHeader(client, args)
      case "delete_method_header":
        return await deleteMethodHeader(client, args)
      // Query parameters
      case "list_parameters":
        return await listParameters(client, args)
      case "create_parameter":
        return await createParameter(client, args)
      case "delete_parameter":
        return await deleteParameter(client, args)
      // Testing
      case "test":
        return await testRestMessage(client, args)
      default:
        throw new SnowFlowError(
          ErrorType.VALIDATION_ERROR,
          `Unknown action: ${action}. See tool description for valid actions.`,
        )
    }
  } catch (error: any) {
    if (error.response?.status === 403) {
      return createErrorResult(
        `Permission denied (403): Your ServiceNow user lacks permissions for REST message operations. ` +
          `Required roles: 'rest_service' or 'admin'. ` +
          `Please contact your ServiceNow administrator to grant the necessary permissions.`,
      )
    }
    return createErrorResult(
      error instanceof SnowFlowError
        ? error
        : new SnowFlowError(ErrorType.UNKNOWN_ERROR, error.message, { originalError: error }),
    )
  }
}

// ============================================================================
// REST MESSAGE OPERATIONS
// ============================================================================

async function listRestMessages(client: any, args: any): Promise<ToolResult> {
  const { filter, limit = 50 } = args

  const params: any = {
    sysparm_fields: "sys_id,name,rest_endpoint,description,authentication_type,use_mid_server,active,sys_updated_on",
    sysparm_limit: limit,
  }

  if (filter) {
    params.sysparm_query = filter
  }

  const response = await client.get("/api/now/table/sys_rest_message", { params })
  const messages = response.data?.result || []

  return createSuccessResult(
    {
      action: "list",
      count: messages.length,
      rest_messages: messages.map((m: any) => ({
        sys_id: m.sys_id,
        name: m.name,
        endpoint: m.rest_endpoint,
        description: m.description,
        authentication_type: m.authentication_type,
        use_mid_server: m.use_mid_server === "true",
        active: m.active === "true",
        updated: m.sys_updated_on,
      })),
    },
    { operation: "list_rest_messages" },
  )
}

async function getRestMessage(client: any, args: any): Promise<ToolResult> {
  const { sys_id, name } = args

  if (!sys_id && !name) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "Either sys_id or name is required for get action")
  }

  let messageSysId = sys_id

  // Lookup by name if sys_id not provided
  if (!messageSysId && name) {
    const lookupResponse = await client.get("/api/now/table/sys_rest_message", {
      params: {
        sysparm_query: `name=${name}`,
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })

    if (!lookupResponse.data?.result?.[0]) {
      throw new SnowFlowError(ErrorType.NOT_FOUND, `REST message not found: ${name}`)
    }
    messageSysId = lookupResponse.data.result[0].sys_id
  }

  // Get the REST message
  const messageResponse = await client.get(`/api/now/table/sys_rest_message/${messageSysId}`)
  const message = messageResponse.data?.result

  if (!message) {
    throw new SnowFlowError(ErrorType.NOT_FOUND, `REST message not found: ${messageSysId}`)
  }

  // Get associated methods
  const methodsResponse = await client.get("/api/now/table/sys_rest_message_fn", {
    params: {
      sysparm_query: `rest_message=${messageSysId}`,
      sysparm_fields: "sys_id,name,http_method,rest_endpoint,content,active",
    },
  })
  const methods = methodsResponse.data?.result || []

  return createSuccessResult(
    {
      action: "get",
      rest_message: {
        sys_id: message.sys_id,
        name: message.name,
        endpoint: message.rest_endpoint,
        description: message.description,
        authentication_type: message.authentication_type,
        basic_auth_profile: message.basic_auth_profile,
        oauth_profile: message.oauth2_profile,
        use_mid_server: message.use_mid_server === "true",
        mid_server: message.mid_server,
        active: message.active === "true",
        created: message.sys_created_on,
        updated: message.sys_updated_on,
      },
      methods: methods.map((m: any) => ({
        sys_id: m.sys_id,
        name: m.name,
        http_method: m.http_method,
        endpoint: m.rest_endpoint,
        has_body: !!m.content,
        active: m.active === "true",
      })),
      method_count: methods.length,
    },
    { operation: "get_rest_message" },
  )
}

async function createRestMessage(client: any, args: any): Promise<ToolResult> {
  const {
    name,
    endpoint,
    description = "",
    authentication_type = "no_authentication",
    basic_auth_profile,
    oauth_profile,
    use_mid_server = false,
    mid_server,
  } = args

  if (!name || !endpoint) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "name and endpoint are required for create action")
  }

  const messageData: any = {
    name,
    rest_endpoint: endpoint,
    description,
    authentication_type,
    use_mid_server,
    active: true,
  }

  if (authentication_type === "basic" && basic_auth_profile) {
    messageData.basic_auth_profile = basic_auth_profile
  }
  if (authentication_type === "oauth2" && oauth_profile) {
    messageData.oauth2_profile = oauth_profile
  }
  if (use_mid_server && mid_server) {
    messageData.mid_server = mid_server
  }

  const response = await client.post("/api/now/table/sys_rest_message", messageData)
  const created = response.data?.result

  return createSuccessResult(
    {
      action: "create",
      created: true,
      rest_message: {
        sys_id: created.sys_id,
        name: created.name,
        endpoint: created.rest_endpoint,
        authentication_type: created.authentication_type,
      },
      message: `REST message "${name}" created successfully`,
      next_steps: [
        `Create methods using: action="create_method", rest_message_sys_id="${created.sys_id}"`,
        `Add headers using: action="create_header", method_sys_id="<method_sys_id>"`,
      ],
    },
    { operation: "create_rest_message" },
  )
}

async function updateRestMessage(client: any, args: any): Promise<ToolResult> {
  const {
    sys_id,
    name,
    endpoint,
    description,
    authentication_type,
    basic_auth_profile,
    oauth_profile,
    use_mid_server,
    mid_server,
  } = args

  let messageSysId = sys_id

  // Lookup by name if needed
  if (!messageSysId && name) {
    const lookupResponse = await client.get("/api/now/table/sys_rest_message", {
      params: {
        sysparm_query: `name=${name}`,
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })
    if (!lookupResponse.data?.result?.[0]) {
      throw new SnowFlowError(ErrorType.NOT_FOUND, `REST message not found: ${name}`)
    }
    messageSysId = lookupResponse.data.result[0].sys_id
  }

  if (!messageSysId) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "sys_id or name is required for update action")
  }

  const updateData: any = {}
  if (endpoint !== undefined) updateData.rest_endpoint = endpoint
  if (description !== undefined) updateData.description = description
  if (authentication_type !== undefined) updateData.authentication_type = authentication_type
  if (basic_auth_profile !== undefined) updateData.basic_auth_profile = basic_auth_profile
  if (oauth_profile !== undefined) updateData.oauth2_profile = oauth_profile
  if (use_mid_server !== undefined) updateData.use_mid_server = use_mid_server
  if (mid_server !== undefined) updateData.mid_server = mid_server

  if (Object.keys(updateData).length === 0) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "No fields to update. Provide at least one field to change.")
  }

  const response = await client.patch(`/api/now/table/sys_rest_message/${messageSysId}`, updateData)
  const updated = response.data?.result

  return createSuccessResult(
    {
      action: "update",
      updated: true,
      rest_message: {
        sys_id: updated.sys_id,
        name: updated.name,
        endpoint: updated.rest_endpoint,
      },
      fields_updated: Object.keys(updateData),
    },
    { operation: "update_rest_message" },
  )
}

async function deleteRestMessage(client: any, args: any): Promise<ToolResult> {
  const { sys_id, name } = args

  let messageSysId = sys_id

  // Lookup by name if needed
  if (!messageSysId && name) {
    const lookupResponse = await client.get("/api/now/table/sys_rest_message", {
      params: {
        sysparm_query: `name=${name}`,
        sysparm_fields: "sys_id,name",
        sysparm_limit: 1,
      },
    })
    if (!lookupResponse.data?.result?.[0]) {
      throw new SnowFlowError(ErrorType.NOT_FOUND, `REST message not found: ${name}`)
    }
    messageSysId = lookupResponse.data.result[0].sys_id
  }

  if (!messageSysId) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "sys_id or name is required for delete action")
  }

  // Delete associated methods first
  const methodsResponse = await client.get("/api/now/table/sys_rest_message_fn", {
    params: {
      sysparm_query: `rest_message=${messageSysId}`,
      sysparm_fields: "sys_id",
    },
  })
  const methods = methodsResponse.data?.result || []

  for (const method of methods) {
    await client.delete(`/api/now/table/sys_rest_message_fn/${method.sys_id}`)
  }

  // Delete the REST message
  await client.delete(`/api/now/table/sys_rest_message/${messageSysId}`)

  return createSuccessResult(
    {
      action: "delete",
      deleted: true,
      sys_id: messageSysId,
      methods_deleted: methods.length,
      message: `REST message and ${methods.length} associated methods deleted`,
    },
    { operation: "delete_rest_message" },
  )
}

// ============================================================================
// METHOD OPERATIONS
// ============================================================================

async function listMethods(client: any, args: any): Promise<ToolResult> {
  const { rest_message_sys_id, name, limit = 50 } = args

  let messageSysId = rest_message_sys_id

  // Lookup by name if needed
  if (!messageSysId && name) {
    const lookupResponse = await client.get("/api/now/table/sys_rest_message", {
      params: {
        sysparm_query: `name=${name}`,
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })
    if (!lookupResponse.data?.result?.[0]) {
      throw new SnowFlowError(ErrorType.NOT_FOUND, `REST message not found: ${name}`)
    }
    messageSysId = lookupResponse.data.result[0].sys_id
  }

  if (!messageSysId) {
    throw new SnowFlowError(
      ErrorType.VALIDATION_ERROR,
      "rest_message_sys_id or name is required for list_methods action",
    )
  }

  const response = await client.get("/api/now/table/sys_rest_message_fn", {
    params: {
      sysparm_query: `rest_message=${messageSysId}`,
      sysparm_fields: "sys_id,name,http_method,rest_endpoint,content,active",
      sysparm_limit: limit,
    },
  })

  const methods = response.data?.result || []

  return createSuccessResult(
    {
      action: "list_methods",
      rest_message_sys_id: messageSysId,
      count: methods.length,
      methods: methods.map((m: any) => ({
        sys_id: m.sys_id,
        name: m.name,
        http_method: m.http_method,
        endpoint: m.rest_endpoint,
        has_body: !!m.content,
        active: m.active === "true",
      })),
    },
    { operation: "list_methods" },
  )
}

async function getMethod(client: any, args: any): Promise<ToolResult> {
  const { method_sys_id, sys_id } = args
  const methodId = method_sys_id || sys_id

  if (!methodId) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "method_sys_id is required for get_method action")
  }

  // Get the method
  const methodResponse = await client.get(`/api/now/table/sys_rest_message_fn/${methodId}`)
  const method = methodResponse.data?.result

  if (!method) {
    throw new SnowFlowError(ErrorType.NOT_FOUND, `Method not found: ${methodId}`)
  }

  // Get associated headers
  const headersResponse = await client.get("/api/now/table/sys_rest_message_fn_headers", {
    params: {
      sysparm_query: `rest_message_function=${methodId}`,
      sysparm_fields: "sys_id,name,value",
    },
  })
  const headers = headersResponse.data?.result || []

  // Get associated parameters
  const paramsResponse = await client.get("/api/now/table/sys_rest_message_fn_parameters", {
    params: {
      sysparm_query: `rest_message_function=${methodId}`,
      sysparm_fields: "sys_id,name,value",
    },
  })
  const parameters = paramsResponse.data?.result || []

  return createSuccessResult(
    {
      action: "get_method",
      method: {
        sys_id: method.sys_id,
        name: method.name,
        http_method: method.http_method,
        endpoint: method.rest_endpoint,
        request_body: method.content,
        active: method.active === "true",
        rest_message: method.rest_message,
      },
      headers: headers.map((h: any) => ({
        sys_id: h.sys_id,
        name: h.name,
        value: h.value,
      })),
      parameters: parameters.map((p: any) => ({
        sys_id: p.sys_id,
        name: p.name,
        value: p.value,
      })),
    },
    { operation: "get_method" },
  )
}

async function createMethod(client: any, args: any): Promise<ToolResult> {
  const { rest_message_sys_id, name, http_method = "GET", relative_path = "", request_body, headers } = args

  if (!rest_message_sys_id) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "rest_message_sys_id is required for create_method action")
  }
  if (!name) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "name is required for create_method action")
  }

  // Get the parent REST message to build full endpoint
  const messageResponse = await client.get(`/api/now/table/sys_rest_message/${rest_message_sys_id}`, {
    params: { sysparm_fields: "rest_endpoint" },
  })
  const baseEndpoint = messageResponse.data?.result?.rest_endpoint || ""

  const methodData: any = {
    rest_message: rest_message_sys_id,
    name,
    http_method,
    rest_endpoint: baseEndpoint + relative_path,
    active: true,
  }

  if (request_body) {
    methodData.content = request_body
  }

  const response = await client.post("/api/now/table/sys_rest_message_fn", methodData)
  const created = response.data?.result

  // Create headers if provided
  const createdHeaders = []
  if (headers && typeof headers === "object") {
    for (const [headerName, headerValue] of Object.entries(headers)) {
      const headerResponse = await client.post("/api/now/table/sys_rest_message_fn_headers", {
        rest_message_function: created.sys_id,
        name: headerName,
        value: headerValue,
      })
      createdHeaders.push({
        sys_id: headerResponse.data?.result?.sys_id,
        name: headerName,
        value: headerValue,
      })
    }
  }

  return createSuccessResult(
    {
      action: "create_method",
      created: true,
      method: {
        sys_id: created.sys_id,
        name: created.name,
        http_method: created.http_method,
        endpoint: created.rest_endpoint,
      },
      headers_created: createdHeaders.length,
      headers: createdHeaders,
    },
    { operation: "create_method" },
  )
}

async function updateMethod(client: any, args: any): Promise<ToolResult> {
  const { method_sys_id, sys_id, name, http_method, relative_path, request_body } = args
  const methodId = method_sys_id || sys_id

  if (!methodId) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "method_sys_id is required for update_method action")
  }

  const updateData: any = {}
  if (name !== undefined) updateData.name = name
  if (http_method !== undefined) updateData.http_method = http_method
  if (relative_path !== undefined) {
    // Get parent REST message to build full endpoint
    const methodResponse = await client.get(`/api/now/table/sys_rest_message_fn/${methodId}`, {
      params: { sysparm_fields: "rest_message" },
    })
    const restMessageId = methodResponse.data?.result?.rest_message?.value
    if (restMessageId) {
      const messageResponse = await client.get(`/api/now/table/sys_rest_message/${restMessageId}`, {
        params: { sysparm_fields: "rest_endpoint" },
      })
      const baseEndpoint = messageResponse.data?.result?.rest_endpoint || ""
      updateData.rest_endpoint = baseEndpoint + relative_path
    }
  }
  if (request_body !== undefined) updateData.content = request_body

  if (Object.keys(updateData).length === 0) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "No fields to update")
  }

  const response = await client.patch(`/api/now/table/sys_rest_message_fn/${methodId}`, updateData)
  const updated = response.data?.result

  return createSuccessResult(
    {
      action: "update_method",
      updated: true,
      method: {
        sys_id: updated.sys_id,
        name: updated.name,
        http_method: updated.http_method,
        endpoint: updated.rest_endpoint,
      },
      fields_updated: Object.keys(updateData),
    },
    { operation: "update_method" },
  )
}

async function deleteMethod(client: any, args: any): Promise<ToolResult> {
  const { method_sys_id, sys_id } = args
  const methodId = method_sys_id || sys_id

  if (!methodId) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "method_sys_id is required for delete_method action")
  }

  // Delete associated headers first
  const headersResponse = await client.get("/api/now/table/sys_rest_message_fn_headers", {
    params: {
      sysparm_query: `rest_message_function=${methodId}`,
      sysparm_fields: "sys_id",
    },
  })
  const headers = headersResponse.data?.result || []

  for (const header of headers) {
    await client.delete(`/api/now/table/sys_rest_message_fn_headers/${header.sys_id}`)
  }

  // Delete the method
  await client.delete(`/api/now/table/sys_rest_message_fn/${methodId}`)

  return createSuccessResult(
    {
      action: "delete_method",
      deleted: true,
      method_sys_id: methodId,
      headers_deleted: headers.length,
    },
    { operation: "delete_method" },
  )
}

// ============================================================================
// MESSAGE-LEVEL HEADER OPERATIONS (sys_rest_message_headers)
// These headers apply to ALL methods in the REST message
// ============================================================================

async function listMessageHeaders(client: any, args: any): Promise<ToolResult> {
  const { rest_message_sys_id, sys_id, name } = args

  let messageSysId = rest_message_sys_id || sys_id

  // Lookup by name if needed
  if (!messageSysId && name) {
    const lookupResponse = await client.get("/api/now/table/sys_rest_message", {
      params: {
        sysparm_query: `name=${name}`,
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })
    if (!lookupResponse.data?.result?.[0]) {
      throw new SnowFlowError(ErrorType.NOT_FOUND, `REST message not found: ${name}`)
    }
    messageSysId = lookupResponse.data.result[0].sys_id
  }

  if (!messageSysId) {
    throw new SnowFlowError(
      ErrorType.VALIDATION_ERROR,
      "rest_message_sys_id, sys_id, or name is required for list_message_headers action",
    )
  }

  const response = await client.get("/api/now/table/sys_rest_message_headers", {
    params: {
      sysparm_query: `rest_message=${messageSysId}`,
      sysparm_fields: "sys_id,name,value",
    },
  })

  const headers = response.data?.result || []

  return createSuccessResult(
    {
      action: "list_message_headers",
      rest_message_sys_id: messageSysId,
      count: headers.length,
      headers: headers.map((h: any) => ({
        sys_id: h.sys_id,
        name: h.name,
        value: h.value,
      })),
      note: "These headers apply to ALL methods in this REST message",
    },
    { operation: "list_message_headers" },
  )
}

async function createMessageHeader(client: any, args: any): Promise<ToolResult> {
  const { rest_message_sys_id, sys_id, name, header_name, header_value, headers } = args

  let messageSysId = rest_message_sys_id || sys_id

  // Lookup by name if needed
  if (!messageSysId && name) {
    const lookupResponse = await client.get("/api/now/table/sys_rest_message", {
      params: {
        sysparm_query: `name=${name}`,
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })
    if (!lookupResponse.data?.result?.[0]) {
      throw new SnowFlowError(ErrorType.NOT_FOUND, `REST message not found: ${name}`)
    }
    messageSysId = lookupResponse.data.result[0].sys_id
  }

  if (!messageSysId) {
    throw new SnowFlowError(
      ErrorType.VALIDATION_ERROR,
      "rest_message_sys_id, sys_id, or name is required for create_message_header action",
    )
  }

  const createdHeaders = []

  // Create multiple headers if provided as object
  if (headers && typeof headers === "object") {
    for (const [hName, hValue] of Object.entries(headers)) {
      const response = await client.post("/api/now/table/sys_rest_message_headers", {
        rest_message: messageSysId,
        name: hName,
        value: hValue,
      })
      createdHeaders.push({
        sys_id: response.data?.result?.sys_id,
        name: hName,
        value: hValue,
      })
    }
  } else if (header_name && header_value !== undefined) {
    // Create single header
    const response = await client.post("/api/now/table/sys_rest_message_headers", {
      rest_message: messageSysId,
      name: header_name,
      value: header_value,
    })
    createdHeaders.push({
      sys_id: response.data?.result?.sys_id,
      name: header_name,
      value: header_value,
    })
  } else {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "Either headers object or header_name+header_value is required")
  }

  return createSuccessResult(
    {
      action: "create_message_header",
      created: true,
      rest_message_sys_id: messageSysId,
      headers: createdHeaders,
      count: createdHeaders.length,
      note: "These headers will apply to ALL methods in this REST message",
    },
    { operation: "create_message_header" },
  )
}

async function deleteMessageHeader(client: any, args: any): Promise<ToolResult> {
  const { header_sys_id, sys_id, header_name, rest_message_sys_id, name } = args

  const headerSysIdToDelete = header_sys_id || sys_id

  if (headerSysIdToDelete) {
    // Delete by sys_id
    await client.delete(`/api/now/table/sys_rest_message_headers/${headerSysIdToDelete}`)
    return createSuccessResult(
      {
        action: "delete_message_header",
        deleted: true,
        header_sys_id: headerSysIdToDelete,
      },
      { operation: "delete_message_header" },
    )
  } else if (header_name && (rest_message_sys_id || name)) {
    // Find REST message sys_id if needed
    let messageSysId = rest_message_sys_id
    if (!messageSysId && name) {
      const lookupResponse = await client.get("/api/now/table/sys_rest_message", {
        params: {
          sysparm_query: `name=${name}`,
          sysparm_fields: "sys_id",
          sysparm_limit: 1,
        },
      })
      if (!lookupResponse.data?.result?.[0]) {
        throw new SnowFlowError(ErrorType.NOT_FOUND, `REST message not found: ${name}`)
      }
      messageSysId = lookupResponse.data.result[0].sys_id
    }

    // Find and delete by name
    const lookupResponse = await client.get("/api/now/table/sys_rest_message_headers", {
      params: {
        sysparm_query: `rest_message=${messageSysId}^name=${header_name}`,
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })
    if (!lookupResponse.data?.result?.[0]) {
      throw new SnowFlowError(ErrorType.NOT_FOUND, `Message header not found: ${header_name}`)
    }
    const foundHeaderSysId = lookupResponse.data.result[0].sys_id
    await client.delete(`/api/now/table/sys_rest_message_headers/${foundHeaderSysId}`)
    return createSuccessResult(
      {
        action: "delete_message_header",
        deleted: true,
        header_name,
        header_sys_id: foundHeaderSysId,
      },
      { operation: "delete_message_header" },
    )
  } else {
    throw new SnowFlowError(
      ErrorType.VALIDATION_ERROR,
      "Either header_sys_id/sys_id OR (header_name + rest_message_sys_id/name) is required",
    )
  }
}

// ============================================================================
// METHOD-LEVEL HEADER OPERATIONS (sys_rest_message_fn_headers)
// These headers apply only to a specific method
// ============================================================================

async function listMethodHeaders(client: any, args: any): Promise<ToolResult> {
  const { method_sys_id, sys_id } = args
  const methodId = method_sys_id || sys_id

  if (!methodId) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "method_sys_id is required for list_method_headers action")
  }

  const response = await client.get("/api/now/table/sys_rest_message_fn_headers", {
    params: {
      sysparm_query: `rest_message_function=${methodId}`,
      sysparm_fields: "sys_id,name,value",
    },
  })

  const headers = response.data?.result || []

  return createSuccessResult(
    {
      action: "list_method_headers",
      method_sys_id: methodId,
      count: headers.length,
      headers: headers.map((h: any) => ({
        sys_id: h.sys_id,
        name: h.name,
        value: h.value,
      })),
      note: "These headers apply only to this specific method",
    },
    { operation: "list_method_headers" },
  )
}

async function createMethodHeader(client: any, args: any): Promise<ToolResult> {
  const { method_sys_id, header_name, header_value, headers } = args

  if (!method_sys_id) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "method_sys_id is required for create_method_header action")
  }

  const createdHeaders = []

  // Create multiple headers if provided as object
  if (headers && typeof headers === "object") {
    for (const [hName, hValue] of Object.entries(headers)) {
      const response = await client.post("/api/now/table/sys_rest_message_fn_headers", {
        rest_message_function: method_sys_id,
        name: hName,
        value: hValue,
      })
      createdHeaders.push({
        sys_id: response.data?.result?.sys_id,
        name: hName,
        value: hValue,
      })
    }
  } else if (header_name && header_value !== undefined) {
    // Create single header
    const response = await client.post("/api/now/table/sys_rest_message_fn_headers", {
      rest_message_function: method_sys_id,
      name: header_name,
      value: header_value,
    })
    createdHeaders.push({
      sys_id: response.data?.result?.sys_id,
      name: header_name,
      value: header_value,
    })
  } else {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "Either headers object or header_name+header_value is required")
  }

  return createSuccessResult(
    {
      action: "create_method_header",
      created: true,
      method_sys_id,
      headers: createdHeaders,
      count: createdHeaders.length,
      note: "These headers apply only to this specific method",
    },
    { operation: "create_method_header" },
  )
}

async function deleteMethodHeader(client: any, args: any): Promise<ToolResult> {
  const { header_sys_id, sys_id, header_name, method_sys_id } = args

  const headerSysIdToDelete = header_sys_id || sys_id

  if (headerSysIdToDelete) {
    // Delete by sys_id
    await client.delete(`/api/now/table/sys_rest_message_fn_headers/${headerSysIdToDelete}`)
    return createSuccessResult(
      {
        action: "delete_method_header",
        deleted: true,
        header_sys_id: headerSysIdToDelete,
      },
      { operation: "delete_method_header" },
    )
  } else if (header_name && method_sys_id) {
    // Find and delete by name
    const lookupResponse = await client.get("/api/now/table/sys_rest_message_fn_headers", {
      params: {
        sysparm_query: `rest_message_function=${method_sys_id}^name=${header_name}`,
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })
    if (!lookupResponse.data?.result?.[0]) {
      throw new SnowFlowError(ErrorType.NOT_FOUND, `Method header not found: ${header_name}`)
    }
    const foundHeaderSysId = lookupResponse.data.result[0].sys_id
    await client.delete(`/api/now/table/sys_rest_message_fn_headers/${foundHeaderSysId}`)
    return createSuccessResult(
      {
        action: "delete_method_header",
        deleted: true,
        header_name,
        header_sys_id: foundHeaderSysId,
      },
      { operation: "delete_method_header" },
    )
  } else {
    throw new SnowFlowError(
      ErrorType.VALIDATION_ERROR,
      "Either header_sys_id/sys_id OR (header_name + method_sys_id) is required",
    )
  }
}

// ============================================================================
// QUERY PARAMETER OPERATIONS (sys_rest_message_fn_parameters)
// ============================================================================

async function listParameters(client: any, args: any): Promise<ToolResult> {
  const { method_sys_id, sys_id } = args
  const methodId = method_sys_id || sys_id

  if (!methodId) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "method_sys_id is required for list_parameters action")
  }

  const response = await client.get("/api/now/table/sys_rest_message_fn_parameters", {
    params: {
      sysparm_query: `rest_message_function=${methodId}`,
      sysparm_fields: "sys_id,name,value",
    },
  })

  const parameters = response.data?.result || []

  return createSuccessResult(
    {
      action: "list_parameters",
      method_sys_id: methodId,
      count: parameters.length,
      parameters: parameters.map((p: any) => ({
        sys_id: p.sys_id,
        name: p.name,
        value: p.value,
      })),
    },
    { operation: "list_parameters" },
  )
}

async function createParameter(client: any, args: any): Promise<ToolResult> {
  const { method_sys_id, parameter_name, parameter_value, parameters } = args

  if (!method_sys_id) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "method_sys_id is required for create_parameter action")
  }

  const createdParams = []

  // Create multiple parameters if provided as object
  if (parameters && typeof parameters === "object") {
    for (const [pName, pValue] of Object.entries(parameters)) {
      const response = await client.post("/api/now/table/sys_rest_message_fn_parameters", {
        rest_message_function: method_sys_id,
        name: pName,
        value: pValue,
      })
      createdParams.push({
        sys_id: response.data?.result?.sys_id,
        name: pName,
        value: pValue,
      })
    }
  } else if (parameter_name && parameter_value !== undefined) {
    // Create single parameter
    const response = await client.post("/api/now/table/sys_rest_message_fn_parameters", {
      rest_message_function: method_sys_id,
      name: parameter_name,
      value: parameter_value,
    })
    createdParams.push({
      sys_id: response.data?.result?.sys_id,
      name: parameter_name,
      value: parameter_value,
    })
  } else {
    throw new SnowFlowError(
      ErrorType.VALIDATION_ERROR,
      "Either parameters object or parameter_name+parameter_value is required",
    )
  }

  return createSuccessResult(
    {
      action: "create_parameter",
      created: true,
      method_sys_id,
      parameters: createdParams,
      count: createdParams.length,
    },
    { operation: "create_parameter" },
  )
}

async function deleteParameter(client: any, args: any): Promise<ToolResult> {
  const { parameter_sys_id, sys_id, parameter_name, method_sys_id } = args

  const paramSysIdToDelete = parameter_sys_id || sys_id

  if (paramSysIdToDelete) {
    // Delete by sys_id
    await client.delete(`/api/now/table/sys_rest_message_fn_parameters/${paramSysIdToDelete}`)
    return createSuccessResult(
      {
        action: "delete_parameter",
        deleted: true,
        parameter_sys_id: paramSysIdToDelete,
      },
      { operation: "delete_parameter" },
    )
  } else if (parameter_name && method_sys_id) {
    // Find and delete by name
    const lookupResponse = await client.get("/api/now/table/sys_rest_message_fn_parameters", {
      params: {
        sysparm_query: `rest_message_function=${method_sys_id}^name=${parameter_name}`,
        sysparm_fields: "sys_id",
        sysparm_limit: 1,
      },
    })
    if (!lookupResponse.data?.result?.[0]) {
      throw new SnowFlowError(ErrorType.NOT_FOUND, `Parameter not found: ${parameter_name}`)
    }
    const foundParamSysId = lookupResponse.data.result[0].sys_id
    await client.delete(`/api/now/table/sys_rest_message_fn_parameters/${foundParamSysId}`)
    return createSuccessResult(
      {
        action: "delete_parameter",
        deleted: true,
        parameter_name,
        parameter_sys_id: foundParamSysId,
      },
      { operation: "delete_parameter" },
    )
  } else {
    throw new SnowFlowError(
      ErrorType.VALIDATION_ERROR,
      "Either parameter_sys_id/sys_id OR (parameter_name + method_sys_id) is required",
    )
  }
}

// ============================================================================
// TEST OPERATIONS
// ============================================================================

async function testRestMessage(client: any, args: any): Promise<ToolResult> {
  const { method_sys_id, sys_id, name, rest_message_sys_id, test_params = {} } = args
  const methodId = method_sys_id || sys_id

  // If we have a method_sys_id, get method details
  if (methodId) {
    const methodResponse = await client.get(`/api/now/table/sys_rest_message_fn/${methodId}`, {
      params: { sysparm_fields: "name,http_method,rest_endpoint,rest_message,content" },
    })
    const method = methodResponse.data?.result

    if (!method) {
      throw new SnowFlowError(ErrorType.NOT_FOUND, `Method not found: ${methodId}`)
    }

    // Get REST message details
    const restMessageId = method.rest_message?.value
    const messageResponse = await client.get(`/api/now/table/sys_rest_message/${restMessageId}`, {
      params: { sysparm_fields: "name,rest_endpoint,authentication_type" },
    })
    const restMessage = messageResponse.data?.result
    const restMessageName = restMessage?.name

    // Get method headers
    const headersResponse = await client.get("/api/now/table/sys_rest_message_fn_headers", {
      params: {
        sysparm_query: `rest_message_function=${methodId}`,
        sysparm_fields: "name,value",
      },
    })
    const methodHeaders = headersResponse.data?.result || []

    // Get message-level headers
    const msgHeadersResponse = await client.get("/api/now/table/sys_rest_message_headers", {
      params: {
        sysparm_query: `rest_message=${restMessageId}`,
        sysparm_fields: "name,value",
      },
    })
    const messageHeaders = msgHeadersResponse.data?.result || []

    // Get parameters
    const paramsResponse = await client.get("/api/now/table/sys_rest_message_fn_parameters", {
      params: {
        sysparm_query: `rest_message_function=${methodId}`,
        sysparm_fields: "name,value",
      },
    })
    const parameters = paramsResponse.data?.result || []

    // Build parameter setting code
    // SECURITY: Properly escape all special characters to prevent injection
    const escapeForScript = (str: string): string => {
      return str
        .replace(/\\/g, "\\\\") // Escape backslashes first
        .replace(/'/g, "\\'") // Escape single quotes
        .replace(/\n/g, "\\n") // Escape newlines
        .replace(/\r/g, "\\r") // Escape carriage returns
    }
    const paramLines = Object.entries(test_params).map(
      ([k, v]) => `rm.setStringParameterNoEscape('${escapeForScript(k)}', '${escapeForScript(String(v))}');`,
    )

    // Generate the test script (ES5 compatible!)
    const testScript = `
// Test REST Message: ${restMessageName} - Method: ${method.name}
// Generated by snow_rest_message_manage test action
// ES5 COMPATIBLE - Safe for ServiceNow execution

(function() {
  var results = {
    success: false,
    status_code: null,
    response_body: null,
    response_headers: {},
    error: null,
    timing_ms: 0
  };

  try {
    var startTime = new Date().getTime();

    // Create REST message instance
    var rm = new sn_ws.RESTMessageV2('${restMessageName}', '${method.name}');

    // Set parameters from test_params
${paramLines.length > 0 ? "    " + paramLines.join("\n    ") : "    // No parameters specified"}

    // Execute the request
    var response = rm.execute();
    var endTime = new Date().getTime();

    // Collect results
    results.success = true;
    results.status_code = response.getStatusCode();
    results.response_body = response.getBody();
    results.timing_ms = endTime - startTime;

    // Try to get response headers
    try {
      var headerStr = response.getAllHeaders();
      if (headerStr) {
        results.response_headers = headerStr;
      }
    } catch(headerErr) {
      // Headers may not be available
    }

    // Log results
    gs.info('=== REST MESSAGE TEST RESULTS ===');
    gs.info('REST Message: ${restMessageName}');
    gs.info('Method: ${method.name}');
    gs.info('HTTP Method: ${method.http_method}');
    gs.info('Status Code: ' + results.status_code);
    gs.info('Response Time: ' + results.timing_ms + 'ms');
    gs.info('Response Body: ' + results.response_body);

  } catch(e) {
    results.success = false;
    results.error = e.message || String(e);
    gs.error('REST Message Test Failed: ' + results.error);
  }

  // Store results in sys_properties for retrieval
  var propName = 'snow_flow.rest_test.${methodId}';
  gs.setProperty(propName, JSON.stringify(results));
  gs.info('Results stored in property: ' + propName);

  return results;
})();
    `.trim()

    return createSuccessResult(
      {
        action: "test",
        method: {
          sys_id: methodId,
          name: method.name,
          http_method: method.http_method,
          endpoint: method.rest_endpoint,
          has_body: !!method.content,
        },
        rest_message: {
          sys_id: restMessageId,
          name: restMessageName,
          base_endpoint: restMessage?.rest_endpoint,
          authentication_type: restMessage?.authentication_type,
        },
        configuration: {
          message_headers: messageHeaders.map((h: any) => ({ name: h.name, value: h.value })),
          method_headers: methodHeaders.map((h: any) => ({ name: h.name, value: h.value })),
          parameters: parameters.map((p: any) => ({ name: p.name, value: p.value })),
        },
        test_params_provided: test_params,
        test_script: testScript,
        usage: {
          description: "Use snow_execute_script to execute this test script",
          example: `snow_execute_script({ script: <test_script>, description: 'Test REST: ${restMessageName}' })`,
          manual_test: `In ServiceNow: System Web Services > Outbound > REST Message > ${restMessageName} > ${method.name} > Test`,
        },
        note: "Direct REST message testing requires ServiceNow script execution. Copy the test_script and run it via snow_execute_script.",
      },
      { operation: "test_rest_message" },
    )
  }

  // If we have REST message name but no method, list available methods
  if (name || rest_message_sys_id) {
    let messageSysId = rest_message_sys_id
    let messageName = name

    // Lookup by name if needed
    if (!messageSysId && name) {
      const lookupResponse = await client.get("/api/now/table/sys_rest_message", {
        params: {
          sysparm_query: `name=${name}`,
          sysparm_fields: "sys_id,name",
          sysparm_limit: 1,
        },
      })
      if (!lookupResponse.data?.result?.[0]) {
        throw new SnowFlowError(ErrorType.NOT_FOUND, `REST message not found: ${name}`)
      }
      messageSysId = lookupResponse.data.result[0].sys_id
      messageName = lookupResponse.data.result[0].name
    } else if (messageSysId && !messageName) {
      const msgResponse = await client.get(`/api/now/table/sys_rest_message/${messageSysId}`, {
        params: { sysparm_fields: "name" },
      })
      messageName = msgResponse.data?.result?.name
    }

    // Get methods for this REST message
    const methodsResponse = await client.get("/api/now/table/sys_rest_message_fn", {
      params: {
        sysparm_query: `rest_message=${messageSysId}`,
        sysparm_fields: "sys_id,name,http_method,rest_endpoint",
      },
    })
    const methods = methodsResponse.data?.result || []

    return createSuccessResult(
      {
        action: "test",
        rest_message: {
          sys_id: messageSysId,
          name: messageName,
        },
        available_methods: methods.map((m: any) => ({
          sys_id: m.sys_id,
          name: m.name,
          http_method: m.http_method,
          endpoint: m.rest_endpoint,
        })),
        note: "Specify method_sys_id to generate a test script for a specific method",
      },
      { operation: "test_rest_message" },
    )
  }

  throw new SnowFlowError(
    ErrorType.VALIDATION_ERROR,
    "method_sys_id, name, or rest_message_sys_id is required for test action",
  )
}

export const version = "2.0.0"
export const author = "Serac SDK"
export const changelog = {
  "2.0.0":
    "Added message-level headers, method-level headers, query parameters, improved test with ES5 script generation",
  "1.0.0": "Initial release with REST message and method CRUD operations",
}
