import path from "path"
import fs from "fs"
import type { Auth } from "@opencode-ai/sdk/v2"
import type { Hooks, PluginInput, Config } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { OAUTH_DUMMY_KEY } from "../../auth"

const log = Log.create({ service: "plugin.servicenow-llm" })

// ---------------------------------------------------------------------------
// servicenow-llm bundled provider plugin
//
// Ported from the previous Serac fork's ~730-line servicenow-llm handler that
// lived inline in packages/opencode/src/provider/provider.ts (the
// "servicenow-llm" CUSTOM_LOADER + the fetch-wrapping unwrap/SSE block). It
// talks to an LLM hosted behind a ServiceNow MID Server, exposed via a Scripted
// REST API at ${instance}/api/snow_flow/llm. ServiceNow wraps responses in
// { "result": ... } and answers with a single complete JSON body (MID-Server
// calls go through the ECC queue and can take 30-120+s), whereas the AI SDK's
// openai-compatible client expects either OpenAI JSON or an SSE stream. This
// plugin's custom fetch unwraps the ServiceNow envelope and, for streaming
// requests, synthesizes an SSE stream from the single response.
//
// HOW THIS WIRES INTO 1.16 (the important bit):
//   In 1.16 a plugin auth.loader only fires for provider P when BOTH (a)
//   database[P] exists AND (b) an auth record is stored under id P. servicenow-llm
//   is not a models.dev provider, and its creds are stored under the "servicenow"
//   provider id (by ./auth.ts), not "servicenow-llm". 1.16 reads cfg.provider
//   AFTER running each plugin's config() hook, so the working path is a config()
//   hook that (1) injects provider["servicenow-llm"] (so the provider + a model
//   exist in the database) and (2) puts apiKey/baseURL/timeout + the custom fetch
//   into that provider's options. resolveSDK preserves options.fetch as
//   customFetch and invokes it, so the unwrap/SSE logic runs in the same place the
//   fork's did. We also expose a codex-style auth.loader for forward-compat (if a
//   record is ever stored under "servicenow-llm"), but config() is primary.
//
// NEEDS RUNTIME VERIFICATION:
//   (1) The endpoint path ${instance}/api/snow_flow/llm and its { result: ... }
//       envelope must match what the deployed ServiceNow Scripted REST API
//       returns; the four extraction shapes below mirror the fork but are
//       unverified against a live instance.
//   (2) Authorization: this plugin sets `Bearer <token>` for oauth creds and
//       `Basic <base64(user:pass)>` for basic creds. The old fork passed the
//       basic base64 as the openai-compatible apiKey (sent as Bearer); the Basic
//       scheme used here is the intended fix but must be confirmed end-to-end.
//   (3) The default model id "snow-flow-llm" / its capabilities + limits are
//       placeholders so the provider has at least one selectable model; confirm
//       against the real MID-Server-hosted model and adjust context/output.
//   (4) MID-Server latency: timeout defaults to 180s and is combined with the
//       caller's abort signal; verify long ECC-queue round-trips don't get cut.
//   (5) Streaming: ServiceNow returns one complete body; we fake SSE. Confirm
//       the TUI renders the synthesized chunks and final usage correctly.
// ---------------------------------------------------------------------------

const SERVICENOW_LLM_PROVIDER = "servicenow-llm"
const LLM_PATH = "/api/snow_flow/llm"
const DEFAULT_TIMEOUT = 180000
const DEFAULT_MODEL_ID = "snow-flow-llm"

interface ServiceNowCreds {
  instance: string
  // Either a bearer token (oauth) or basic credentials.
  accessToken?: string
  username?: string
  password?: string
  authType: "oauth" | "basic"
}

// Read the creds stored by ./auth.ts (an "api" auth record under the
// "servicenow" provider, whose metadata is a string-map) straight from
// auth.json. The config hook runs early, so — exactly like auth.ts — we avoid
// the Effect-based Auth service and read the file directly.
function readStoredServiceNowCreds(): ServiceNowCreds | undefined {
  try {
    const raw =
      process.env["OPENCODE_AUTH_CONTENT"] ?? fs.readFileSync(path.join(Global.Path.data, "auth.json"), "utf8")
    const data = JSON.parse(raw) as Record<string, { type?: string; key?: string; metadata?: Record<string, string> }>
    const entry = data["servicenow"]
    if (!entry || entry.type !== "api" || !entry.metadata) return undefined
    const m = entry.metadata
    const instance = m["instance"]
    if (!instance) return undefined
    if (m["authType"] === "basic" && entry.key) {
      const [username, password] = Buffer.from(entry.key, "base64").toString("utf8").split(":")
      return { instance, username, password, authType: "basic" }
    }
    // oauth (or anything with an access token in `key`)
    if (entry.key) return { instance, accessToken: entry.key, authType: "oauth" }
    return undefined
  } catch {
    return undefined
  }
}

