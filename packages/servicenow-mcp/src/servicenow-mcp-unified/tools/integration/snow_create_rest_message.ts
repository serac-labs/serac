/**
 * snow_create_rest_message - REST API integration
 *
 * Create REST message configurations for external API integrations
 * with authentication, headers, and method templates.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_rest_message",
  description: "Create REST message for external API integration",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "rest",
  use_cases: ["integration", "rest", "api"],
  complexity: "intermediate",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE - Create operation - modifies data
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "REST message name",
      },
      endpoint: {
        type: "string",
        description: "Base URL endpoint",
      },
      description: {
        type: "string",
        description: "REST message description",
      },
      authentication: {
        type: "string",
        enum: ["none", "basic", "oauth2", "api_key"],
        description: "Authentication type",
        default: "none",
      },
      use_mid_server: {
        type: "boolean",
        description: "Route through MID Server",
        default: false,
      },
      mid_server: {
        type: "string",
        description: "MID Server name if use_mid_server is true",
      },
      methods: {
        type: "array",
        description: "HTTP methods to create",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            http_method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
            endpoint_path: { type: "string" },
            headers: { type: "object" },
          },
        },
      },
    },
    required: ["name", "endpoint"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    name,
    endpoint,
    description = "",
    authentication = "none",
    use_mid_server = false,
    mid_server,
    methods = [],
  } = args

  try {
    const client = await getAuthenticatedClient(context)

    // Try Table API first, fallback to background script if 403
    let restMessage: any
    let usedBackgroundScript = false

    try {
      // Create REST message via Table API
      // Note: sys_rest_message table uses 'rest_endpoint' field, not 'endpoint'
      const restMessageData: any = {
        name,
        rest_endpoint: endpoint,
        description,
        use_mid_server,
        authentication_type: authentication,
      }

      if (use_mid_server && mid_server) {
        restMessageData.mid_server = mid_server
      }

      const restMessageResponse = await client.post("/api/now/table/sys_rest_message", restMessageData)
      restMessage = restMessageResponse.data.result
    } catch (tableApiError: any) {
      // If 403 Forbidden, fallback to background script
      if (tableApiError.response?.status === 403) {
        console.error("Table API failed with 403, falling back to background script...")
        usedBackgroundScript = true

        // Create via background script
        const script = `
          var gr = new GlideRecord('sys_rest_message');
          gr.initialize();
          gr.name = ${JSON.stringify(name)};
          gr.rest_endpoint = ${JSON.stringify(endpoint)};
          gr.description = ${JSON.stringify(description)};
          gr.use_mid_server = ${use_mid_server};
          gr.authentication_type = ${JSON.stringify(authentication)};
          ${use_mid_server && mid_server ? `gr.mid_server = ${JSON.stringify(mid_server)};` : ""}
          var sysId = gr.insert();

          if (sysId) {
            var result = {};
            result.sys_id = sysId;
            result.name = gr.name.toString();
            result.endpoint = gr.rest_endpoint.toString();
            gs.print(JSON.stringify(result));
          } else {
            gs.error('Failed to create REST message');
          }
        `

        const scriptResponse = await client.post("/api/now/table/sys_script_execution", {
          script,
          description: `Create REST message: ${name}`,
        })

        // Parse the output
        const output = scriptResponse.data.result?.output || ""
        const resultMatch = output.match(/\{[^}]+\}/)
        if (resultMatch) {
          restMessage = JSON.parse(resultMatch[0])
        } else {
          throw new Error("Failed to create REST message via background script")
        }
      } else {
        throw tableApiError
      }
    }

    // Create HTTP methods
    const createdMethods = []
    for (const method of methods) {
      try {
        // Try Table API first
        const methodData = {
          rest_message: restMessage.sys_id,
          name: method.name,
          http_method: method.http_method,
          endpoint: endpoint + (method.endpoint_path || ""),
          rest_endpoint: endpoint + (method.endpoint_path || ""),
        }

        const methodResponse = await client.post("/api/now/table/sys_rest_message_fn", methodData)
        const createdMethod = methodResponse.data.result
        createdMethods.push(createdMethod)

        // Create headers if specified
        if (method.headers) {
          for (const [headerName, headerValue] of Object.entries(method.headers)) {
            await client.post("/api/now/table/sys_rest_message_headers", {
              rest_message_function: createdMethod.sys_id,
              name: headerName,
              value: headerValue,
            })
          }
        }
      } catch (methodError: any) {
        // If 403, fallback to background script for method creation
        if (methodError.response?.status === 403) {
          const methodScript = `
            var gr = new GlideRecord('sys_rest_message_fn');
            gr.initialize();
            gr.rest_message = ${JSON.stringify(restMessage.sys_id)};
            gr.name = ${JSON.stringify(method.name)};
            gr.http_method = ${JSON.stringify(method.http_method)};
            gr.rest_endpoint = ${JSON.stringify(endpoint + (method.endpoint_path || ""))};
            var sysId = gr.insert();

            var result = { sys_id: sysId, name: gr.name.toString(), http_method: gr.http_method.toString() };
            gs.print(JSON.stringify(result));
          `

          const methodScriptResponse = await client.post("/api/now/table/sys_script_execution", {
            script: methodScript,
            description: `Create REST method: ${method.name}`,
          })

          const methodOutput = methodScriptResponse.data.result?.output || ""
          const methodResultMatch = methodOutput.match(/\{[^}]+\}/)
          if (methodResultMatch) {
            createdMethods.push(JSON.parse(methodResultMatch[0]))
          }
        } else {
          throw methodError
        }
      }
    }

    return createSuccessResult({
      created: true,
      method: usedBackgroundScript ? "background_script" : "table_api",
      rest_message: {
        sys_id: restMessage.sys_id,
        name: restMessage.name,
        endpoint: restMessage.endpoint,
        authentication: authentication,
      },
      methods: createdMethods.map((m) => ({
        sys_id: m.sys_id,
        name: m.name,
        http_method: m.http_method,
        endpoint: m.endpoint || m.rest_endpoint,
      })),
      total_methods: createdMethods.length,
    })
  } catch (error: any) {
    // Provide detailed error message about permissions
    if (error.response?.status === 403) {
      return createErrorResult(
        `Permission denied (403): Your ServiceNow user lacks permissions to create REST messages. ` +
          `Required roles: 'rest_service' or 'admin'. Current attempt used both Table API and background script fallback. ` +
          `Please contact your ServiceNow administrator to grant the necessary permissions.`,
      )
    }
    return createErrorResult(error.message)
  }
}

export const version = "1.1.0"
export const author = "Serac v8.41.17"
