import { Effect } from "effect"
import * as prompts from "@clack/prompts"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

// =============================================================================
// ServiceNow MID-Server LLM setup — CLI port of the old fork's TUI wizard
// (dialog-servicenow-llm.tsx). The wizard flow is preserved verbatim:
//   DISCOVER (mid servers + rest messages + models)
//     -> DEPLOY/CONFIGURE the Serac LLM API on the instance
//     -> TEST the chat round-trip
//     -> SAVE the servicenow-llm provider config + token.
//
// 1.16's TUI feature-plugins are internal (no external dialog registry), so the
// wizard is re-expressed as a yargs subcommand using @clack/prompts for input,
// matching cmd/mcp.ts. All ServiceNow REST logic below is a direct port of the
// old wizard's helpers (pure fetch, no TUI deps).
// =============================================================================

interface DiscoveredEndpoint {
  name: string
  sysId: string
  description?: string
  endpoint?: string
  midServer?: string
  methods: Array<{ name: string; httpMethod: string; sysId: string }>
}

interface DiscoveredModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
}

interface MidServer {
  name: string
  sysId: string
  status: string
  validated: boolean
}

// ServiceNow creds as stored by the bundled servicenow auth plugin: an Auth
// "api" record under the "servicenow" key, with metadata{instance,authType,...}
// and `key` (base64 user:pass for basic, or the OAuth access token). Mirrors
// readStoredServiceNowCreds in plugin/servicenow/auth.ts.
interface ServiceNowCreds {
  instanceUrl: string
  authType: "basic" | "oauth"
  token: string
}

function credsFromAuth(entry: Auth.Info | undefined): ServiceNowCreds | undefined {
  if (!entry || entry.type !== "api" || !entry.metadata) return undefined
  const instanceUrl = entry.metadata["instance"]
  if (!instanceUrl) return undefined
  const authType = entry.metadata["authType"] === "basic" ? "basic" : "oauth"
  return { instanceUrl, authType, token: entry.key }
}

