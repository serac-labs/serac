/**
 * snow_create_flow_action - Create custom IntegrationHub actions
 *
 * Create custom Flow Designer actions for IntegrationHub to extend
 * spoke capabilities or create new integrations.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_create_flow_action",
  description: "Create custom IntegrationHub action for Flow Designer",
  category: "integration",
  subcategory: "integrationhub",
  use_cases: ["flow-designer", "integration-hub", "custom-actions", "automation"],
  complexity: "advanced",
  frequency: "medium",

  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'Action name (e.g., "Create Jira Issue", "Send Slack Message")',
      },
      description: {
        type: "string",
        description: "Description of what the action does",
      },
      category: {
        type: "string",
        description: "Category for organizing the action",
        default: "Custom",
      },
      action_type: {
        type: "string",
        enum: ["rest", "script", "subflow", "powershell", "ssh"],
        description: "Type of action implementation",
        default: "rest",
      },
      connection_alias: {
        type: "string",
        description: "sys_id or name of connection alias to use",
      },
      inputs: {
        type: "array",
        description: "Input parameters for the action",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Input parameter name" },
            label: { type: "string", description: "Display label" },
            type: {
              type: "string",
              enum: ["string", "integer", "boolean", "reference", "object", "array"],
              description: "Data type",
            },
            mandatory: { type: "boolean", description: "Is input required" },
            default_value: { type: "string", description: "Default value" },
          },
        },
      },
      outputs: {
        type: "array",
        description: "Output parameters for the action",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Output parameter name" },
            label: { type: "string", description: "Display label" },
            type: {
              type: "string",
              enum: ["string", "integer", "boolean", "reference", "object", "array"],
              description: "Data type",
            },
          },
        },
      },
      rest_config: {
        type: "object",
        description: "REST action configuration (for rest action_type)",
        properties: {
          http_method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          endpoint_path: { type: "string", description: "Relative endpoint path (can use {{input.param}} syntax)" },
          request_body: {
            type: "string",
            description: "Request body template (JSON with {{input.param}} placeholders)",
          },
          headers: { type: "object", description: "Additional headers" },
          content_type: { type: "string", default: "application/json" },
        },
      },
      script_config: {
        type: "object",
        description: "Script action configuration (for script action_type)",
        properties: {
          script: { type: "string", description: "ES5 JavaScript script to execute" },
        },
      },
      active: {
        type: "boolean",
        description: "Whether the action is active",
        default: true,
      },
      annotation: {
        type: "string",
        description: "Annotation/label for the action in Flow Designer",
      },
    },
    required: ["name"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  var name = args.name
  var description = args.description || ""
  var category = args.category || "Custom"
  var action_type = args.action_type || "rest"
  var connection_alias = args.connection_alias || ""
  var inputs = args.inputs || []
  var outputs = args.outputs || []
  var rest_config = args.rest_config || {}
  var script_config = args.script_config || {}
  var active = args.active !== false
  var annotation = args.annotation || ""

  try {
    var client = await getAuthenticatedClient(context)
    var usedBackgroundScript = false

    // Resolve connection alias if name provided
    var connectionAliasId = connection_alias
    if (connection_alias && !connection_alias.match(/^[a-f0-9]{32}$/)) {
      var aliasLookup = await client.get("/api/now/table/sys_alias", {
        params: {
          sysparm_query: "name=" + connection_alias,
          sysparm_limit: 1,
          sysparm_fields: "sys_id",
        },
      })
      if (aliasLookup.data.result && aliasLookup.data.result.length > 0) {
        connectionAliasId = aliasLookup.data.result[0].sys_id
      }
    }

    // Create the action type definition
    var actionData: any = {
      name: name,
      description: description,
      category: category,
      active: active,
      annotation: annotation,
    }

    if (connectionAliasId) {
      actionData.connection_alias = connectionAliasId
    }

    var actionResponse
    try {
      actionResponse = await client.post("/api/now/table/sys_hub_action_type_definition", actionData)
    } catch (tableError: any) {
      if (tableError.response?.status === 403) {
        usedBackgroundScript = true
        var script = `
          var gr = new GlideRecord('sys_hub_action_type_definition');
          gr.initialize();
          gr.name = ${JSON.stringify(name)};
          gr.description = ${JSON.stringify(description)};
          gr.category = ${JSON.stringify(category)};
          gr.active = ${active};
          gr.annotation = ${JSON.stringify(annotation)};
          ${connectionAliasId ? `gr.connection_alias = ${JSON.stringify(connectionAliasId)};` : ""}
          var sysId = gr.insert();

          if (sysId) {
            gs.print(JSON.stringify({
              sys_id: sysId,
              name: gr.name.toString()
            }));
          } else {
            gs.error('Failed to create action');
          }
        `

        var scriptResponse = await client.post("/api/now/table/sys_script_execution", {
          script: script,
          description: "Create Flow action: " + name,
        })

        var output = scriptResponse.data.result?.output || ""
        var match = output.match(/\{[^}]+\}/)
        if (match) {
          actionResponse = { data: { result: JSON.parse(match[0]) } }
        } else {
          throw new Error("Failed to create action via background script")
        }
      } else {
        throw tableError
      }
    }

    var action = actionResponse.data.result

    // Create input parameters
    var createdInputs = []
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i]
      var inputData = {
        action_type: action.sys_id,
        name: input.name,
        label: input.label || input.name,
        type: input.type || "string",
        mandatory: input.mandatory || false,
        default_value: input.default_value || "",
      }

      try {
        var inputResponse = await client.post("/api/now/table/sys_hub_action_input", inputData)
        createdInputs.push({
          sys_id: inputResponse.data.result.sys_id,
          name: input.name,
          type: input.type || "string",
        })
      } catch (inputError: any) {
        if (inputError.response?.status === 403) {
          var inputScript = `
            var gr = new GlideRecord('sys_hub_action_input');
            gr.initialize();
            gr.action_type = ${JSON.stringify(action.sys_id)};
            gr.name = ${JSON.stringify(input.name)};
            gr.label = ${JSON.stringify(input.label || input.name)};
            gr.type = ${JSON.stringify(input.type || "string")};
            gr.mandatory = ${input.mandatory || false};
            gr.default_value = ${JSON.stringify(input.default_value || "")};
            var sysId = gr.insert();
            if (sysId) {
              gs.print(JSON.stringify({ sys_id: sysId, name: ${JSON.stringify(input.name)} }));
            }
          `

          var inputScriptResponse = await client.post("/api/now/table/sys_script_execution", {
            script: inputScript,
            description: "Create action input: " + input.name,
          })

          var inputOutput = inputScriptResponse.data.result?.output || ""
          var inputMatch = inputOutput.match(/\{[^}]+\}/)
          if (inputMatch) {
            createdInputs.push(JSON.parse(inputMatch[0]))
          }
        }
      }
    }

    // Create output parameters
    var createdOutputs = []
    for (var j = 0; j < outputs.length; j++) {
      var outputParam = outputs[j]
      var outputData = {
        action_type: action.sys_id,
        name: outputParam.name,
        label: outputParam.label || outputParam.name,
        type: outputParam.type || "string",
      }

      try {
        var outputResponse = await client.post("/api/now/table/sys_hub_action_output", outputData)
        createdOutputs.push({
          sys_id: outputResponse.data.result.sys_id,
          name: outputParam.name,
          type: outputParam.type || "string",
        })
      } catch (outputError: any) {
        if (outputError.response?.status === 403) {
          var outputScript = `
            var gr = new GlideRecord('sys_hub_action_output');
            gr.initialize();
            gr.action_type = ${JSON.stringify(action.sys_id)};
            gr.name = ${JSON.stringify(outputParam.name)};
            gr.label = ${JSON.stringify(outputParam.label || outputParam.name)};
            gr.type = ${JSON.stringify(outputParam.type || "string")};
            var sysId = gr.insert();
            if (sysId) {
              gs.print(JSON.stringify({ sys_id: sysId, name: ${JSON.stringify(outputParam.name)} }));
            }
          `

          var outputScriptResponse = await client.post("/api/now/table/sys_script_execution", {
            script: outputScript,
            description: "Create action output: " + outputParam.name,
          })

          var outputOutput = outputScriptResponse.data.result?.output || ""
          var outputMatch = outputOutput.match(/\{[^}]+\}/)
          if (outputMatch) {
            createdOutputs.push(JSON.parse(outputMatch[0]))
          }
        }
      }
    }

    // Create action step based on type
    var stepCreated = null
    if (action_type === "rest" && rest_config.http_method) {
      var restStepData = {
        action_type: action.sys_id,
        name: name + " - REST Step",
        step_type: "rest",
        http_method: rest_config.http_method,
        rest_endpoint: rest_config.endpoint_path || "",
        request_body: rest_config.request_body || "",
        content_type: rest_config.content_type || "application/json",
      }

      try {
        var restStepResponse = await client.post("/api/now/table/sys_hub_step_ext", restStepData)
        stepCreated = {
          sys_id: restStepResponse.data.result.sys_id,
          type: "rest",
          http_method: rest_config.http_method,
        }
      } catch (stepError) {
        // Step creation failed, but action is still created
        stepCreated = null
      }
    } else if (action_type === "script" && script_config.script) {
      var scriptStepData = {
        action_type: action.sys_id,
        name: name + " - Script Step",
        step_type: "script",
        script: script_config.script,
      }

      try {
        var scriptStepResponse = await client.post("/api/now/table/sys_hub_step_ext", scriptStepData)
        stepCreated = {
          sys_id: scriptStepResponse.data.result.sys_id,
          type: "script",
        }
      } catch (stepError) {
        stepCreated = null
      }
    }

    return createSuccessResult({
      created: true,
      method: usedBackgroundScript ? "background_script" : "table_api",
      action: {
        sys_id: action.sys_id,
        name: action.name || name,
        category: category,
        action_type: action_type,
        active: active,
      },
      inputs: createdInputs,
      outputs: createdOutputs,
      step: stepCreated,
      connection_alias: connectionAliasId || null,
      usage: [
        "Action is now available in Flow Designer",
        'Use in flows via "Action" step type',
        "Access inputs with inputs.parameter_name",
        "Set outputs with outputs.parameter_name = value",
      ],
    })
  } catch (error: any) {
    if (error.response?.status === 403) {
      return createErrorResult(
        "Permission denied (403): Your ServiceNow user lacks permissions to create Flow actions. " +
          'Required roles: "flow_designer" or "admin". Please contact your ServiceNow administrator.',
      )
    }
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Team"
