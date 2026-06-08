import { createSignal, onMount, Show, For } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { useTheme } from "@tui/context/theme"
import { TextAttributes, TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"

type Step =
  | "check-auth"
  | "discovering"
  | "select-endpoint"
  | "select-method"
  | "select-model"
  | "deploy-confirm"
  | "deploying"
  | "test-confirm"
  | "testing"
  | "manual-url"
  | "manual-model"
  | "saving"

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

// ============================================================================
// Discovery helpers (ported from old auth.ts)
// ============================================================================

async function discoverMidServers(
  instanceUrl: string,
  headers: Record<string, string>,
): Promise<Array<{ name: string; sysId: string; status: string; validated: boolean }>> {
  // Try Serac LLM API first
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

  // Fallback: query ecc_agent table directly
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
  // Try Serac LLM API first
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

  // Fallback: query sys_rest_message table + methods
  try {
    const response = await fetch(
      `${instanceUrl}/api/now/table/sys_rest_message?sysparm_fields=sys_id,name,description,rest_endpoint&sysparm_display_value=true&sysparm_limit=50`,
      { headers },
    )
    if (!response.ok) return []

    const data = await response.json()
    const endpoints: DiscoveredEndpoint[] = []

    for (const msg of data.result || []) {
      // Fetch HTTP methods for this REST Message
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
      // Extract context window from various field names (vLLM, Ollama, HuggingFace TGI)
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
 * Look up model metadata from models.dev database
 * Fuzzy matching: exact, partial, and normalized
 */
async function lookupModelInModelsDev(
  modelId: string,
): Promise<{ found: boolean; contextWindow?: number; maxTokens?: number; matchedModel?: string }> {
  try {
    const { ModelsDev } = await import("@/provider/models")
    const database = await ModelsDev.get()
    const normalizedId = modelId.toLowerCase().replace(/[_-]/g, "")

    for (const [, provider] of Object.entries(database)) {
      for (const [modelKey, model] of Object.entries((provider as any).models || {})) {
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
  } catch {
    return { found: false }
  }
}

// ============================================================================
// Deploy Serac LLM API to ServiceNow (ported from old auth.ts)
// ============================================================================

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
 * Test LLM chat via Serac API
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
 * Create a friendly alias for the model (e.g., "Qwen/Qwen3-1.7B" → "qwen3-1.7b")
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

// ============================================================================
// Main Dialog Component
// ============================================================================

/**
 * ServiceNow LLM (MID Server) configuration dialog.
 * Full flow: auth check → discovery → endpoint → method → model → deploy → test → save
 */
export function DialogAuthServiceNowLLM() {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()

  const [step, setStep] = createSignal<Step>("check-auth")
  const [instance, setInstance] = createSignal("")
  const [authToken, setAuthToken] = createSignal("")
  const [authType, setAuthType] = createSignal<"oauth" | "basic">("oauth")

  // Discovery results
  const [midServers, setMidServers] = createSignal<Array<{ name: string; sysId: string; status: string }>>([])
  const [endpoints, setEndpoints] = createSignal<DiscoveredEndpoint[]>([])
  const [models, setModels] = createSignal<DiscoveredModel[]>([])

  // User selections
  const [selectedEndpoint, setSelectedEndpoint] = createSignal<DiscoveredEndpoint | null>(null)
  const [selectedMethod, setSelectedMethod] = createSignal<string>("Chat_Completions")
  const [selectedMidServer, setSelectedMidServer] = createSignal<string>("")
  const [selectedModel, setSelectedModel] = createSignal<DiscoveredModel | null>(null)

  // Deploy & test state
  const [apiBaseUri, setApiBaseUri] = createSignal("")
  const [gatewayDeployed, setGatewayDeployed] = createSignal(false)
  const [connectivityTested, setConnectivityTested] = createSignal(false)
  const [testResponse, setTestResponse] = createSignal("")

  // Manual input
  const [manualUrl, setManualUrl] = createSignal("")
  const [manualModel, setManualModel] = createSignal("")

  let manualUrlInput: TextareaRenderable
  let manualModelInput: TextareaRenderable

  const getAuthHeaders = (): Record<string, string> => {
    const base =
      authType() === "basic" ? { Authorization: `Basic ${authToken()}` } : { Authorization: `Bearer ${authToken()}` }
    return { ...base, Accept: "application/json", "Content-Type": "application/json" }
  }

  onMount(async () => {
    try {
      const { Auth } = await import("@/auth")
      let snAuth = await Auth.get("servicenow")

      // If no local ServiceNow auth, try fetching from enterprise portal
      if (!snAuth) {
        const entAuth = await Auth.get("enterprise")
        if (entAuth?.type === "enterprise" && entAuth.token && entAuth.enterpriseUrl) {
          try {
            const portalUrl = entAuth.enterpriseUrl
            const response = await fetch(`${portalUrl}/api/user-credentials/servicenow/default`, {
              method: "GET",
              headers: { Authorization: `Bearer ${entAuth.token}`, Accept: "application/json" },
            })

            if (response.ok) {
              const data = await response.json()
              if (
                data.success &&
                data.instance?.instanceUrl &&
                data.instance?.clientId &&
                data.instance?.clientSecret
              ) {
                await Auth.set("servicenow", {
                  type: "servicenow-oauth",
                  instance: data.instance.instanceUrl,
                  clientId: data.instance.clientId,
                  clientSecret: data.instance.clientSecret,
                })
                snAuth = await Auth.get("servicenow")
                toast.show({
                  variant: "info",
                  message: "ServiceNow credentials loaded from enterprise portal",
                  duration: 3000,
                })
              }
            }
          } catch {
            // Enterprise portal fetch failed
          }
        }
      }

      if (!snAuth) {
        toast.show({
          variant: "error",
          message: "No ServiceNow auth configured. Please set up OAuth or Basic Auth first.",
          duration: 5000,
        })
        setTimeout(async () => {
          const { DialogAuth } = await import("./dialog-auth")
          dialog.replace(() => <DialogAuth />)
        }, 2000)
        return
      }

      if (snAuth.type === "servicenow-oauth") {
        setInstance(snAuth.instance)
        setAuthType("oauth")
        if (snAuth.accessToken) {
          setAuthToken(snAuth.accessToken)
        }
      } else if (snAuth.type === "servicenow-basic") {
        setInstance(snAuth.instance)
        setAuthType("basic")
        setAuthToken(Buffer.from(`${snAuth.username}:${snAuth.password}`).toString("base64"))
      }

      // Check if servicenow-llm is already configured (for pre-filling)
      const llmAuth = await Auth.get("servicenow-llm")
      if (llmAuth?.type === "mid-server") {
        setManualUrl(`${llmAuth.instance}/api/snow_flow/llm`)
        if (llmAuth.midServerName) {
          setManualModel(llmAuth.midServerName)
        }
      }

      // Start discovery
      setStep("discovering")
      await runDiscovery()
    } catch {
      toast.show({ variant: "error", message: "Failed to load auth credentials", duration: 5000 })
    }
  })

  useKeyboard((evt) => {
    const currentStep = step()

    if (evt.name === "escape") {
      if (currentStep === "check-auth" || currentStep === "discovering" || currentStep === "select-endpoint") {
        goBack()
      } else if (currentStep === "select-method") {
        setStep("select-endpoint")
      } else if (currentStep === "select-model") {
        if (selectedEndpoint()?.methods && selectedEndpoint()!.methods.length > 1) {
          setStep("select-method")
        } else {
          setStep("select-endpoint")
        }
      } else if (currentStep === "deploy-confirm") {
        setStep("select-model")
      } else if (currentStep === "test-confirm") {
        setStep("deploy-confirm")
      } else if (currentStep === "manual-url") {
        goBack()
      } else if (currentStep === "manual-model") {
        setStep("manual-url")
        setTimeout(() => manualUrlInput?.focus(), 10)
      }
    }

    // Y/N keyboard handling for deploy-confirm and test-confirm
    if (currentStep === "deploy-confirm") {
      if (evt.name === "y") handleDeploy(true)
      else if (evt.name === "n") handleDeploy(false)
    } else if (currentStep === "test-confirm") {
      if (evt.name === "y") handleTest(true)
      else if (evt.name === "n") handleTest(false)
    }
  })

  const goBack = async () => {
    const { DialogAuth } = await import("./dialog-auth")
    dialog.replace(() => <DialogAuth />)
  }

  // ============================================================================
  // Discovery
  // ============================================================================

  const runDiscovery = async () => {
    const inst = instance()
    if (!inst || !authToken()) {
      setStep("manual-url")
      setTimeout(() => manualUrlInput?.focus(), 10)
      return
    }

    const headers = getAuthHeaders()

    // Discover MID Servers and REST Messages in parallel
    const [midServerResults, restMessageResults] = await Promise.all([
      discoverMidServers(inst, headers),
      discoverRestMessages(inst, headers),
    ])

    setMidServers(midServerResults)

    const hasMidServers = midServerResults.length > 0
    const hasRestMessages = restMessageResults.length > 0

    if (hasRestMessages) {
      setEndpoints(restMessageResults)
      if (hasMidServers) {
        toast.show({
          variant: "info",
          message: `Found ${midServerResults.length} MID Server(s) and ${restMessageResults.length} REST Message(s)`,
          duration: 3000,
        })
      }
      setStep("select-endpoint")
    } else if (hasMidServers) {
      toast.show({
        variant: "error",
        message: `Found ${midServerResults.length} MID Server(s) but no LLM REST Messages configured`,
        duration: 5000,
      })
      setStep("manual-url")
      setTimeout(() => manualUrlInput?.focus(), 10)
    } else {
      toast.show({
        variant: "info",
        message: "Auto-discovery unavailable. Please enter endpoint manually.",
        duration: 3000,
      })
      setStep("manual-url")
      setTimeout(() => manualUrlInput?.focus(), 10)
    }
  }

  // ============================================================================
  // Endpoint / Method / Model selection
  // ============================================================================

  const handleEndpointSelect = async (endpoint: DiscoveredEndpoint) => {
    setSelectedEndpoint(endpoint)
    setSelectedMidServer(endpoint.midServer || "")

    // If multiple HTTP Methods, let user choose
    if (endpoint.methods.length > 1) {
      setStep("select-method")
    } else if (endpoint.methods.length === 1) {
      setSelectedMethod(endpoint.methods[0].name)
      setStep("discovering")
      await runModelDiscovery(endpoint)
    } else {
      setSelectedMethod("Chat_Completions")
      setStep("discovering")
      await runModelDiscovery(endpoint)
    }
  }

  const handleMethodSelect = async (methodName: string) => {
    setSelectedMethod(methodName)
    const endpoint = selectedEndpoint()
    if (endpoint) {
      setStep("discovering")
      await runModelDiscovery(endpoint)
    }
  }

  const runModelDiscovery = async (endpoint: DiscoveredEndpoint) => {
    const inst = instance()
    const headers = getAuthHeaders()
    const discovered = await discoverModelsFromEndpoint(inst, headers, endpoint.name)

    if (discovered.length > 0) {
      setModels(discovered)
      setStep("select-model")
    } else {
      toast.show({
        variant: "info",
        message: "Model discovery unavailable. Please enter model ID manually.",
        duration: 3000,
      })
      setStep("manual-model")
      setTimeout(() => manualModelInput?.focus(), 10)
    }
  }

  const handleModelSelect = async (model: DiscoveredModel) => {
    // If no context window from endpoint, try models.dev lookup
    let finalModel = { ...model }
    if (!finalModel.contextWindow) {
      const lookup = await lookupModelInModelsDev(model.id)
      if (lookup.found && lookup.contextWindow) {
        finalModel.contextWindow = lookup.contextWindow
        finalModel.maxTokens = lookup.maxTokens
        toast.show({
          variant: "info",
          message: `Found in models.dev: ${lookup.matchedModel} (${formatContextWindow(lookup.contextWindow)})`,
          duration: 3000,
        })
      }
    }
    setSelectedModel(finalModel)
    setStep("deploy-confirm")
  }

  // ============================================================================
  // Deploy
  // ============================================================================

  const handleDeploy = async (shouldDeploy: boolean) => {
    if (!shouldDeploy) {
      // Skip deploy → go straight to save (no test possible without deployment)
      await saveConfig()
      return
    }

    setStep("deploying")
    const headers = getAuthHeaders()
    const result = await deploySnowFlowLLMAPI({
      instanceUrl: instance(),
      headers,
      restMessage: selectedEndpoint()?.name,
      httpMethod: selectedMethod(),
      defaultModel: selectedModel()?.id,
      midServer: selectedMidServer(),
    })

    if (result.success) {
      setGatewayDeployed(true)
      setApiBaseUri(result.baseUri || "")
      toast.show({ variant: "info", message: "Serac LLM API deployed successfully!", duration: 3000 })
    } else {
      toast.show({ variant: "error", message: `Deployment failed: ${result.error}`, duration: 5000 })
    }
    setStep("test-confirm")
  }

  // ============================================================================
  // Connectivity test
  // ============================================================================

  const handleTest = async (shouldTest: boolean) => {
    if (!shouldTest) {
      await saveConfig()
      return
    }

    setStep("testing")
    const headers = getAuthHeaders()
    const result = await testSnowFlowLLMChat({
      instanceUrl: instance(),
      headers,
      restMessage: selectedEndpoint()?.name || "",
      httpMethod: selectedMethod(),
      model: selectedModel()?.id,
      apiBaseUri: apiBaseUri(),
    })

    if (result.success) {
      setConnectivityTested(true)
      setTestResponse(result.response || "")
      toast.show({ variant: "info", message: "LLM chat test passed!", duration: 3000 })
    } else {
      toast.show({ variant: "error", message: `Test failed: ${result.error}`, duration: 5000 })
    }

    await saveConfig()
  }

  // ============================================================================
  // Save configuration (complete config structure + auth token + model alias)
  // ============================================================================

  const saveConfig = async () => {
    setStep("saving")
    try {
      const { Config } = await import("@/config/config")
      const { Auth } = await import("@/auth")

      const model = selectedModel()
      const modelId = model?.id || manualModel()
      const modelName = model?.name || modelId
      const effectiveContextWindow = model?.contextWindow || 32000
      const effectiveMaxTokens = model?.maxTokens || 4096
      const endpoint = selectedEndpoint()
      const routeLabel = selectedMidServer() ? `via MID Server ${selectedMidServer()}` : "via ServiceNow"

      // Create friendly alias
      const modelAlias = createModelAlias(modelId)
      const useAlias = modelAlias !== modelId.toLowerCase()

      // Build the baseURL using actual API base URI
      const effectiveBaseUri = apiBaseUri() ? `${apiBaseUri()}/llm` : "/api/snow_flow/llm"
      const baseURL = manualUrl() || `${instance()}${effectiveBaseUri}`

      // Build models config with alias + full ID
      const modelsConfig: Record<string, any> = {}
      if (useAlias) {
        modelsConfig[modelAlias] = {
          id: modelId,
          name: `${modelId} (${routeLabel})`,
          tool_call: true,
          temperature: true,
          reasoning: false,
          attachment: false,
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: effectiveContextWindow, output: effectiveMaxTokens },
          cost: { input: 0, output: 0 },
        }
      }
      modelsConfig[modelId] = {
        name: `${modelId} (${routeLabel})`,
        tool_call: true,
        temperature: true,
        reasoning: false,
        attachment: false,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: effectiveContextWindow, output: effectiveMaxTokens },
        cost: { input: 0, output: 0 },
      }

      // Save provider config with full options (matching old config structure)
      await Config.update({
        provider: {
          "servicenow-llm": {
            npm: "@ai-sdk/openai-compatible",
            name: "ServiceNow MID Server LLM",
            api: baseURL,
            models: modelsConfig,
            options: {
              baseURL,
              timeout: 180000,
              restMessage: endpoint?.name || "",
              httpMethod: selectedMethod(),
              midServer: selectedMidServer(),
              defaultModel: modelId,
              gatewayDeployed: gatewayDeployed(),
              connectivityTested: connectivityTested(),
            },
          },
        },
        // Set as default model
        model: useAlias ? `servicenow-llm/${modelAlias}` : `servicenow-llm/${modelId}`,
      } as any)

      // Save ServiceNow access token as API key for servicenow-llm provider
      // This allows @ai-sdk/openai-compatible to authenticate with ServiceNow
      if (authToken()) {
        await Auth.set("servicenow-llm", {
          type: "api",
          key: authToken(),
        })
      }

      const displayModel = useAlias ? `servicenow-llm/${modelAlias}` : `servicenow-llm/${modelId}`
      toast.show({
        variant: "info",
        message: `MID Server LLM configured: ${displayModel}`,
        duration: 5000,
      })
      dialog.clear()
    } catch (e) {
      toast.show({
        variant: "error",
        message: e instanceof Error ? e.message : "Failed to save configuration",
        duration: 5000,
      })
      setStep("manual-url")
      setTimeout(() => manualUrlInput?.focus(), 10)
    }
  }

  // ============================================================================
  // Manual input handlers
  // ============================================================================

  const handleManualUrlSubmit = () => {
    const url = manualUrlInput.plainText.trim()
    if (!url) {
      toast.show({ variant: "error", message: "Please enter a base URL" })
      return
    }
    setManualUrl(url)
    setStep("manual-model")
    setTimeout(() => manualModelInput?.focus(), 10)
  }

  const handleManualModelSubmit = async () => {
    const modelId = manualModelInput.plainText.trim()
    if (!modelId) {
      toast.show({ variant: "error", message: "Please enter a model ID" })
      return
    }
    setManualModel(modelId)

    // Try models.dev lookup for context window
    const lookup = await lookupModelInModelsDev(modelId)
    const contextWindow = lookup.found ? lookup.contextWindow : undefined
    const maxTokens = lookup.found ? lookup.maxTokens : undefined
    if (lookup.found) {
      toast.show({
        variant: "info",
        message: `Found in models.dev: ${lookup.matchedModel} (${formatContextWindow(lookup.contextWindow)})`,
        duration: 3000,
      })
    }

    setSelectedModel({
      id: modelId,
      name: modelId,
      contextWindow,
      maxTokens,
    })

    // Skip deploy/test for manual mode, go straight to save
    await saveConfig()
  }

  // ============================================================================
  // Options builders for DialogSelect
  // ============================================================================

  const endpointOptions = (): DialogSelectOption<string>[] =>
    endpoints().map((ep) => ({
      title: ep.name,
      value: ep.sysId,
      description: ep.midServer ? `MID: ${ep.midServer}` : ep.endpoint || ep.description,
      category: "REST Messages",
      footer: ep.methods.length > 0 ? `${ep.methods.length} method(s)` : undefined,
      onSelect: () => handleEndpointSelect(ep),
    }))

  const methodOptions = (): DialogSelectOption<string>[] => {
    const ep = selectedEndpoint()
    if (!ep) return []
    return ep.methods.map((m) => ({
      title: m.name,
      value: m.name,
      description: m.httpMethod,
      category: "HTTP Methods",
      onSelect: () => handleMethodSelect(m.name),
    }))
  }

  const modelOptions = (): DialogSelectOption<string>[] =>
    models().map((m) => ({
      title: m.name || m.id,
      value: m.id,
      description: m.contextWindow ? formatContextWindow(m.contextWindow) : undefined,
      category: "Models",
      onSelect: () => handleModelSelect(m),
    }))

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          ServiceNow LLM (MID Server)
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      {/* Check auth */}
      <Show when={step() === "check-auth"}>
        <box gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            Checking ServiceNow credentials...
          </text>
          <text fg={theme.textMuted}>Verifying OAuth or Basic Auth is configured</text>
        </box>
      </Show>

      {/* Discovering */}
      <Show when={step() === "discovering"}>
        <box gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            Discovering LLM endpoints...
          </text>
          <text fg={theme.textMuted}>Instance: {instance()}</text>
          <text fg={theme.textMuted}>Searching for MID Servers, REST Messages, and models</text>
        </box>
      </Show>

      {/* Select REST Message endpoint */}
      <Show when={step() === "select-endpoint"}>
        <DialogSelect
          title="Select LLM REST Message"
          options={[
            ...endpointOptions(),
            {
              title: "Enter manually",
              value: "__manual__",
              description: "Type a custom base URL",
              category: "Other",
              onSelect: () => {
                setStep("manual-url")
                setTimeout(() => manualUrlInput?.focus(), 10)
              },
            },
          ]}
        />
      </Show>

      {/* Select HTTP Method */}
      <Show when={step() === "select-method"}>
        <DialogSelect title="Select HTTP Method for chat completions" options={methodOptions()} />
      </Show>

      {/* Select Model */}
      <Show when={step() === "select-model"}>
        <DialogSelect
          title="Select Model"
          options={[
            ...modelOptions(),
            {
              title: "Enter manually",
              value: "__manual__",
              description: "Type a custom model ID",
              category: "Other",
              onSelect: async () => {
                setStep("manual-model")
                setTimeout(() => manualModelInput?.focus(), 10)
              },
            },
          ]}
        />
      </Show>

      {/* Deploy confirmation */}
      <Show when={step() === "deploy-confirm"}>
        <box gap={1}>
          <text fg={theme.text}>Selected: {selectedModel()?.name || selectedModel()?.id}</text>
          <Show when={selectedModel()?.contextWindow}>
            <text fg={theme.textMuted}>
              Context: {selectedModel()!.contextWindow!.toLocaleString()} tokens | Max output:{" "}
              {(selectedModel()!.maxTokens || 4096).toLocaleString()} tokens
            </text>
          </Show>
          <box paddingTop={1}>
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              Deploy Serac LLM API to ServiceNow?
            </text>
            <text fg={theme.textMuted}>This creates a Scripted REST API with LLM endpoints on your instance</text>
          </box>
          <Show when={selectedMidServer()}>
            <text fg={theme.warning}>
              Forcing via MID Server {selectedMidServer()} routes calls through the slower ECC queue and lifts the
              instance-wide 30s outbound REST cap.
            </text>
          </Show>
          <box paddingTop={1} flexDirection="row" gap={3}>
            <text fg={theme.text}>[Y] Yes, deploy</text>
            <text fg={theme.textMuted}>[N] Skip deployment</text>
          </box>
        </box>
      </Show>

      {/* Deploying */}
      <Show when={step() === "deploying"}>
        <box gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            Deploying Serac LLM API...
          </text>
          <text fg={theme.textMuted}>Creating Script Include and REST Resources on {instance()}</text>
        </box>
      </Show>

      {/* Test confirmation (only shown after successful deployment) */}
      <Show when={step() === "test-confirm"}>
        <box gap={1}>
          <text fg={theme.success}>API deployed successfully!</text>
          <box paddingTop={1}>
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              Test LLM chat through MID Server?
            </text>
            <text fg={theme.textMuted}>Sends a test message to verify the full chain works</text>
          </box>
          <box paddingTop={1} flexDirection="row" gap={3}>
            <text fg={theme.text}>[Y] Yes, test</text>
            <text fg={theme.textMuted}>[N] Skip and save</text>
          </box>
        </box>
      </Show>

      {/* Testing */}
      <Show when={step() === "testing"}>
        <box gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            Testing LLM chat via MID Server...
          </text>
          <text fg={theme.textMuted}>This may take up to 3 minutes for MID Server ECC Queue processing</text>
        </box>
      </Show>

      {/* Manual URL */}
      <Show when={step() === "manual-url"}>
        <box gap={1}>
          <text fg={theme.textMuted}>Enter the base URL for the LLM endpoint</text>
          <textarea
            ref={(val: TextareaRenderable) => (manualUrlInput = val)}
            height={3}
            initialValue={manualUrl() || `${instance()}/api/snow_flow/llm`}
            placeholder="https://instance.service-now.com/api/snow_flow/llm"
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={handleManualUrlSubmit}
          />
          <text fg={theme.textMuted}>Instance: {instance()}</text>
          <text fg={theme.textMuted}>Press Enter to continue</text>
        </box>
      </Show>

      {/* Manual model */}
      <Show when={step() === "manual-model"}>
        <box gap={1}>
          <text fg={theme.textMuted}>Enter the model ID (e.g., qwen3-1.7b, llama3-8b, Qwen/Qwen3-1.7B)</text>
          <textarea
            ref={(val: TextareaRenderable) => (manualModelInput = val)}
            height={3}
            initialValue={manualModel()}
            placeholder="Qwen/Qwen3-1.7B"
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={handleManualModelSubmit}
          />
          <Show when={selectedEndpoint()}>
            <text fg={theme.textMuted}>Endpoint: {selectedEndpoint()!.name}</text>
          </Show>
          <text fg={theme.textMuted}>Press Enter to save</text>
        </box>
      </Show>

      {/* Saving */}
      <Show when={step() === "saving"}>
        <box gap={1}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD}>
            Saving configuration...
          </text>
          <text fg={theme.textMuted}>Writing provider config and auth token</text>
        </box>
      </Show>
    </box>
  )
}
