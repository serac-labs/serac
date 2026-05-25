import z from "zod"
import fuzzysort from "fuzzysort"
import { Config } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Log } from "../util/log"
import { BunProc } from "../bun"
import { Plugin } from "../plugin"
import { ModelsDev } from "./models"
import { NamedError } from "@opencode-ai/util/error"
import { Auth } from "../auth"
import { PortalSync } from "../auth/portal-sync"
import { Env } from "../env"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"

// Direct imports for bundled providers
import { createAmazonBedrock, type AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter, type LanguageModelV2 } from "@openrouter/ai-sdk-provider"
import { createOpenaiCompatible as createGitHubCopilotOpenAICompatible } from "./sdk/openai-compatible/src"
import { createXai } from "@ai-sdk/xai"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createGateway } from "@ai-sdk/gateway"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createVercel } from "@ai-sdk/vercel"
import { createGitLab } from "@gitlab/gitlab-ai-provider"
import { ProviderTransform } from "./transform"

const DEFAULT_CHUNK_TIMEOUT = 300_000

export namespace Provider {
  const log = Log.create({ service: "provider" })

  function isGpt5OrLater(modelID: string): boolean {
    const match = /^gpt-(\d+)/.exec(modelID)
    if (!match) {
      return false
    }
    return Number(match[1]) >= 5
  }

  function shouldUseCopilotResponsesApi(modelID: string): boolean {
    return isGpt5OrLater(modelID) && !modelID.startsWith("gpt-5-mini")
  }

  function googleVertexVars(options: Record<string, any>) {
    const project =
      options["project"] ?? Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
    const location =
      options["location"] ?? Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "us-central1"
    const endpoint = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`

    return {
      GOOGLE_VERTEX_PROJECT: project,
      GOOGLE_VERTEX_LOCATION: location,
      GOOGLE_VERTEX_ENDPOINT: endpoint,
    }
  }

  function loadBaseURL(model: Model, options: Record<string, any>) {
    const raw = options["baseURL"] ?? model.api.url
    if (typeof raw !== "string") return raw
    const vars = model.providerID === "google-vertex" ? googleVertexVars(options) : undefined
    return raw.replace(/\$\{([^}]+)\}/g, (match, key) => {
      const val = Env.get(String(key)) ?? vars?.[String(key) as keyof typeof vars]
      return val ?? match
    })
  }

  function wrapSSE(res: Response, ms: number, ctl: AbortController) {
    if (typeof ms !== "number" || ms <= 0) return res
    if (!res.body) return res
    if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

    const reader = res.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
          const id = setTimeout(() => {
            const err = new Error("SSE read timed out")
            ctl.abort(err)
            void reader.cancel(err)
            reject(err)
          }, ms)

          reader.read().then(
            (part) => {
              clearTimeout(id)
              resolve(part)
            },
            (err) => {
              clearTimeout(id)
              reject(err)
            },
          )
        })

        if (part.done) {
          ctrl.close()
          return
        }

        ctrl.enqueue(part.value)
      },
      async cancel(reason) {
        ctl.abort(reason)
        await reader.cancel(reason)
      },
    })

    return new Response(body, {
      headers: new Headers(res.headers),
      status: res.status,
      statusText: res.statusText,
    })
  }

  const BUNDLED_PROVIDERS: Record<string, (options: any) => SDK> = {
    "@ai-sdk/amazon-bedrock": createAmazonBedrock,
    "@ai-sdk/anthropic": createAnthropic,
    "@ai-sdk/azure": createAzure,
    "@ai-sdk/google": createGoogleGenerativeAI,
    "@ai-sdk/google-vertex": createVertex,
    "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
    "@ai-sdk/openai": createOpenAI,
    "@ai-sdk/openai-compatible": createOpenAICompatible,
    "@openrouter/ai-sdk-provider": createOpenRouter,
    "@ai-sdk/xai": createXai,
    "@ai-sdk/mistral": createMistral,
    "@ai-sdk/groq": createGroq,
    "@ai-sdk/deepinfra": createDeepInfra,
    "@ai-sdk/cerebras": createCerebras,
    "@ai-sdk/cohere": createCohere,
    "@ai-sdk/gateway": createGateway,
    "@ai-sdk/togetherai": createTogetherAI,
    "@ai-sdk/perplexity": createPerplexity,
    "@ai-sdk/vercel": createVercel,
    "@gitlab/gitlab-ai-provider": createGitLab,
    // @ts-ignore (TODO: kill this code so we dont have to maintain it)
    "@ai-sdk/github-copilot": createGitHubCopilotOpenAICompatible,
  }

  type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
  type CustomLoader = (provider: Info) => Promise<{
    autoload: boolean
    getModel?: CustomModelLoader
    options?: Record<string, any>
  }>

  function createSSEStream(
    content: string,
    model: string,
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  ): string[] {
    const id = `chatcmpl-${crypto.randomUUID()}`
    const chunks: string[] = []

    // Role chunk
    chunks.push(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      })}\n\n`,
    )