function credsFromAuthRecord(auth: Auth): ServiceNowCreds | undefined {
  // Forward-compat path: if a record is ever stored directly under the
  // "servicenow-llm" provider id, the codex-style loader can use it.
  if (auth.type !== "api" || !auth.metadata) return undefined
  const m = auth.metadata
  const instance = m["instance"]
  if (!instance) return undefined
  if (m["authType"] === "basic" && auth.key) {
    const [username, password] = Buffer.from(auth.key, "base64").toString("utf8").split(":")
    return { instance, username, password, authType: "basic" }
  }
  if (auth.key) return { instance, accessToken: auth.key, authType: "oauth" }
  return undefined
}

function baseURLFor(creds: ServiceNowCreds): string {
  return `${creds.instance.replace(/\/+$/, "")}${LLM_PATH}`
}

function authorizationHeader(creds: ServiceNowCreds): string | undefined {
  if (creds.authType === "oauth" && creds.accessToken) return `Bearer ${creds.accessToken}`
  if (creds.authType === "basic") {
    const basic = Buffer.from(`${creds.username ?? ""}:${creds.password ?? ""}`).toString("base64")
    return `Basic ${basic}`
  }
  return undefined
}

// Faithful port of the fork's createSSEStream: a role chunk, ~10-char content
// chunks for smooth streaming, a finish chunk with usage, then [DONE].
function createSSEStream(
  content: string,
  model: string,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): string[] {
  const id = `chatcmpl-${crypto.randomUUID()}`
  const chunks: string[] = []

  chunks.push(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    })}\n\n`,
  )

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

// Builds the custom fetch that the AI SDK's openai-compatible client will call.
// `getCreds` is re-read on every request so token refreshes (done downstream by
// the auth plugin) are picked up. This is the fork's ~730-line unwrap/SSE block.
function createServiceNowFetch(getCreds: () => ServiceNowCreds | undefined, timeout: number | false) {
  return async (input: any, init?: BunFetchRequestInit): Promise<Response> => {
    const { signal, ...rest } = init ?? {}

    const creds = getCreds()
    if (!creds) {
      return new Response(
        JSON.stringify({ error: { message: "No ServiceNow credentials available", type: "servicenow_error" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      )
    }

    // Detect streaming requests so we know whether to emit SSE or plain JSON.
    let isStreamingRequest = false
    try {
      if (init?.body) {
        const bodyStr = typeof init.body === "string" ? init.body : await new Response(init.body as any).text()
        const bodyJson = JSON.parse(bodyStr)
        isStreamingRequest = bodyJson.stream === true
      }
    } catch {
      // Ignore parsing errors — treat as non-streaming.
    }

    // Combine the caller's signal with the MID-Server timeout.
    const signals: AbortSignal[] = []
    if (signal) signals.push(signal)
    if (timeout !== false) signals.push(AbortSignal.timeout(timeout))
    const combined = signals.length > 1 ? AbortSignal.any(signals) : signals.length === 1 ? signals[0] : undefined

    // Set the Authorization header explicitly: ServiceNow needs Basic for basic
    // auth (the openai-compatible client would otherwise send Bearer).
    const headers = new Headers(rest.headers as HeadersInit | undefined)
    const authHeader = authorizationHeader(creds)
    if (authHeader) headers.set("authorization", authHeader)

    log.info("servicenow-llm fetch", {
      url: typeof input === "string" ? input : (input?.url ?? String(input)),
      timeout,
      streaming: isStreamingRequest,
    })

    const response = await fetch(input, {
      ...rest,
      headers,
      signal: combined,
      // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
      timeout: false,
    })

    log.info("servicenow-llm response", {
      status: response.status,
      statusText: response.statusText,
    })

    const cloned = response.clone()
    try {
      const text = await cloned.text()

      log.info("servicenow-llm raw body", {
        length: text.length,
        preview: text.substring(0, 300),
      })

      let body: any
      try {
        body = JSON.parse(text)
      } catch {
        log.warn("servicenow-llm not JSON, returning original response")
        return response
      }

      let content: string | null = null
      let modelName = "unknown"
      let usage: any = null

      // ServiceNow Scripted REST wraps the payload in { result: ... }.
      if (body && typeof body === "object" && "result" in body) {
        const unwrapped = body.result

        log.info("servicenow-llm unwrapped", {
          type: typeof unwrapped,
          keys: unwrapped && typeof unwrapped === "object" ? Object.keys(unwrapped) : [],
        })

        // OpenAI format inside the wrapper
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

      if (content !== null) {
        log.info("servicenow-llm: content extracted", {
          contentLength: content.length,
          model: modelName,
          isStreaming: isStreamingRequest,
        })

        if (isStreamingRequest) {
          const sseBody = createSSEStream(content, modelName, usage).join("")
          log.info("servicenow-llm: returning SSE stream", { sseLength: sseBody.length })
          return new Response(sseBody, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          })
        }

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

      log.warn("servicenow-llm: could not extract content from response", {
        bodyPreview: JSON.stringify(body).substring(0, 300),
      })
    } catch (e) {
      log.warn("servicenow-llm fetch handler error", { error: String(e) })
    }

    return response
  }
}

// A minimal models.dev-style model entry so the provider has at least one
// selectable model in the database. Shape matches the SDK ProviderConfig.models
// entry. NEEDS RUNTIME VERIFICATION: real model id, context/output limits.
function defaultModelEntry() {
  return {
    id: DEFAULT_MODEL_ID,
    name: "ServiceNow MID-Server LLM",
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    release_date: "2024-01-01",
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 131072, output: 32768 },
    modalities: { input: ["text" as const], output: ["text" as const] },
    status: "active" as const,
  }
}

export async function ServiceNowLLMPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: SERVICENOW_LLM_PROVIDER,
      // Forward-compat codex-style loader: only fires if a record is stored
      // under the "servicenow-llm" provider id. The real wiring happens in the
      // config() hook below (creds live under "servicenow").
      async loader(getAuth) {
        const auth = await getAuth()
        const creds = credsFromAuthRecord(auth)
        if (!creds) return {}
        return {
          apiKey: OAUTH_DUMMY_KEY,
          baseURL: baseURLFor(creds),
          timeout: DEFAULT_TIMEOUT,
          fetch: createServiceNowFetch(() => credsFromAuthRecord(auth), DEFAULT_TIMEOUT),
        }
      },
      // No interactive methods here — creds are collected by the "servicenow"
      // auth plugin (./auth.ts) and reused. Provide a hidden api entry so the
      // provider id is registerable without prompting.
      methods: [
        {
          type: "api",
          label: "ServiceNow MID-Server LLM (uses stored ServiceNow auth)",
        },
      ],
    },
    // The working 1.16 path: inject the provider + a model into cfg.provider so
    // it exists in the database, and attach apiKey/baseURL/timeout + the custom
    // fetch via options. Runs before provider.ts reads cfg.provider.
    config: async (config) => {
      const creds = readStoredServiceNowCreds()
      if (!creds) {
        log.info("servicenow-llm: no stored ServiceNow creds, skipping provider injection")
        return
      }

      const target = config as Config & {
        provider?: Record<string, any>
      }
      target.provider ??= {}
      if (target.provider[SERVICENOW_LLM_PROVIDER]) return

      const baseURL = baseURLFor(creds)
      target.provider[SERVICENOW_LLM_PROVIDER] = {
        name: "ServiceNow LLM",
        npm: "@ai-sdk/openai-compatible",
        api: baseURL,
        options: {
          apiKey: OAUTH_DUMMY_KEY,
          baseURL,
          timeout: DEFAULT_TIMEOUT,
          // Re-read creds per request so downstream token refreshes are honored.
          fetch: createServiceNowFetch(readStoredServiceNowCreds, DEFAULT_TIMEOUT),
        },
        models: {
          [DEFAULT_MODEL_ID]: defaultModelEntry(),
        },
      }
      log.info("servicenow-llm: injected provider", { baseURL })
    },
  }
}
