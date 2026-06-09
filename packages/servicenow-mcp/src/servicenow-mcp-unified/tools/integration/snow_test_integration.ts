/**
 * snow_test_integration - Test integrations
 *
 * Test REST/SOAP integrations, data sources, and external connections with comprehensive validation.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_test_integration",
  description: "Test REST/SOAP integrations and external connections with validation",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "testing",
  use_cases: ["integration", "testing", "validation"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: READ - Read-only operation based on name pattern
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      integration_type: {
        type: "string",
        description: "Type of integration to test",
        enum: ["rest", "soap", "data_source", "email", "ldap"],
        default: "rest",
      },
      integration_id: { type: "string", description: "Integration sys_id or name" },
      method: { type: "string", description: "HTTP method for REST (GET, POST, etc.)", default: "GET" },
      test_payload: { type: "object", description: "Test payload for POST/PUT requests" },
      validate_response: { type: "boolean", description: "Validate response format", default: true },
      timeout: { type: "number", description: "Timeout in seconds", default: 30 },
    },
    required: ["integration_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    integration_type = "rest",
    integration_id,
    method = "GET",
    test_payload,
    validate_response = true,
    timeout = 30,
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    const testResult: any = {
      integration_id,
      integration_type,
      tested_at: new Date().toISOString(),
      timeout,
    }

    // Test based on integration type
    switch (integration_type) {
      case "rest":
        Object.assign(
          testResult,
          await testRestIntegration(client, integration_id, method, test_payload, validate_response, timeout),
        )
        break

      case "soap":
        Object.assign(testResult, await testSoapIntegration(client, integration_id, validate_response, timeout))
        break

      case "data_source":
        Object.assign(testResult, await testDataSource(client, integration_id, timeout))
        break

      case "email":
        Object.assign(testResult, await testEmailConnection(client, integration_id, timeout))
        break

      case "ldap":
        Object.assign(testResult, await testLdapConnection(client, integration_id, timeout))
        break

      default:
        return createErrorResult(`Unsupported integration type: ${integration_type}`)
    }

    return createSuccessResult({ test_result: testResult }, { integration_id, integration_type })
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

async function testRestIntegration(
  client: any,
  integrationId: string,
  method: string,
  testPayload: any,
  validateResponse: boolean,
  timeout: number,
): Promise<any> {
  const result: any = {
    method,
    success: false,
  }

  try {
    // Get REST message configuration
    const restMessageResponse = await client.get("/api/now/table/sys_rest_message", {
      params: {
        sysparm_query: `sys_id=${integrationId}^ORname=${integrationId}`,
        sysparm_limit: 1,
      },
    })

    if (!restMessageResponse.data.result || restMessageResponse.data.result.length === 0) {
      result.error = "REST message not found"
      return result
    }

    const restMessage = restMessageResponse.data.result[0]
    result.rest_message_name = restMessage.name
    result.endpoint = restMessage.rest_endpoint

    // Get REST method
    const methodResponse = await client.get("/api/now/table/sys_rest_message_fn", {
      params: {
        sysparm_query: `rest_message=${restMessage.sys_id}^http_method=${method}`,
        sysparm_limit: 1,
      },
    })

    if (!methodResponse.data.result || methodResponse.data.result.length === 0) {
      result.error = `No ${method} method found for this REST message`
      return result
    }

    const restMethod = methodResponse.data.result[0]
    result.method_name = restMethod.name

    // Test the connection with background script
    const testScript = `
      var request = new sn_ws.RESTMessageV2('${restMessage.name}', '${restMethod.name}');
      ${testPayload ? `request.setRequestBody(JSON.stringify(${JSON.stringify(testPayload)}));` : ""}

      var startTime = new Date().getTime();
      var response = request.execute();
      var endTime = new Date().getTime();

      var result = {
        status_code: response.getStatusCode(),
        response_time_ms: endTime - startTime,
        response_body: response.getBody(),
        headers: response.getHeaders()
      };

      JSON.stringify(result);
    `

    const scriptResponse = await client.post("/api/now/table/sys_script_execution_history", {
      script: testScript,
      timeout: timeout * 1000,
    })

    // Parse results
    try {
      const executionResult = JSON.parse(scriptResponse.data.result.output)
      result.status_code = executionResult.status_code
      result.response_time_ms = executionResult.response_time_ms
      result.success = executionResult.status_code >= 200 && executionResult.status_code < 300

      if (validateResponse) {
        result.response_valid = isValidJson(executionResult.response_body)
        if (result.response_valid) {
          result.response_sample = JSON.parse(executionResult.response_body)
        }
      }
    } catch (parseError) {
      result.error = "Failed to parse test results"
      result.success = false
    }
  } catch (error) {
    result.error = String(error)
    result.success = false
  }

  return result
}

async function testSoapIntegration(
  client: any,
  integrationId: string,
  validateResponse: boolean,
  timeout: number,
): Promise<any> {
  const result: any = {
    success: false,
  }

  try {
    // Get SOAP message configuration
    const soapResponse = await client.get("/api/now/table/sys_web_service", {
      params: {
        sysparm_query: `sys_id=${integrationId}^ORname=${integrationId}`,
        sysparm_limit: 1,
      },
    })

    if (!soapResponse.data.result || soapResponse.data.result.length === 0) {
      result.error = "SOAP web service not found"
      return result
    }

    const soapService = soapResponse.data.result[0]
    result.service_name = soapService.name
    result.wsdl_url = soapService.wsdl

    // Test SOAP connection
    const testScript = `
      var soap = new SOAPMessage('${soapService.name}', 'test');
      var startTime = new Date().getTime();

      try {
        var response = soap.execute();
        var endTime = new Date().getTime();

        JSON.stringify({
          success: true,
          response_time_ms: endTime - startTime,
          status: 'connected'
        });
      } catch(e) {
        JSON.stringify({
          success: false,
          error: e.message
        });
      }
    `

    const scriptResponse = await client.post("/api/now/table/sys_script_execution_history", {
      script: testScript,
      timeout: timeout * 1000,
    })

    try {
      const executionResult = JSON.parse(scriptResponse.data.result.output)
      Object.assign(result, executionResult)
    } catch (parseError) {
      result.error = "Failed to parse SOAP test results"
    }
  } catch (error) {
    result.error = String(error)
    result.success = false
  }

  return result
}

async function testDataSource(client: any, integrationId: string, timeout: number): Promise<any> {
  const result: any = {
    success: false,
  }

  try {
    // Get data source configuration
    const dsResponse = await client.get("/api/now/table/sys_data_source", {
      params: {
        sysparm_query: `sys_id=${integrationId}^ORname=${integrationId}`,
        sysparm_limit: 1,
      },
    })

    if (!dsResponse.data.result || dsResponse.data.result.length === 0) {
      result.error = "Data source not found"
      return result
    }

    const dataSource = dsResponse.data.result[0]
    result.data_source_name = dataSource.name
    result.type = dataSource.type

    // Test connection
    const testScript = `
      var ds = new GlideDataSource('${dataSource.sys_id}');
      var startTime = new Date().getTime();

      try {
        var testResult = ds.testConnection();
        var endTime = new Date().getTime();

        JSON.stringify({
          success: testResult,
          response_time_ms: endTime - startTime
        });
      } catch(e) {
        JSON.stringify({
          success: false,
          error: e.message
        });
      }
    `

    const scriptResponse = await client.post("/api/now/table/sys_script_execution_history", {
      script: testScript,
      timeout: timeout * 1000,
    })

    try {
      const executionResult = JSON.parse(scriptResponse.data.result.output)
      Object.assign(result, executionResult)
    } catch (parseError) {
      result.error = "Failed to parse data source test results"
    }
  } catch (error) {
    result.error = String(error)
    result.success = false
  }

  return result
}

async function testEmailConnection(client: any, integrationId: string, timeout: number): Promise<any> {
  return {
    success: false,
    error: "Email connection testing not yet implemented",
  }
}

async function testLdapConnection(client: any, integrationId: string, timeout: number): Promise<any> {
  return {
    success: false,
    error: "LDAP connection testing not yet implemented",
  }
}

function isValidJson(str: string): boolean {
  try {
    JSON.parse(str)
    return true
  } catch {
    return false
  }
}

export const version = "1.0.0"
export const author = "Serac SDK Migration"