    // Content chunks (~10 chars per chunk for smooth streaming
    const words = content.split(/(\s+)/)
    let current = ""
    for (const word of words) {
      current += word
      if (current.length >= 10 || word.includes("\n")) {
        chunks.push(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: { content: current }, finish_reason: null }],
          })}\n\n`,
        )
        current = ""
      }
    }
    if (current) {
      chunks.push(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: { content: current }, finish_reason: null }],
        })}\n\n`,
      )
    }

    // Finish chunk
    chunks.push(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })}\n\n`,
    )

    chunks.push("data: [DONE]\n\n")
    return chunks
  }

  const CUSTOM_LOADERS: Record<string, CustomLoader> = {
    async anthropic() {
      return {
        autoload: false,
        options: {
          headers: {
            "anthropic-beta":
              "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        },
      }
    },
    async opencode(input) {
      const hasKey = await (async () => {
        const env = Env.all()
        if (input.env.some((item) => env[item])) return true
        if (await Auth.get(input.id)) return true
        const config = await Config.get()
        if (config.provider?.["opencode"]?.options?.apiKey) return true
        return false
      })()

      if (!hasKey) {
        for (const [key, value] of Object.entries(input.models)) {
          if (value.cost.input === 0) continue
          delete input.models[key]
        }
      }

      return {
        autoload: Object.keys(input.models).length > 0,
        options: hasKey ? {} : { apiKey: "public" },
      }
    },
    openai: async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: {},
      }
    },
    "github-copilot": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          if (sdk.responses === undefined && sdk.chat === undefined) return sdk.languageModel(modelID)
          return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
        },
        options: {},
      }
    },
    "github-copilot-enterprise": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          if (sdk.responses === undefined && sdk.chat === undefined) return sdk.languageModel(modelID)
          return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
        },
        options: {},
      }
    },
    azure: async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {},
      }
    },
    "azure-cognitive-services": async () => {
      const resourceName = Env.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {
          baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
        },
      }
    },
    "amazon-bedrock": async () => {
      const config = await Config.get()
      const providerConfig = config.provider?.["amazon-bedrock"]

      const auth = await Auth.get("amazon-bedrock")

      // Region precedence: 1) config file, 2) env var, 3) default
      const configRegion = providerConfig?.options?.region
      const envRegion = Env.get("AWS_REGION")
      const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

      // Profile: config file takes precedence over env var
      const configProfile = providerConfig?.options?.profile
      const envProfile = Env.get("AWS_PROFILE")
      const profile = configProfile ?? envProfile

      const awsAccessKeyId = Env.get("AWS_ACCESS_KEY_ID")

      const awsBearerToken = iife(() => {
        const envToken = Env.get("AWS_BEARER_TOKEN_BEDROCK")
        if (envToken) return envToken
        if (auth?.type === "api") {
          Env.set("AWS_BEARER_TOKEN_BEDROCK", auth.key)
          return auth.key
        }
        return undefined
      })

      const awsWebIdentityTokenFile = Env.get("AWS_WEB_IDENTITY_TOKEN_FILE")

      if (!profile && !awsAccessKeyId && !awsBearerToken && !awsWebIdentityTokenFile) return { autoload: false }

      const providerOptions: AmazonBedrockProviderSettings = {
        region: defaultRegion,
      }

      // Only use credential chain if no bearer token exists
      // Bearer token takes precedence over credential chain (profiles, access keys, IAM roles, web identity tokens)
      if (!awsBearerToken) {
        const { fromNodeProviderChain } = await import(await BunProc.install("@aws-sdk/credential-providers"))

        // Build credential provider options (only pass profile if specified)
        const credentialProviderOptions = profile ? { profile } : {}

        providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
      }

      // Add custom endpoint if specified (endpoint takes precedence over baseURL)
      const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
      if (endpoint) {
        providerOptions.baseURL = endpoint
      }

      return {
        autoload: true,
        options: providerOptions,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          // Skip region prefixing if model already has a cross-region inference profile prefix
          if (modelID.startsWith("global.") || modelID.startsWith("jp.")) {
            return sdk.languageModel(modelID)
          }

          // Region resolution precedence (highest to lowest):
          // 1. options.region from opencode.json provider config
          // 2. defaultRegion from AWS_REGION environment variable
          // 3. Default "us-east-1" (baked into defaultRegion)
          const region = options?.region ?? defaultRegion

          let regionPrefix = region.split("-")[0]

          switch (regionPrefix) {
            case "us": {
              const modelRequiresPrefix = [
                "nova-micro",
                "nova-lite",
                "nova-pro",
                "nova-premier",
                "nova-2",
                "claude",
                "deepseek",
              ].some((m) => modelID.includes(m))
              const isGovCloud = region.startsWith("us-gov")
              if (modelRequiresPrefix && !isGovCloud) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "eu": {
              const regionRequiresPrefix = [
                "eu-west-1",
                "eu-west-2",
                "eu-west-3",
                "eu-north-1",
                "eu-central-1",
                "eu-south-1",
                "eu-south-2",
              ].some((r) => region.includes(r))
              const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
                modelID.includes(m),
              )
              if (regionRequiresPrefix && modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "ap": {
              const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
              const isTokyoRegion = region === "ap-northeast-1"
              if (
                isAustraliaRegion &&
                ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
              ) {
                regionPrefix = "au"
                modelID = `${regionPrefix}.${modelID}`
              } else if (isTokyoRegion) {
                // Tokyo region uses jp. prefix for cross-region inference
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "jp"
                  modelID = `${regionPrefix}.${modelID}`
                }
              } else {
                // Other APAC regions use apac. prefix
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "apac"
                  modelID = `${regionPrefix}.${modelID}`
                }
              }
              break
            }
          }

          return sdk.languageModel(modelID)
        },
      }
    },
    openrouter: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://serac.build/",
            "X-Title": "snow-flow",
          },
        },
      }
    },
    vercel: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "http-referer": "https://serac.build/",
            "x-title": "snow-flow",
          },
        },
      }
    },
    "google-vertex": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "us-east5"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "google-vertex-anthropic": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "global"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "sap-ai-core": async () => {
      const auth = await Auth.get("sap-ai-core")
      const envServiceKey = iife(() => {
        const envAICoreServiceKey = Env.get("AICORE_SERVICE_KEY")
        if (envAICoreServiceKey) return envAICoreServiceKey
        if (auth?.type === "api") {
          Env.set("AICORE_SERVICE_KEY", auth.key)
          return auth.key
        }
        return undefined
      })
      const deploymentId = Env.get("AICORE_DEPLOYMENT_ID")
      const resourceGroup = Env.get("AICORE_RESOURCE_GROUP")

      return {
        autoload: !!envServiceKey,
        options: envServiceKey ? { deploymentId, resourceGroup } : {},
        async getModel(sdk: any, modelID: string) {
          return sdk(modelID)
        },
      }
    },
    zenmux: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://serac.build/",
            "X-Title": "snow-flow",
          },
        },
      }
    },
    gitlab: async (input) => {
      const instanceUrl = Env.get("GITLAB_INSTANCE_URL") || "https://gitlab.com"

      const auth = await Auth.get(input.id)
      const apiKey = await (async () => {
        if (auth?.type === "oauth") return auth.access
        if (auth?.type === "api") return auth.key
        return Env.get("GITLAB_TOKEN")
      })()

      const config = await Config.get()
      const providerConfig = config.provider?.["gitlab"]

      return {
        autoload: !!apiKey,
        options: {
          instanceUrl,
          apiKey,
          featureFlags: {
            duo_agent_platform_agentic_chat: true,
            duo_agent_platform: true,
            ...(providerConfig?.options?.featureFlags || {}),
          },
        },
        async getModel(sdk: ReturnType<typeof createGitLab>, modelID: string) {
          return sdk.agenticChat(modelID, {
            featureFlags: {
              duo_agent_platform_agentic_chat: true,
              duo_agent_platform: true,
              ...(providerConfig?.options?.featureFlags || {}),
            },
          })
        },
      }
    },
    "cloudflare-ai-gateway": async (input) => {
      const accountId = Env.get("CLOUDFLARE_ACCOUNT_ID")
      const gateway = Env.get("CLOUDFLARE_GATEWAY_ID")

      if (!accountId || !gateway) return { autoload: false }

      // Get API token from env or auth prompt
      const apiToken = await (async () => {
        const envToken = Env.get("CLOUDFLARE_API_TOKEN")
        if (envToken) return envToken
        const auth = await Auth.get(input.id)
        if (auth?.type === "api") return auth.key
        return undefined
      })()

      return {
        autoload: true,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.languageModel(modelID)
        },
        options: {
          baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/compat`,
          headers: {
            // Cloudflare AI Gateway uses cf-aig-authorization for authenticated gateways
            // This enables Unified Billing where Cloudflare handles upstream provider auth
            ...(apiToken ? { "cf-aig-authorization": `Bearer ${apiToken}` } : {}),
            "HTTP-Referer": "https://serac.build/",
            "X-Title": "snow-flow",
          },
          // Custom fetch to handle parameter transformation and auth
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers)
            // Strip Authorization header - AI Gateway uses cf-aig-authorization instead
            headers.delete("Authorization")

            // Transform max_tokens to max_completion_tokens for newer models
            if (init?.body && init.method === "POST") {
              try {
                const body = JSON.parse(init.body as string)
                if (body.max_tokens !== undefined && !body.max_completion_tokens) {
                  body.max_completion_tokens = body.max_tokens
                  delete body.max_tokens
                  init = { ...init, body: JSON.stringify(body) }
                }
              } catch (e) {
                // If body parsing fails, continue with original request
              }
            }

            return fetch(input, { ...init, headers })
          },
        },
      }
    },
    ollama: async (input) => {
      const host = (Env.get("OLLAMA_HOST") || "http://localhost:11434").replace(/\/+$/, "")
      try {
        const response = await fetch(`${host}/api/tags`, {
          signal: AbortSignal.timeout(2000),
        })
        if (!response.ok) return { autoload: false }
        const data = (await response.json()) as { models?: Array<{ name: string; details?: { parameter_size?: string; family?: string } }> }
        if (!data.models?.length) return { autoload: false }

        // Check tool support per model via /api/show (parallel, best-effort)
        const toolSupport = new Map<string, boolean>()
        await Promise.all(
          data.models.map(async (m) => {
            try {
              const res = await fetch(`${host}/api/show`, {
                method: "POST",
                body: JSON.stringify({ name: m.name }),
                signal: AbortSignal.timeout(2000),
              })
              if (!res.ok) return
              const info = (await res.json()) as { template?: string }
              toolSupport.set(m.name, info.template?.includes(".Tools") ?? false)
            } catch {
              // assume no tool support if check fails
            }
          }),
        )

        for (const model of data.models) {
          if (input.models[model.name]) continue
          input.models[model.name] = fromModelsDevModel(
            { id: "ollama", name: "Ollama", npm: "@ai-sdk/openai-compatible", api: `${host}/v1`, env: ["OLLAMA_HOST"], models: {} },
            {
              id: model.name,
              name: model.name,
              family: model.details?.family ?? model.name.split(":")[0],
              attachment: false,
              reasoning: false,
              tool_call: toolSupport.get(model.name) ?? false,
              temperature: true,
              release_date: "2024-01-01",
              modalities: { input: ["text"], output: ["text"] },
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
              limit: { context: 131072, output: 32768 },
              options: {},
            },
          )
        }
        return {
          autoload: true,
          options: { baseURL: `${host}/v1`, apiKey: "ollama" },
        }
      } catch {
        return { autoload: false }
      }
    },
    lmstudio: async (input) => {
      const host = (Env.get("LMSTUDIO_HOST") || "http://127.0.0.1:1234").replace(/\/+$/, "")
      try {
        const response = await fetch(`${host}/v1/models`, {
          signal: AbortSignal.timeout(2000),
        })
        if (!response.ok) return { autoload: false }
        const data = (await response.json()) as { data?: Array<{ id: string }> }
        if (!data.data?.length) return { autoload: false }

        for (const model of data.data) {
          if (input.models[model.id]) continue
          input.models[model.id] = fromModelsDevModel(
            { id: "lmstudio", name: "LM Studio", npm: "@ai-sdk/openai-compatible", api: `${host}/v1`, env: ["LMSTUDIO_HOST"], models: {} },
            {
              id: model.id,
              name: model.id,
              family: model.id.split("/").pop()?.split("-")[0] ?? model.id,
              attachment: false,
              reasoning: false,
              tool_call: true,
              temperature: true,
              release_date: "2024-01-01",
              modalities: { input: ["text"], output: ["text"] },
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
              limit: { context: 131072, output: 32768 },
              options: {},
            },
          )
        }
        return {
          autoload: true,
          options: { baseURL: `${host}/v1`, apiKey: "lm-studio" },
        }
      } catch {
        return { autoload: false }
      }
    },
    cerebras: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": "opencode",
          },
        },
      }
    },
    "servicenow-llm": async (input) => {
      let snAuth = await Auth.get("servicenow")

      // If no local ServiceNow auth, try fetching from enterprise portal
      if (!snAuth) {
        const entAuth = await Auth.get("enterprise")
        if (entAuth?.type === "enterprise" && entAuth.token && entAuth.enterpriseUrl) {
          try {
            const response = await fetch(`${entAuth.enterpriseUrl}/api/user-credentials/servicenow/default`, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${entAuth.token}`,
                Accept: "application/json",
              },
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
              }
            }
          } catch {
            // Enterprise portal fetch failed
          }
        }
      }

      if (!snAuth) return { autoload: false }

      let apiKey: string | undefined
      let baseURL: string | undefined

      if (snAuth.type === "servicenow-oauth" && snAuth.accessToken) {
        apiKey = snAuth.accessToken
        baseURL = `${snAuth.instance}/api/snow_flow/llm`
      } else if (snAuth.type === "servicenow-basic") {
        apiKey = Buffer.from(`${snAuth.username}:${snAuth.password}`).toString("base64")
        baseURL = `${snAuth.instance}/api/snow_flow/llm`
      }

      if (!apiKey || !baseURL) return { autoload: false }

      return {
        autoload: !!Object.keys(input.models).length,
        options: {
          apiKey,
          baseURL,
          timeout: 180000,
        },
      }
    },
  }

  export const Model = z
    .object({
      id: z.string(),
      providerID: z.string(),
      api: z.object({
        id: z.string(),
        url: z.string(),
        npm: z.string(),
      }),
      name: z.string(),
      family: z.string().optional(),
      capabilities: z.object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        output: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        interleaved: z.union([
          z.boolean(),
          z.object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          }),
        ]),
      }),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api"]),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    const m: Model = {
      id: model.id,
      providerID: provider.id,
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: provider.api!,
        npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
      },
      status: model.status ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
          write: model.cost?.cache_write ?? 0,
        },
        experimentalOver200K: model.cost?.context_over_200k
          ? {
              cache: {
                read: model.cost.context_over_200k.cache_read ?? 0,
                write: model.cost.context_over_200k.cache_write ?? 0,
              },
              input: model.cost.context_over_200k.input,
              output: model.cost.context_over_200k.output,
            }
          : undefined,
      },
      limit: {
        context: model.limit.context,
        input: model.limit.input,
        output: model.limit.output,
      },
      capabilities: {
        temperature: model.temperature,
        reasoning: model.reasoning,
        attachment: model.attachment,
        toolcall: model.tool_call,
        input: {
          text: model.modalities?.input?.includes("text") ?? false,
          audio: model.modalities?.input?.includes("audio") ?? false,
          image: model.modalities?.input?.includes("image") ?? false,
          video: model.modalities?.input?.includes("video") ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? false,
          audio: model.modalities?.output?.includes("audio") ?? false,
          image: model.modalities?.output?.includes("image") ?? false,
          video: model.modalities?.output?.includes("video") ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? false,
        },
        interleaved: model.interleaved ?? false,
      },
      release_date: model.release_date,
      variants: {},
    }

    m.variants = mapValues(ProviderTransform.variants(m), (v) => v)

    return m
  }

  export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
    return {
      id: provider.id,
      source: "custom",
      name: provider.name,
      env: provider.env ?? [],
      options: {},
      models: mapValues(provider.models, (model) => fromModelsDevModel(provider, model)),
    }
  }

  const state = Instance.state(async () => {
    using _ = log.time("state")
    const config = await Config.get()
    const modelsDev = await ModelsDev.get()
    const database = mapValues(modelsDev, fromModelsDevProvider)

    // Ensure local providers exist in the database so CUSTOM_LOADERS can discover them
    for (const local of [
      { id: "ollama", name: "Ollama", npm: "@ai-sdk/openai-compatible", api: "http://localhost:11434/v1", env: ["OLLAMA_HOST"] },
      { id: "lmstudio", name: "LM Studio", npm: "@ai-sdk/openai-compatible", api: "http://127.0.0.1:1234/v1", env: ["LMSTUDIO_HOST"] },
    ] as const) {
      if (!database[local.id]) {
        database[local.id] = fromModelsDevProvider({ id: local.id, name: local.name, npm: local.npm, api: local.api, env: [...local.env], models: {} })
      }
    }

    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : null

    function isProviderAllowed(providerID: string): boolean {
      if (enabled && !enabled.has(providerID)) return false
      if (disabled.has(providerID)) return false
      return true
    }

    const providers: { [providerID: string]: Info } = {}
    const languages = new Map<string, LanguageModelV2>()
    const modelLoaders: {
      [providerID: string]: CustomModelLoader
    } = {}
    const sdk = new Map<number, SDK>()

    log.info("init")

    const configProviders = Object.entries(config.provider ?? {})

    // Add GitHub Copilot Enterprise provider that inherits from GitHub Copilot
    if (database["github-copilot"]) {
      const githubCopilot = database["github-copilot"]
      database["github-copilot-enterprise"] = {
        ...githubCopilot,
        id: "github-copilot-enterprise",
        name: "GitHub Copilot Enterprise",
        models: mapValues(githubCopilot.models, (model) => ({
          ...model,
          providerID: "github-copilot-enterprise",
        })),
      }
    }

    function mergeProvider(providerID: string, provider: Partial<Info>) {
      const existing = providers[providerID]
      if (existing) {
        // @ts-expect-error
        providers[providerID] = mergeDeep(existing, provider)
        return
      }
      const match = database[providerID]
      if (!match) return
      // @ts-expect-error
      providers[providerID] = mergeDeep(match, provider)
    }

    // extend database from config
    for (const [providerID, provider] of configProviders) {
      const existing = database[providerID]
      const parsed: Info = {
        id: providerID,
        name: provider.name ?? existing?.name ?? providerID,
        env: provider.env ?? existing?.env ?? [],
        options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
        source: "config",
        models: existing?.models ?? {},
      }

      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        const existingModel = parsed.models[model.id ?? modelID]
        const name = iife(() => {
          if (model.name) return model.name
          if (model.id && model.id !== modelID) return modelID
          return existingModel?.name ?? modelID
        })
        const parsedModel: Model = {
          id: modelID,
          api: {
            id: model.id ?? existingModel?.api.id ?? modelID,
            npm:
              model.provider?.npm ??
              provider.npm ??
              existingModel?.api.npm ??
              modelsDev[providerID]?.npm ??
              "@ai-sdk/openai-compatible",
            url: provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
          },
          status: model.status ?? existingModel?.status ?? "active",
          name,
          providerID,
          capabilities: {
            temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
            reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
            attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
            toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
            input: {
              text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
              audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
              image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
              video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
              pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
            },
            output: {
              text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
              audio: model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
              image: model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
              video: model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
              pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
            },
            interleaved: model.interleaved ?? false,
          },
          cost: {
            input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
            output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
            cache: {
              read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
              write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
            },
          },
          options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
          limit: {
            context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
            output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
          },
          headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
          family: model.family ?? existingModel?.family ?? "",
          release_date: model.release_date ?? existingModel?.release_date ?? "",
          variants: {},
        }
        const merged = mergeDeep(ProviderTransform.variants(parsedModel), model.variants ?? {})
        parsedModel.variants = mapValues(
          pickBy(merged, (v) => !v.disabled),
          (v) => omit(v, ["disabled"]),
        )
        parsed.models[modelID] = parsedModel
      }
      database[providerID] = parsed
    }

    // load env
    const env = Env.all()
    for (const [providerID, provider] of Object.entries(database)) {
      if (disabled.has(providerID)) continue
      const apiKey = provider.env.map((item) => env[item]).find(Boolean)
      if (!apiKey) continue
      mergeProvider(providerID, {
        source: "env",
        key: provider.env.length === 1 ? apiKey : undefined,
      })
    }

    // load apikeys
    for (const [providerID, provider] of Object.entries(await Auth.all())) {
      if (disabled.has(providerID)) continue
      if (provider.type === "api") {
        mergeProvider(providerID, {
          source: "api",
          key: provider.key,
        })
      }
    }

    for (const plugin of await Plugin.list()) {
      if (!plugin.auth) continue
      const providerID = plugin.auth.provider
      if (disabled.has(providerID)) continue

      // For github-copilot plugin, check if auth exists for either github-copilot or github-copilot-enterprise
      let hasAuth = false
      const auth = await Auth.get(providerID)
      if (auth) hasAuth = true

      // Special handling for github-copilot: also check for enterprise auth
      if (providerID === "github-copilot" && !hasAuth) {
        const enterpriseAuth = await Auth.get("github-copilot-enterprise")
        if (enterpriseAuth) hasAuth = true
      }

      if (!hasAuth) continue
      if (!plugin.auth.loader) continue

      // Load for the main provider if auth exists
      if (auth) {
        const options = await plugin.auth.loader(() => Auth.get(providerID) as any, database[plugin.auth.provider])
        const opts = options ?? {}
        const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
        mergeProvider(providerID, patch)
      }

      // If this is github-copilot plugin, also register for github-copilot-enterprise if auth exists
      if (providerID === "github-copilot") {
        const enterpriseProviderID = "github-copilot-enterprise"
        if (!disabled.has(enterpriseProviderID)) {
          const enterpriseAuth = await Auth.get(enterpriseProviderID)
          if (enterpriseAuth) {
            const enterpriseOptions = await plugin.auth.loader(
              () => Auth.get(enterpriseProviderID) as any,
              database[enterpriseProviderID],
            )
            const opts = enterpriseOptions ?? {}
            const patch: Partial<Info> = providers[enterpriseProviderID]
              ? { options: opts }
              : { source: "custom", options: opts }
            mergeProvider(enterpriseProviderID, patch)
          }
        }
      }
    }

    for (const [providerID, fn] of Object.entries(CUSTOM_LOADERS)) {
      if (disabled.has(providerID)) continue
      const data = database[providerID]
      if (!data) {
        log.error("Provider does not exist in model list " + providerID)
        continue
      }
      const result = await fn(data)
      if (result && (result.autoload || providers[providerID])) {
        if (result.getModel) modelLoaders[providerID] = result.getModel
        const opts = result.options ?? {}
        const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
        mergeProvider(providerID, patch)
      }
    }

    // load config
    for (const [providerID, provider] of configProviders) {
      const partial: Partial<Info> = { source: "config" }
      if (provider.env) partial.env = provider.env
      if (provider.name) partial.name = provider.name
      if (provider.options) partial.options = provider.options
      mergeProvider(providerID, partial)
    }

    // load enterprise AI provider credentials (in-memory only, never stored locally)
    const entAuth = await Auth.get("enterprise")
    if (entAuth?.type === "enterprise" && entAuth.token && entAuth.enterpriseUrl) {
      try {
        const result = await PortalSync.fetchAiProvidersFromPortal(entAuth.enterpriseUrl, entAuth.token)
        if (result.success && result.providers) {
          for (const p of result.providers) {
            if (!p.apiKey || !p.providerType) continue
            // Only fill in if provider has no key yet (enterprise = lowest priority)
            if (providers[p.providerType]?.key) continue
            mergeProvider(p.providerType, {
              source: "api",
              key: p.apiKey,
              ...(p.endpointUrl ? { options: { baseURL: p.endpointUrl } } : {}),
            })
          }
        }
      } catch {
        // Silent failure — enterprise providers unavailable, local config works as-is
      }
    }

    for (const [providerID, provider] of Object.entries(providers)) {
      if (!isProviderAllowed(providerID)) {
        delete providers[providerID]
        continue
      }

      const configProvider = config.provider?.[providerID]

      for (const [modelID, model] of Object.entries(provider.models)) {
        model.api.id = model.api.id ?? model.id ?? modelID
        if (modelID === "gpt-5-chat-latest" || (providerID === "openrouter" && modelID === "openai/gpt-5-chat"))
          delete provider.models[modelID]
        if (model.status === "alpha" && !Flag.OPENCODE_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
        if (model.status === "deprecated") delete provider.models[modelID]
        if (
          (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
          (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
        )
          delete provider.models[modelID]

        model.variants = mapValues(ProviderTransform.variants(model), (v) => v)

        // Filter out disabled variants from config
        const configVariants = configProvider?.models?.[modelID]?.variants
        if (configVariants && model.variants) {
          const merged = mergeDeep(model.variants, configVariants)
          model.variants = mapValues(
            pickBy(merged, (v) => !v.disabled),
            (v) => omit(v, ["disabled"]),
          )
        }
      }

      if (Object.keys(provider.models).length === 0) {
        delete providers[providerID]
        continue
      }

      log.info("found", { providerID })
    }

    return {
      models: languages,
      providers,
      sdk,
      modelLoaders,
    }
  })

  export async function list() {
    return state().then((state) => state.providers)
  }

  async function getSDK(model: Model) {
    try {
      using _ = log.time("getSDK", {
        providerID: model.providerID,
      })
      const s = await state()
      const provider = s.providers[model.providerID]
      const options = { ...provider.options }

      if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
        options["includeUsage"] = true
      }

      if (!options["baseURL"]) options["baseURL"] = model.api.url
      if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
      if (model.headers)
        options["headers"] = {
          ...options["headers"],
          ...model.headers,
        }

      const key = Bun.hash.xxHash32(JSON.stringify({ npm: model.api.npm, options }))
      const existing = s.sdk.get(key)
      if (existing) return existing

      // ServiceNow LLM: wrap fetch to unwrap MID Server responses and convert to SSE
      // ServiceNow Scripted REST APIs wrap responses in { "result": ... }
      // MID Server calls are async via ECC Queue and can take 30-120+ seconds
      // ServiceNow returns complete JSON but AI SDK expects SSE streaming
      if (model.providerID === "servicenow-llm") {
        const midServerTimeout = options["timeout"] ?? 180000

        options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
          const { signal, ...rest } = init ?? {}

          // Check if this is a streaming request
          let isStreamingRequest = false
          try {
            if (init?.body) {
              const bodyStr = typeof init.body === "string" ? init.body : await new Response(init.body).text()
              const bodyJson = JSON.parse(bodyStr)
              isStreamingRequest = bodyJson.stream === true
            }
          } catch {
            // Ignore parsing errors
          }

          // Combine user signal with MID Server timeout
          const signals: AbortSignal[] = []
          if (signal) signals.push(signal)
          if (midServerTimeout !== false) {
            signals.push(AbortSignal.timeout(midServerTimeout))
          }
          const combined = signals.length > 1 ? AbortSignal.any(signals) : signals.length === 1 ? signals[0] : undefined

          log.info("servicenow-llm fetch", {
            url: typeof input === "string" ? input : input.url,
            timeout: midServerTimeout,
            streaming: isStreamingRequest,
          })

          // Make the request to ServiceNow
          const response = await fetch(input, {
            ...rest,
            signal: combined,
            // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
            timeout: false,
          })

          log.info("servicenow-llm response", {
            status: response.status,
            statusText: response.statusText,
          })

          // Clone the response to read the body
          const cloned = response.clone()
          try {
            const text = await cloned.text()

            log.info("servicenow-llm raw body", {
              length: text.length,
              preview: text.substring(0, 300),
            })

            // Try to parse as JSON
            let body: any
            try {
              body = JSON.parse(text)
            } catch {
              log.warn("servicenow-llm not JSON, returning original response")
              return response
            }

            // Extract content from various response formats
            let content: string | null = null
            let modelName = "unknown"
            let usage: any = null

            // Check for ServiceNow wrapper
            if (body && typeof body === "object" && "result" in body) {
              const unwrapped = body.result

              log.info("servicenow-llm unwrapped", {
                type: typeof unwrapped,
                keys: unwrapped && typeof unwrapped === "object" ? Object.keys(unwrapped) : [],
              })

              // OpenAI format inside wrapper
              if (unwrapped && Array.isArray(unwrapped.choices) && unwrapped.choices[0]?.message?.content) {
                content = unwrapped.choices[0].message.content
                modelName = unwrapped.model || modelName
                usage = unwrapped.usage
                log.info("servicenow-llm: extracted from OpenAI format in wrapper")
              }
              // Custom ServiceNow format
              else if (unwrapped && unwrapped.success === true && typeof unwrapped.response === "string") {
                content = unwrapped.response
                modelName = unwrapped.model || modelName
                usage = unwrapped.usage
                log.info("servicenow-llm: extracted from custom format")
              }
              // Error response
              else if (unwrapped && unwrapped.success === false && unwrapped.error) {
                log.warn("servicenow-llm: ServiceNow error", { error: unwrapped.error })
                return new Response(JSON.stringify({ error: { message: unwrapped.error, type: "servicenow_error" } }), {
                  status: 500,
                  headers: { "content-type": "application/json" },
                })
              }
            }
            // Direct OpenAI format (no wrapper)
            else if (body && Array.isArray(body.choices) && body.choices[0]?.message?.content) {
              content = body.choices[0].message.content
              modelName = body.model || modelName
              usage = body.usage
              log.info("servicenow-llm: extracted from direct OpenAI format")
            }

            // If we extracted content, convert to appropriate format
            if (content !== null) {
              log.info("servicenow-llm: content extracted", {
                contentLength: content.length,
                model: modelName,
                isStreaming: isStreamingRequest,
              })

              if (isStreamingRequest) {
                // Convert to SSE stream
                const sseChunks = createSSEStream(content, modelName, usage)
                const sseBody = sseChunks.join("")
                log.info("servicenow-llm: returning SSE stream", { sseLength: sseBody.length })

                return new Response(sseBody, {
                  status: 200,
                  headers: {
                    "content-type": "text/event-stream",
                    "cache-control": "no-cache",
                    connection: "keep-alive",
                  },
                })
              } else {
                // Non-streaming: return OpenAI JSON format
                const openAIResponse = {
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion",
                  created: Math.floor(Date.now() / 1000),
                  model: modelName,
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content },
                      finish_reason: "stop",
                    },
                  ],
                  usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                }
                return new Response(JSON.stringify(openAIResponse), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                })
              }
            }

            log.warn("servicenow-llm: could not extract content from response", {
              bodyPreview: JSON.stringify(body).substring(0, 300),
            })
          } catch (e) {
            log.warn("servicenow-llm fetch handler error", { error: String(e) })
          }

          return response
        }
      }

      const customFetch = options["fetch"]
      const chunkTimeout = options["chunkTimeout"] || DEFAULT_CHUNK_TIMEOUT
      delete options["chunkTimeout"]

      options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
        // Preserve custom fetch if it exists, wrap it with timeout logic
        const fetchFn = customFetch ?? fetch
        const opts = init ?? {}
        const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
        const signals: AbortSignal[] = []

        if (opts.signal) signals.push(opts.signal)
        if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
        if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false)
          signals.push(AbortSignal.timeout(options["timeout"]))

        const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
        if (combined) opts.signal = combined

        // Strip openai itemId metadata following what codex does
        // Codex uses #[serde(skip_serializing)] on id fields for all item types:
        // Message, Reasoning, FunctionCall, LocalShellCall, CustomToolCall, WebSearchCall
        // IDs are only re-attached for Azure with store=true
        if (model.api.npm === "@ai-sdk/openai" && opts.body && opts.method === "POST") {
          const body = JSON.parse(opts.body as string)
          const isAzure = model.providerID.includes("azure")
          const keepIds = isAzure && body.store === true
          if (!keepIds && Array.isArray(body.input)) {
            for (const item of body.input) {
              if ("id" in item) {
                delete item.id
              }
            }
            opts.body = JSON.stringify(body)
          }
        }

        const res = await fetchFn(input, {
          ...opts,
          // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
          timeout: false,
        })

        if (!chunkAbortCtl) return res
        return wrapSSE(res, chunkTimeout, chunkAbortCtl)
      }

      // Special case: google-vertex-anthropic uses a subpath import
      const bundledKey =
        model.providerID === "google-vertex-anthropic" ? "@ai-sdk/google-vertex/anthropic" : model.api.npm
      const bundledFn = BUNDLED_PROVIDERS[bundledKey]
      if (bundledFn) {
        log.info("using bundled provider", { providerID: model.providerID, pkg: bundledKey })
        const loaded = bundledFn({
          name: model.providerID,
          ...options,
        })
        s.sdk.set(key, loaded)
        return loaded as SDK
      }

      let installedPath: string
      if (!model.api.npm.startsWith("file://")) {
        installedPath = await BunProc.install(model.api.npm, "latest")
      } else {
        log.info("loading local provider", { pkg: model.api.npm })
        installedPath = model.api.npm
      }

      const mod = await import(installedPath)

      const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
      const loaded = fn({
        name: model.providerID,
        ...options,
      })
      s.sdk.set(key, loaded)
      return loaded as SDK
    } catch (e) {
      throw new InitError({ providerID: model.providerID }, { cause: e })
    }
  }

  export async function getProvider(providerID: string) {
    return state().then((s) => s.providers[providerID])
  }

  export async function getModel(providerID: string, modelID: string) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) {
      const availableProviders = Object.keys(s.providers)
      const matches = fuzzysort.go(providerID, availableProviders, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }

    const info = provider.models[modelID]
    if (!info) {
      const availableModels = Object.keys(provider.models)
      const matches = fuzzysort.go(modelID, availableModels, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }
    return info
  }

  export async function getLanguage(model: Model): Promise<LanguageModelV2> {
    const s = await state()
    const key = `${model.providerID}/${model.id}`
    if (s.models.has(key)) return s.models.get(key)!

    const provider = s.providers[model.providerID]
    const sdk = await getSDK(model)

    try {
      const language = s.modelLoaders[model.providerID]
        ? await s.modelLoaders[model.providerID](sdk, model.api.id, provider.options)
        : sdk.languageModel(model.api.id)
      s.models.set(key, language)
      return language
    } catch (e) {
      if (e instanceof NoSuchModelError)
        throw new ModelNotFoundError(
          {
            modelID: model.id,
            providerID: model.providerID,
          },
          { cause: e },
        )
      throw e
    }
  }

  export async function closest(providerID: string, query: string[]) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) return undefined
    for (const item of query) {
      for (const modelID of Object.keys(provider.models)) {
        if (modelID.includes(item))
          return {
            providerID,
            modelID,
          }
      }
    }
  }

  export async function getSmallModel(providerID: string) {
    const cfg = await Config.get()

    if (cfg.small_model) {
      const parsed = parseModel(cfg.small_model)
      return getModel(parsed.providerID, parsed.modelID)
    }

    const provider = await state().then((state) => state.providers[providerID])
    if (provider) {
      let priority = [
        "claude-haiku-4-5",
        "claude-haiku-4.5",
        "3-5-haiku",
        "3.5-haiku",
        "gemini-3-flash",
        "gemini-2.5-flash",
        "gpt-5-nano",
      ]
      if (providerID.startsWith("opencode")) {
        priority = ["gpt-5-nano"]
      }
      if (providerID.startsWith("github-copilot")) {
        // prioritize free models for github copilot
        priority = ["gpt-5-mini", "claude-haiku-4.5", ...priority]
      }
      for (const item of priority) {
        for (const model of Object.keys(provider.models)) {
          if (model.includes(item)) return getModel(providerID, model)
        }
      }
    }

    // Check if opencode provider is available before using it
    const opencodeProvider = await state().then((state) => state.providers["opencode"])
    if (opencodeProvider && opencodeProvider.models["gpt-5-nano"]) {
      return getModel("opencode", "gpt-5-nano")
    }

    return undefined
  }

  const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
  export function sort(models: Model[]) {
    return sortBy(
      models,
      [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
      [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
      [(model) => model.id, "desc"],
    )
  }

  export async function defaultModel() {
    const cfg = await Config.get()
    if (cfg.model) return parseModel(cfg.model)

    const provider = await list()
      .then((val) => Object.values(val))
      .then((x) => x.find((p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id)))
    if (!provider) throw new Error("no providers found")
    const [model] = sort(Object.values(provider.models))
    if (!model) throw new Error("no models found")
    return {
      providerID: provider.id,
      modelID: model.id,
    }
  }

  export function parseModel(model: string) {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: providerID,
      modelID: rest.join("/"),
    }
  }

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: z.string(),
      modelID: z.string(),
      suggestions: z.array(z.string()).optional(),
    }),
  )

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: z.string(),
    }),
  )
}
