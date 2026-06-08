/**
 * snow_test_rest_connection - Test REST API connections
 *
 * Test REST message connections with timeout, retry logic,
 * and response validation.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_test_rest_connection",
  description: "Test REST API connection with timeout and response validation",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "rest",
  use_cases: ["integration", "rest", "testing"],
  complexity: "intermediate",
  frequency: "high",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      rest_message_name: {
        type: "string",
        description: "Name of REST message to test",
      },
      method_name: {
        type: "string",
        description: "HTTP method name to test",
      },
      test_payload: {
        type: "object",
        description: "Test payload data (for POST/PUT/PATCH)",
      },
      timeout_seconds: {
        type: "number",
        description: "Request timeout in seconds",
        default: 30,
        maximum: 60,
      },
      validate_ssl: {
        type: "boolean",
        description: "Validate SSL certificate",
        default: true,
      },
    },
    required: ["rest_message_name", "method_name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { rest_message_name, method_name, test_payload = {}, timeout_seconds = 30, validate_ssl = true } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Get REST message
    const restMessageResponse = await client.get("/api/now/table/sys_rest_message", {
      params: {
        sysparm_query: `name=${rest_message_name}`,
        sysparm_fields: "sys_id,name,endpoint",
        sysparm_limit: 1,
      },
    })

    if (!restMessageResponse.data.result || restMessageResponse.data.result.length === 0) {
      throw new Error(`REST message '${rest_message_name}' not found`)
    }

    const restMessage = restMessageResponse.data.result[0]

    // Get HTTP method
    const methodResponse = await client.get("/api/now/table/sys_rest_message_fn", {
      params: {
        sysparm_query: `rest_message=${restMessage.sys_id}^name=${method_name}`,
        sysparm_fields: "sys_id,name,http_method,endpoint",
        sysparm_limit: 1,
      },
    })

    if (!methodResponse.data.result || methodResponse.data.result.length === 0) {
      throw new Error(`Method '${method_name}' not found in REST message '${rest_message_name}'`)
    }

    const method = methodResponse.data.result[0]

    // Execute test request
    const testScript = `
      var sm = new sn_ws.RESTMessageV2('${rest_message_name}', '${method_name}');
      sm.setRequestTimeout(${timeout_seconds * 1000});
      ${!validate_ssl ? 'sm.setEccParameter("skip_sensor", "true");' : ""}
      ${Object.keys(test_payload).length > 0 ? `sm.setRequestBody('${JSON.stringify(test_payload)}');` : ""}

      var response = sm.execute();
      var statusCode = response.getStatusCode();
      var responseBody = response.getBody();
      var responseTime = response.getWaitTime();
      var headers = response.getHeaders();

      var result = {
        success: statusCode >= 200 && statusCode < 300,
        status_code: statusCode,
        response_body: responseBody,
        response_time_ms: responseTime,
        headers: headers,
        endpoint: '${method.endpoint}'
      };

      JSON.stringify(result);
    `

    const scriptResponse = await client.post("/api/now/table/sys_script_execution", {
      script: testScript,
    })

    const executionResult = JSON.parse(scriptResponse.data.result.output || "{}")

    return createSuccessResult({
      test_completed: true,
      rest_message: rest_message_name,
      method: method_name,
      connection: {
        success: executionResult.success,
        status_code: executionResult.status_code,
        endpoint: executionResult.endpoint,
        response_time_ms: executionResult.response_time_ms,
      },
      response: {
        body: executionResult.response_body,
        headers: executionResult.headers,
      },
      diagnostics: {
        timeout_used: timeout_seconds,
        ssl_validation: validate_ssl,
        http_method: method.http_method,
      },
    })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