function authHeaders(creds: ServiceNowCreds): Record<string, string> {
  const scheme = creds.authType === "basic" ? "Basic" : "Bearer"
  return {
    Authorization: `${scheme} ${creds.token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  }
}

// =============================================================================
// Discovery helpers (ported from the old wizard)
// =============================================================================

async function discoverMidServers(instanceUrl: string, headers: Record<string, string>): Promise<MidServer[]> {
  // Try the Serac LLM API first.
  try {
    const response = await fetch(`${instanceUrl}/api/snow_flow/llm/mid-servers`, { headers })
    if (response.ok) {
      const data = await response.json()
      const servers = data.result?.mid_servers || []
      if (servers.length > 0) return servers
    }
  } catch {
    // API not available
  }

  // Fallback: query ecc_agent directly.
  try {
    const response = await fetch(
      `${instanceUrl}/api/now/table/ecc_agent?sysparm_query=status=Up&sysparm_fields=name,sys_id,status,validated&sysparm_limit=50`,
      { headers },
    )
    if (response.ok) {
      const data = await response.json()
      return (data.result || []).map((agent: any) => ({
        name: agent.name,
        sysId: agent.sys_id,
        status: agent.status,
        validated: agent.validated === "true" || agent.validated === true,
      }))
    }
  } catch {
    // Fallback failed
  }

  return []
}

async function discoverRestMessages(
  instanceUrl: string,
  headers: Record<string, string>,
): Promise<DiscoveredEndpoint[]> {
  // Try the Serac LLM API first.
  try {
    const response = await fetch(`${instanceUrl}/api/snow_flow/llm/rest-messages`, { headers })
    if (response.ok) {
      const data = await response.json()
      const messages = data.result?.rest_messages || data.result || data
      if (Array.isArray(messages) && messages.length > 0) {
        return messages.map((item: any) => ({
          name: item.name || item.sys_name || item.id,
          sysId: item.sys_id || item.id,
          description: item.description || item.short_description,
          endpoint: item.rest_endpoint || item.endpoint || "",
          midServer: item.mid_server || "",
          methods: (item.methods || []).map((m: any) => ({
            name: m.name || m.function_name,
            httpMethod: m.http_method,
            sysId: m.sys_id,
          })),
        }))
      }
    }
  } catch {
    // API not available
  }

  // Fallback: query sys_rest_message + its methods.
  try {
    const response = await fetch(
      `${instanceUrl}/api/now/table/sys_rest_message?sysparm_fields=sys_id,name,description,rest_endpoint&sysparm_display_value=true&sysparm_limit=50`,
      { headers },
    )
    if (!response.ok) return []

    const data = await response.json()
    const endpoints: DiscoveredEndpoint[] = []

    for (const msg of data.result || []) {
      let methods: Array<{ name: string; httpMethod: string; sysId: string }> = []
      try {
        const methodsResponse = await fetch(
          `${instanceUrl}/api/now/table/sys_rest_message_fn?sysparm_query=rest_message=${msg.sys_id}&sysparm_fields=function_name,http_method,sys_id&sysparm_limit=20`,
          { headers },
        )
        if (methodsResponse.ok) {
          const methodsData = await methodsResponse.json()
          methods = (methodsData.result || []).map((m: any) => ({
            name: m.function_name,
            httpMethod: m.http_method,
            sysId: m.sys_id,
          }))
        }
      } catch {
        // Methods fetch failed
      }

      endpoints.push({
        name: msg.name,
        sysId: msg.sys_id,
        description: msg.description,
        endpoint: msg.rest_endpoint || "",
        midServer: "",
        methods,
      })
    }

    return endpoints
  } catch {
    // Fallback failed
  }

  return []
}

async function discoverModelsFromEndpoint(
  instanceUrl: string,
  headers: Record<string, string>,
  restMessage: string,
): Promise<DiscoveredModel[]> {
  try {
    const response = await fetch(
      `${instanceUrl}/api/snow_flow/llm/models?rest_message=${encodeURIComponent(restMessage)}`,
      { headers },
    )
    if (!response.ok) return []

    const data = await response.json()
    const models = data.result?.models || data.result || data
    if (!Array.isArray(models)) return []

    return models.map((m: any) => {
      // Extract context window from various field names (vLLM, Ollama, HuggingFace TGI).
      const contextWindow = m.max_model_len || m.context_length || m.max_input_length || m.context_window || undefined
      const ctx = contextWindow ? Number(contextWindow) : undefined
      return {
        id: m.id || m.model_id || m.name || m,
        name: m.name || m.display_name || m.id || m,
        contextWindow: ctx,
        maxTokens: ctx ? Math.min(4096, Math.floor(ctx / 4)) : undefined,
      }
    })
  } catch {
    return []
  }
}

/**
 * Look up model metadata from the models.dev database (fuzzy: exact, partial,
 * normalized). Ported from the old wizard; re-pointed at 1.16's ModelsDev.
 */
function lookupModelInModelsDev(
  database: Record<string, { models?: Record<string, any> }>,
  modelId: string,
): { found: boolean; contextWindow?: number; maxTokens?: number; matchedModel?: string } {
  const normalizedId = modelId.toLowerCase().replace(/[_-]/g, "")

  for (const [, provider] of Object.entries(database)) {
    for (const [modelKey, model] of Object.entries(provider.models || {})) {
      const m = model as any
      const normalizedKey = modelKey.toLowerCase().replace(/[_-]/g, "")
      const normalizedModelId = (m.id || "").toLowerCase().replace(/[_-]/g, "")
      const normalizedName = (m.name || "").toLowerCase().replace(/[_-]/g, "")

      // Exact match
      if (normalizedKey === normalizedId || normalizedModelId === normalizedId) {
        return {
          found: true,
          contextWindow: m.limit?.context,
          maxTokens: m.limit?.output || Math.min(4096, Math.floor((m.limit?.context || 32000) / 4)),
          matchedModel: modelKey,
        }
      }

      // Partial match
      if (
        normalizedKey.includes(normalizedId) ||
        normalizedId.includes(normalizedKey) ||
        normalizedModelId.includes(normalizedId) ||
        normalizedId.includes(normalizedModelId) ||
        normalizedName.includes(normalizedId) ||
        normalizedId.includes(normalizedName)
      ) {
        return {
          found: true,
          contextWindow: m.limit?.context,
          maxTokens: m.limit?.output || Math.min(4096, Math.floor((m.limit?.context || 32000) / 4)),
          matchedModel: modelKey,
        }
      }
    }
  }

  return { found: false }
}

// =============================================================================
// Deploy the Serac LLM API to ServiceNow (ported verbatim from the old wizard)
// =============================================================================

async function deploySnowFlowLLMAPI(options: {
  instanceUrl: string
  headers: Record<string, string>
  restMessage?: string
  httpMethod?: string
  defaultModel?: string
  midServer?: string
}): Promise<{ success: boolean; error?: string; baseUri?: string }> {
  const { instanceUrl, headers } = options

  try {
    // Step 1: Create/update Script Include - SnowFlowLLMService
    const scriptIncludeScript = `var SnowFlowLLMService = Class.create();
SnowFlowLLMService.prototype = {
    initialize: function() {},

    chat: function(message, maxTokens, restMessageName, httpMethodName, modelName) {
        var result = { success: false, response: '', error: '' };
        try {
            var r = new sn_ws.RESTMessageV2(restMessageName, httpMethodName);
            // Force MID Server routing: setMIDServer takes the MID NAME (ecc_agent.name), not sys_id,
            // and overrides any "Use MID Server" config on the REST Message record at runtime.
            // skip_sensor avoids the Sensor business rule racing the response and returning a null body.
            var midServer = gs.getProperty('snow_flow.llm.mid_server', '');
            if (midServer) {
                r.setMIDServer(midServer);
                r.setEccParameter('skip_sensor', true);
            }
            var requestBody = JSON.stringify({
                model: modelName || gs.getProperty('snow_flow.llm.default_model', 'default'),
                messages: [{ role: 'user', content: message }],
                max_tokens: maxTokens || 100
            });
            r.setRequestBody(requestBody);
            var response = r.execute();
            var httpStatus = response.getStatusCode();
            var body = response.getBody();
            if (httpStatus == 200) {
                var parsed = JSON.parse(body);
                result.success = true;
                if (parsed.choices && parsed.choices.length > 0) {
                    result.response = parsed.choices[0].message.content;
                } else {
                    result.response = body;
                }
                result.model = parsed.model;
                result.usage = parsed.usage;
            } else {
                result.error = 'HTTP ' + httpStatus + ': ' + body;
            }
        } catch (ex) {
            result.error = ex.getMessage();
        }
        return result;
    },

    chatOpenAI: function(messages, maxTokens, restMessageName, httpMethodName, modelName) {
        var result = { success: false, response: '', error: '' };
        try {
            var r = new sn_ws.RESTMessageV2(restMessageName, httpMethodName);
            // Force MID Server routing: setMIDServer takes the MID NAME (ecc_agent.name), not sys_id,
            // and overrides any "Use MID Server" config on the REST Message record at runtime.
            // skip_sensor avoids the Sensor business rule racing the response and returning a null body.
            var midServer = gs.getProperty('snow_flow.llm.mid_server', '');
            if (midServer) {
                r.setMIDServer(midServer);
                r.setEccParameter('skip_sensor', true);
            }
            var requestBody = JSON.stringify({
                model: modelName || gs.getProperty('snow_flow.llm.default_model', 'default'),
                messages: messages,
                max_tokens: maxTokens || 100
            });
            r.setRequestBody(requestBody);
            var response = r.execute();
            var httpStatus = response.getStatusCode();
            var body = response.getBody();
            if (httpStatus == 200) {
                var parsed = JSON.parse(body);
                result.success = true;
                if (parsed.choices && parsed.choices.length > 0) {
                    result.response = parsed.choices[0].message.content;
                } else {
                    result.response = body;
                }
                result.model = parsed.model;
                result.usage = parsed.usage;
            } else {
                result.error = 'HTTP ' + httpStatus + ': ' + body;
            }
        } catch (ex) {
            result.error = ex.getMessage();
        }
        return result;
    },

    getMidServers: function() {
        var servers = [];
        var gr = new GlideRecord('ecc_agent');
        gr.addQuery('status', 'Up');
        gr.query();
        while (gr.next()) {
            servers.push({
                name: gr.getValue('name'),
                sys_id: gr.getValue('sys_id'),
                status: gr.getValue('status'),
                validated: gr.getValue('validated') == 'true'
            });
        }
        return servers;
    },

    getRestMessages: function() {
        var messages = [];
        var gr = new GlideRecord('sys_rest_message');
        gr.query();
        while (gr.next()) {
            var methods = [];
            var methodGr = new GlideRecord('sys_rest_message_fn');
            methodGr.addQuery('rest_message', gr.getValue('sys_id'));
            methodGr.query();
            while (methodGr.next()) {
                methods.push({
                    name: methodGr.getValue('function_name'),
                    http_method: methodGr.getValue('http_method'),
                    sys_id: methodGr.getValue('sys_id')
                });
            }
            messages.push({
                name: gr.getValue('name'),
                sys_id: gr.getValue('sys_id'),
                endpoint: gr.getValue('rest_endpoint') || '',
                methods: methods
            });
        }
        return messages;
    },

    getModels: function(restMessageName) {
        var result = { success: false, models: [], error: '' };
        try {
            var r = new sn_ws.RESTMessageV2(restMessageName, 'Get_Models');
            var response = r.execute();
            var httpStatus = response.getStatusCode();
            var body = response.getBody();
            if (httpStatus == 200) {
                var parsed = JSON.parse(body);
                result.success = true;
                result.models = parsed.data || [];
            } else {
                result.error = 'HTTP ' + httpStatus;
            }
        } catch (ex) {
            result.error = ex.getMessage();
        }
        return result;
    },

    type: 'SnowFlowLLMService'
};`

    // Check if Script Include exists
    const siCheckResponse = await fetch(
      `${instanceUrl}/api/now/table/sys_script_include?sysparm_query=name=SnowFlowLLMService&sysparm_limit=1`,
      { headers },
    )
    const siCheckData = await siCheckResponse.json()

    if (siCheckData.result && siCheckData.result.length > 0) {
      await fetch(`${instanceUrl}/api/now/table/sys_script_include/${siCheckData.result[0].sys_id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ script: scriptIncludeScript }),
      })
    } else {
      const createResponse = await fetch(`${instanceUrl}/api/now/table/sys_script_include`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "SnowFlowLLMService",
          api_name: "global.SnowFlowLLMService",
          script: scriptIncludeScript,
          active: true,
          client_callable: false,
          description: "Serac LLM Service for MID Server LLM integration",
        }),
      })
      if (!createResponse.ok) {
        return { success: false, error: `Failed to create Script Include: HTTP ${createResponse.status}` }
      }
    }

    // Step 2: Create/check Scripted REST API
    const restCheckResponse = await fetch(
      `${instanceUrl}/api/now/table/sys_ws_definition?sysparm_query=service_id=snow_flow&sysparm_fields=sys_id,namespace,base_uri&sysparm_limit=1`,
      { headers },
    )
    const restCheckData = await restCheckResponse.json()

    let restApiSysId: string
    let apiBaseUri: string = ""

    if (restCheckData.result && restCheckData.result.length > 0) {
      restApiSysId = restCheckData.result[0].sys_id
      apiBaseUri = restCheckData.result[0].base_uri || ""
    } else {
      const restApiResponse = await fetch(`${instanceUrl}/api/now/table/sys_ws_definition`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Serac LLM",
          service_id: "snow_flow",
          short_description: "Serac LLM API for MID Server integration",
          active: true,
        }),
      })
      if (!restApiResponse.ok) {
        return { success: false, error: `Failed to create REST API: HTTP ${restApiResponse.status}` }
      }
      const restApiData = await restApiResponse.json()
      restApiSysId = restApiData.result.sys_id

      // Refetch for generated namespace
      const refetchResponse = await fetch(
        `${instanceUrl}/api/now/table/sys_ws_definition/${restApiSysId}?sysparm_fields=namespace,base_uri`,
        { headers },
      )
      if (refetchResponse.ok) {
        const refetchData = await refetchResponse.json()
        apiBaseUri = refetchData.result?.base_uri || ""
      }
    }

    // Step 3: Create REST Resources
    const resources = [
      {
        name: "MID Servers",
        relative_path: "/llm/mid-servers",
        http_method: "GET",
        operation_script: `(function process(request, response) {
    var service = new SnowFlowLLMService();
    var servers = service.getMidServers();
    response.setStatus(200);
    return { mid_servers: servers };
})(request, response);`,
      },
      {
        name: "REST Messages",
        relative_path: "/llm/rest-messages",
        http_method: "GET",
        operation_script: `(function process(request, response) {
    var service = new SnowFlowLLMService();
    var messages = service.getRestMessages();
    response.setStatus(200);
    return { rest_messages: messages };
})(request, response);`,
      },
      {
        name: "Chat",
        relative_path: "/llm/chat",
        http_method: "POST",
        operation_script: `(function process(request, response) {
    var body = request.body.data;
    var message = body.message;
    var maxTokens = body.max_tokens || 100;
    var restMessage = body.rest_message;
    var httpMethod = body.http_method || 'Chat_Completions';
    var model = body.model;
    var service = new SnowFlowLLMService();
    var result = service.chat(message, maxTokens, restMessage, httpMethod, model);
    response.setStatus(result.success ? 200 : 500);
    return result;
})(request, response);`,
      },
      {
        name: "Chat Completions (OpenAI Compatible)",
        relative_path: "/llm/chat/completions",
        http_method: "POST",
        operation_script: `(function process(request, response) {
    var body = request.body.data;
    var model = body.model || 'default';
    var messages = body.messages || [];
    var maxTokens = body.max_tokens || 100;
    var restMessage = request.getHeader('X-Serac-Rest-Message') ||
                      gs.getProperty('snow_flow.llm.rest_message', '');
    var httpMethod = request.getHeader('X-Serac-Http-Method') ||
                     gs.getProperty('snow_flow.llm.http_method', 'Chat_Completions');
    if (!restMessage) {
        response.setStatus(400);
        return { error: { message: 'REST Message not configured.', type: 'invalid_request_error' } };
    }
    var service = new SnowFlowLLMService();
    var result = service.chatOpenAI(messages, maxTokens, restMessage, httpMethod, model);
    if (result.success) {
        response.setStatus(200);
        return {
            id: 'chatcmpl-' + gs.generateGUID(),
            object: 'chat.completion',
            created: Math.floor(new Date().getTime() / 1000),
            model: result.model || model,
            choices: [{ index: 0, message: { role: 'assistant', content: result.response }, finish_reason: 'stop' }],
            usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };
    } else {
        response.setStatus(500);
        return { error: { message: result.error, type: 'api_error' } };
    }
})(request, response);`,
      },
      {
        name: "Models",
        relative_path: "/llm/models",
        http_method: "GET",
        operation_script: `(function process(request, response) {
    var restMessage = request.queryParams.rest_message;
    if (!restMessage) { response.setStatus(400); return { error: 'rest_message parameter required' }; }
    var service = new SnowFlowLLMService();
    var result = service.getModels(restMessage);
    response.setStatus(result.success ? 200 : 500);
    return result;
})(request, response);`,
      },
    ]

    for (const resource of resources) {
      const resCheckResponse = await fetch(
        `${instanceUrl}/api/now/table/sys_ws_operation?sysparm_query=web_service_definition=${restApiSysId}^relative_path=${encodeURIComponent(resource.relative_path)}&sysparm_limit=1`,
        { headers },
      )
      const resCheckData = await resCheckResponse.json()

      if (resCheckData.result && resCheckData.result.length > 0) {
        await fetch(`${instanceUrl}/api/now/table/sys_ws_operation/${resCheckData.result[0].sys_id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ operation_script: resource.operation_script }),
        })
      } else {
        const createRes = await fetch(`${instanceUrl}/api/now/table/sys_ws_operation`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: resource.name,
            web_service_definition: restApiSysId,
            http_method: resource.http_method,
            relative_path: resource.relative_path,
            operation_script: resource.operation_script,
            active: true,
          }),
        })
        if (!createRes.ok) {
          return { success: false, error: `Failed to create resource ${resource.name}: HTTP ${createRes.status}` }
        }
      }
    }

    // Set system properties (idempotent create-or-update by name).
    // When a MID Server is selected we ALSO lift the instance-wide 30s ECC response cap
    // (glide.http.outbound.max_timeout.enabled='false') and raise the ECC response timeout
    // to 190s so long LLM completions can complete via the ECC queue.
    if (options.restMessage || options.httpMethod || options.defaultModel || options.midServer) {
      const midProps = options.midServer
        ? [
            { name: "snow_flow.llm.mid_server", value: options.midServer },
            { name: "glide.http.outbound.max_timeout.enabled", value: "false" },
            { name: "glide.rest.outbound.ecc_response.timeout", value: "190" },
          ]
        : []
      const properties = [
        { name: "snow_flow.llm.rest_message", value: options.restMessage || "" },
        { name: "snow_flow.llm.http_method", value: options.httpMethod || "Chat_Completions" },
        { name: "snow_flow.llm.default_model", value: options.defaultModel || "default" },
        ...midProps,
      ]

      for (const prop of properties) {
        if (!prop.value) continue
        const propCheckResponse = await fetch(
          `${instanceUrl}/api/now/table/sys_properties?sysparm_query=name=${encodeURIComponent(prop.name)}&sysparm_limit=1`,
          { headers },
        )
        const propCheckData = await propCheckResponse.json()

        if (propCheckData.result && propCheckData.result.length > 0) {
          await fetch(`${instanceUrl}/api/now/table/sys_properties/${propCheckData.result[0].sys_id}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ value: prop.value }),
          })
        } else {
          await fetch(`${instanceUrl}/api/now/table/sys_properties`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              name: prop.name,
              value: prop.value,
              description: "Serac LLM configuration",
              type: "string",
            }),
          })
        }
      }
    }

    // No MID Server selected: clear any previously-forced routing so deploy turns it off.
    // Leave the glide.* timeout properties untouched (do not re-enable the instance-wide cap).
    if (!options.midServer) {
      const clearCheckResponse = await fetch(
        `${instanceUrl}/api/now/table/sys_properties?sysparm_query=name=snow_flow.llm.mid_server&sysparm_limit=1`,
        { headers },
      )
      const clearCheckData = await clearCheckResponse.json()
      if (clearCheckData.result && clearCheckData.result.length > 0) {
        await fetch(`${instanceUrl}/api/now/table/sys_properties/${clearCheckData.result[0].sys_id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ value: "" }),
        })
      }
    }

    return { success: true, baseUri: apiBaseUri }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

/**
 * Test LLM chat via the Serac API (ported verbatim from the old wizard).
 */
async function testSnowFlowLLMChat(options: {
  instanceUrl: string
  headers: Record<string, string>
  restMessage: string
  httpMethod: string
  model?: string
  apiBaseUri?: string
}): Promise<{ success: boolean; response?: string; error?: string }> {
  const baseUri = options.apiBaseUri ? `${options.apiBaseUri}/llm` : "/api/snow_flow/llm"

  try {
    const response = await fetch(`${options.instanceUrl}${baseUri}/chat`, {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify({
        message: 'Say "Hello from MID Server LLM!" in exactly those words.',
        max_tokens: 50,
        rest_message: options.restMessage,
        http_method: options.httpMethod,
        model: options.model,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      return { success: false, error: errorData.error?.message || `HTTP ${response.status}` }
    }

    const data = await response.json()
    if (data.result?.success) {
      return { success: true, response: data.result.response }
    }
    return { success: false, error: data.result?.error || "Unknown error" }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

/**
 * Create a friendly alias for the model (e.g. "Qwen/Qwen3-1.7B" -> "qwen3-1.7b").
 */
function createModelAlias(modelId: string): string {
  const parts = modelId.split("/")
  const modelName = parts[parts.length - 1]
  return modelName.toLowerCase().replace(/[^a-z0-9.-]/g, "")
}

function formatContextWindow(ctx?: number): string {
  if (!ctx) return ""
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}K ctx`
  return `${ctx} ctx`
}

function cancel<T>(value: T | symbol): T {
  if (prompts.isCancel(value)) throw new UI.CancelledError()
  return value as T
}

// =============================================================================
// Commands
// =============================================================================

export const ServiceNowCommand = effectCmd({
  command: "servicenow",
  describe: "configure ServiceNow integrations",
  builder: (yargs) => yargs.command(ServiceNowSetupLlmCommand).demandCommand(),
  // Parent group — never reached because demandCommand() forces a subcommand.
  handler: Effect.fn("Cli.servicenow")(function* () {}),
})

export const ServiceNowSetupLlmCommand = effectCmd({
  command: "setup-llm",
  describe: "discover, deploy and test a MID-Server-routed LLM on your ServiceNow instance",
  handler: Effect.fn("Cli.servicenow.setup-llm")(function* () {
    // Read the stored ServiceNow creds (written by the bundled servicenow auth plugin).
    const entry = yield* Auth.Service.use((auth) => auth.get("servicenow")).pipe(Effect.orElseSucceed(() => undefined))
    const creds = credsFromAuth(entry)
    // models.dev database for the context-window lookup.
    const modelsDb = yield* ModelsDev.Service.use((s) => s.get())
    const configSvc = yield* Config.Service
    const authSvc = yield* Auth.Service

    yield* Effect.promise(async () => {
      UI.empty()
      prompts.intro("ServiceNow MID Server LLM Setup")

      if (!creds) {
        prompts.log.error(
          "No ServiceNow auth configured. Run `opencode auth login` and pick ServiceNow (OAuth or Basic) first.",
        )
        prompts.outro("Aborted")
        return
      }

      const { instanceUrl } = creds
      const headers = authHeaders(creds)
      prompts.log.info(`Instance: ${UI.Style.TEXT_DIM}${instanceUrl}${UI.Style.TEXT_NORMAL}`)

      // -----------------------------------------------------------------------
      // DISCOVER
      // -----------------------------------------------------------------------
      const spin = prompts.spinner()
      spin.start("Discovering MID Servers and REST Messages...")
      const [midServers, endpoints] = await Promise.all([
        discoverMidServers(instanceUrl, headers),
        discoverRestMessages(instanceUrl, headers),
      ])
      spin.stop(`Found ${midServers.length} MID Server(s) and ${endpoints.length} REST Message(s)`)

      // -----------------------------------------------------------------------
      // SELECT ENDPOINT (or manual entry)
      // -----------------------------------------------------------------------
      let selectedEndpoint: DiscoveredEndpoint | undefined
      if (endpoints.length > 0) {
        const picked = cancel(
          await prompts.select({
            message: "Select the LLM REST Message",
            options: [
              ...endpoints.map((e) => ({
                value: e.sysId,
                label: e.name,
                hint: e.description || e.endpoint || undefined,
              })),
              { value: "__manual__", label: "Enter manually..." },
            ],
          }),
        )
        if (picked !== "__manual__") selectedEndpoint = endpoints.find((e) => e.sysId === picked)
      }

      if (!selectedEndpoint) {
        const name = cancel(
          await prompts.text({
            message: "REST Message name",
            placeholder: "e.g. LLM Gateway",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          }),
        )
        selectedEndpoint = { name, sysId: "", methods: [], midServer: "" }
      }

      // -----------------------------------------------------------------------
      // SELECT METHOD
      // -----------------------------------------------------------------------
      let selectedMethod = "Chat_Completions"
      if (selectedEndpoint.methods.length > 1) {
        selectedMethod = cancel(
          await prompts.select({
            message: "Select the HTTP Method",
            options: selectedEndpoint.methods.map((m) => ({
              value: m.name,
              label: m.name,
              hint: m.httpMethod,
            })),
          }),
        )
      } else if (selectedEndpoint.methods.length === 1) {
        selectedMethod = selectedEndpoint.methods[0].name
      }

      // -----------------------------------------------------------------------
      // SELECT MID SERVER (force routing)
      // -----------------------------------------------------------------------
      let selectedMidServer = selectedEndpoint.midServer || ""
      if (midServers.length > 0) {
        const pickedMid = cancel(
          await prompts.select({
            message: "Route LLM calls through a MID Server?",
            options: [
              { value: "", label: "No MID Server (direct outbound)" },
              ...midServers.map((m) => ({
                value: m.name,
                label: m.name,
                hint: m.validated ? `${m.status} (validated)` : m.status,
              })),
            ],
            initialValue: selectedMidServer,
          }),
        )
        selectedMidServer = pickedMid
      }

      // -----------------------------------------------------------------------
      // SELECT MODEL (discover -> models.dev enrich -> or manual)
      // -----------------------------------------------------------------------
      spin.start("Discovering available models...")
      const models = await discoverModelsFromEndpoint(instanceUrl, headers, selectedEndpoint.name)
      spin.stop(models.length > 0 ? `Found ${models.length} model(s)` : "No models auto-discovered")

      let selectedModel: DiscoveredModel | undefined
      if (models.length > 0) {
        const pickedModel = cancel(
          await prompts.select({
            message: "Select the model",
            options: [
              ...models.map((m) => ({
                value: m.id,
                label: m.name,
                hint: formatContextWindow(m.contextWindow) || undefined,
              })),
              { value: "__manual__", label: "Enter manually..." },
            ],
          }),
        )
        if (pickedModel !== "__manual__") selectedModel = models.find((m) => m.id === pickedModel)
      }

      if (!selectedModel) {
        const modelId = cancel(
          await prompts.text({
            message: "Model ID",
            placeholder: "e.g. Qwen/Qwen3-1.7B",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          }),
        )
        selectedModel = { id: modelId, name: modelId }
      }

      // Enrich the context window from models.dev when the endpoint didn't supply it.
      if (!selectedModel.contextWindow) {
        const lookup = lookupModelInModelsDev(modelsDb as any, selectedModel.id)
        if (lookup.found && lookup.contextWindow) {
          selectedModel.contextWindow = lookup.contextWindow
          selectedModel.maxTokens = lookup.maxTokens
          prompts.log.info(
            `models.dev match: ${lookup.matchedModel} (${formatContextWindow(lookup.contextWindow)})`,
          )
        }
      }

      // -----------------------------------------------------------------------
      // DEPLOY
      // -----------------------------------------------------------------------
      let apiBaseUri = ""
      let gatewayDeployed = false
      const shouldDeploy = cancel(
        await prompts.confirm({
          message: "Deploy / update the Serac LLM API on the instance now?",
          initialValue: true,
        }),
      )

      if (shouldDeploy) {
        spin.start("Deploying Serac LLM API...")
        const result = await deploySnowFlowLLMAPI({
          instanceUrl,
          headers,
          restMessage: selectedEndpoint.name,
          httpMethod: selectedMethod,
          defaultModel: selectedModel.id,
          midServer: selectedMidServer,
        })
        if (result.success) {
          gatewayDeployed = true
          apiBaseUri = result.baseUri || ""
          spin.stop("Serac LLM API deployed successfully")
          if (selectedMidServer) {
            prompts.log.info(
              `MID routing forced via ${selectedMidServer}; instance-wide 30s ECC cap lifted (timeout 190s).`,
            )
          }
        } else {
          spin.stop("Deployment failed", 1)
          prompts.log.error(result.error || "Unknown error")
        }
      }

      // -----------------------------------------------------------------------
      // TEST
      // -----------------------------------------------------------------------
      let connectivityTested = false
      if (gatewayDeployed) {
        const shouldTest = cancel(
          await prompts.confirm({
            message: "Run a chat round-trip test against the MID Server LLM now?",
            initialValue: true,
          }),
        )
        if (shouldTest) {
          spin.start("Testing LLM chat...")
          const test = await testSnowFlowLLMChat({
            instanceUrl,
            headers,
            restMessage: selectedEndpoint.name,
            httpMethod: selectedMethod,
            model: selectedModel.id,
            apiBaseUri,
          })
          if (test.success) {
            connectivityTested = true
            spin.stop("LLM chat test passed")
            if (test.response) prompts.log.info(`Response: ${test.response}`)
          } else {
            spin.stop("LLM chat test failed", 1)
            prompts.log.error(test.error || "Unknown error")
          }
        }
      }

      // -----------------------------------------------------------------------
      // SAVE (provider config + default model + token) — mirrors the old saveConfig()
      // -----------------------------------------------------------------------
      const modelId = selectedModel.id
      const effectiveContextWindow = selectedModel.contextWindow || 32000
      const effectiveMaxTokens = selectedModel.maxTokens || 4096
      const routeLabel = selectedMidServer ? `via MID Server ${selectedMidServer}` : "via ServiceNow"

      const modelAlias = createModelAlias(modelId)
      const useAlias = modelAlias !== modelId.toLowerCase()

      const effectiveBaseUri = apiBaseUri ? `${apiBaseUri}/llm` : "/api/snow_flow/llm"
      const baseURL = `${instanceUrl}${effectiveBaseUri}`

      const modelEntry = {
        name: `${modelId} (${routeLabel})`,
        tool_call: true,
        temperature: true,
        reasoning: false,
        attachment: false,
        modalities: { input: ["text" as const], output: ["text" as const] },
        limit: { context: effectiveContextWindow, output: effectiveMaxTokens },
        cost: { input: 0, output: 0 },
      }
      const modelsConfig: Record<string, typeof modelEntry & { id?: string }> = {}
      if (useAlias) modelsConfig[modelAlias] = { ...modelEntry, id: modelId }
      modelsConfig[modelId] = modelEntry

      const providerConfig: ConfigV1.Info = {
        provider: {
          "servicenow-llm": {
            npm: "@ai-sdk/openai-compatible",
            name: "ServiceNow MID Server LLM",
            api: baseURL,
            models: modelsConfig,
            options: {
              baseURL,
              timeout: 180000,
              restMessage: selectedEndpoint.name,
              httpMethod: selectedMethod,
              midServer: selectedMidServer,
              defaultModel: modelId,
              gatewayDeployed,
              connectivityTested,
            },
          },
        },
        model: useAlias ? `servicenow-llm/${modelAlias}` : `servicenow-llm/${modelId}`,
      }

      await Effect.runPromise(configSvc.update(providerConfig))

      // Store the ServiceNow access token as the servicenow-llm api key so
      // @ai-sdk/openai-compatible can authenticate.
      await Effect.runPromise(authSvc.set("servicenow-llm", { type: "api", key: creds.token }))

      const displayModel = useAlias ? `servicenow-llm/${modelAlias}` : `servicenow-llm/${modelId}`
      prompts.outro(`MID Server LLM configured: ${displayModel}`)
    })
  }),
})
