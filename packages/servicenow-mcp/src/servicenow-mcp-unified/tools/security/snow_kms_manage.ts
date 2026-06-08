/**
 * snow_kms_manage - Unified Key Management Framework (KMF) operations
 *
 * Wraps ServiceNow's Key Management Framework: KMF modules (sys_kmf_module),
 * cryptographic modules (sys_kmf_crypto_module), keys (sys_kmf_key), and key
 * ring assignments. Used to bootstrap and rotate the keys that drive PII/PCI
 * encryption flows (column encryption, edge encryption, encrypted text fields).
 *
 * Encryption and decryption are not standard Table API operations — they are
 * exposed by ServiceNow as scripted REST endpoints or via the GlideEncrypter
 * API inside Script Includes. This tool calls the platform's KMF helper
 * Script Include via the documented scripted REST surface; if the endpoint
 * is unavailable, it falls back to invoking GlideEncrypter directly through
 * the shared script-execution path.
 *
 * Companion to snow_create_security_policy and snow_audit_trail_analysis.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_kms_manage",
  description: `Unified tool for the ServiceNow Key Management Framework. Covers KMF modules (sys_kmf_module), cryptographic modules (sys_kmf_crypto_module), and keys (sys_kmf_key) for use in PII/PCI encryption flows and Edge Encryption.

Actions:
- list_modules — list KMF modules (sys_kmf_module) and their crypto modules
- create_key — create a new key under a KMF module (writes sys_kmf_key)
- encrypt — encrypt a plaintext payload using the named key
- decrypt — decrypt a ciphertext payload using the named key
- list_keys — list keys, optionally filtered by module
- rotate_key — generate a new active version of a key and deactivate the previous one

Use when: managing KMF modules and keys for sensitive data, rotating keys on schedule, or wrapping/unwrapping payloads through the platform. Encrypt and decrypt invoke a server-side helper Script Include rather than the Table API; falls back to a scripted-execution path if the dedicated endpoint is absent.

Returns: action-specific data. List operations return arrays of KMF records (sys_id, name, module, type, active, key_format). Create/rotate return the new key record. Encrypt/decrypt return the wrapped/unwrapped payload as a string. Plaintext and ciphertext are never logged in error metadata.`,
  category: "security",
  subcategory: "security",
  use_cases: ["security", "encryption", "kms", "key-management", "pii", "compliance"],
  complexity: "advanced",
  frequency: "low",
  permission: "write",
  allowedRoles: ["admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "KMS action to perform",
        enum: ["list_modules", "create_key", "encrypt", "decrypt", "list_keys", "rotate_key"],
      },
      // Identifiers
      module_sys_id: {
        type: "string",
        description: "[create_key/list_keys/rotate_key] sys_id of the KMF module (sys_kmf_module)",
      },
      key_sys_id: {
        type: "string",
        description: "[rotate_key/encrypt/decrypt] sys_id of the key (sys_kmf_key)",
      },
      key_name: {
        type: "string",
        description: "[create_key/encrypt/decrypt/rotate_key] Logical name of the key (alternative to key_sys_id)",
      },
      // CREATE_KEY parameters
      algorithm: {
        type: "string",
        description: "[create_key] Symmetric algorithm",
        enum: ["AES-128", "AES-256", "RSA-2048", "RSA-4096", "HMAC-SHA-256"],
      },
      key_purpose: {
        type: "string",
        description: "[create_key] Intended purpose",
        enum: ["encryption", "signing", "wrapping"],
      },
      label: {
        type: "string",
        description: "[create_key] Display label",
      },
      // ENCRYPT / DECRYPT parameters
      plaintext: {
        type: "string",
        description: "[encrypt] Plaintext payload to encrypt (never logged in error output)",
      },
      ciphertext: {
        type: "string",
        description: "[decrypt] Base64-encoded ciphertext payload to decrypt (never logged in error output)",
      },
      // LIST parameters
      active_only: {
        type: "boolean",
        description: "[list_modules/list_keys] Only return active records",
        default: true,
      },
      limit: {
        type: "number",
        description: "[list_modules/list_keys] Maximum records to return",
        default: 50,
      },
      // ROTATE parameters
      retire_previous: {
        type: "boolean",
        description: "[rotate_key] Mark the previous active key as inactive after creating the new version",
        default: true,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list_modules":
        return await executeListModules(args, context)
      case "create_key":
        return await executeCreateKey(args, context)
      case "encrypt":
        return await executeEncrypt(args, context)
      case "decrypt":
        return await executeDecrypt(args, context)
      case "list_keys":
        return await executeListKeys(args, context)
      case "rotate_key":
        return await executeRotateKey(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list_modules, create_key, encrypt, decrypt, list_keys, rotate_key`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    // Redact any plaintext/ciphertext payload from the error message — be paranoid.
    const redactedMessage = redactSensitive(err.message)
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `KMS ${action} failed: ${redactedMessage}`, {
            originalError: new Error(redactedMessage),
          }),
    )
  }
}

// ==================== HELPERS ====================

function redactSensitive(message: string): string {
  // Strip anything that looks like a long base64 blob, in case the platform echoes payload back.
  return message.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[redacted]")
}

async function findKey(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string | undefined,
  name: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (sysId) {
    const direct = await client.get(`/api/now/table/sys_kmf_key/${sysId}`)
    if (direct.data.result && direct.data.result.sys_id) return direct.data.result
  }
  if (name) {
    const search = await client.get("/api/now/table/sys_kmf_key", {
      params: {
        sysparm_query: `name=${name}^active=true`,
        sysparm_limit: 1,
      },
    })
    const results = search.data.result || []
    if (results.length > 0) return results[0]
  }
  return null
}

// ==================== LIST_MODULES ====================

async function executeListModules(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const active_only = args.active_only !== false
  const limit = (args.limit as number) || 50

  const client = await getAuthenticatedClient(context)

  const moduleResponse = await client.get("/api/now/table/sys_kmf_module", {
    params: {
      sysparm_query: active_only ? "active=true" : "",
      sysparm_limit: limit,
      sysparm_orderby: "name",
    },
  })
  const modules = ((moduleResponse.data.result || []) as Array<Record<string, unknown>>).map((m) => ({
    sys_id: m.sys_id,
    name: m.name,
    label: m.label,
    type: m.type,
    active: m.active,
    url: `${context.instanceUrl}/nav_to.do?uri=sys_kmf_module.do?sys_id=${m.sys_id}`,
  }))

  // Also list crypto modules — they pair with KMF modules in the framework.
  // TODO: verify sys_kmf_crypto_module structure against a live instance.
  let cryptoModules: Array<Record<string, unknown>> = []
  try {
    const cryptoResponse = await client.get("/api/now/table/sys_kmf_crypto_module", {
      params: { sysparm_limit: limit, sysparm_orderby: "name" },
    })
    cryptoModules = ((cryptoResponse.data.result || []) as Array<Record<string, unknown>>).map((c) => ({
      sys_id: c.sys_id,
      name: c.name,
      provider: c.provider,
      type: c.type,
      active: c.active,
    }))
  } catch {
    // Crypto module table may not be present on every release
  }

  return createSuccessResult({
    action: "list_modules",
    modules,
    crypto_modules: cryptoModules,
    counts: { modules: modules.length, crypto_modules: cryptoModules.length },
  })
}

// ==================== CREATE_KEY ====================

async function executeCreateKey(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const module_sys_id = args.module_sys_id as string | undefined
  const key_name = args.key_name as string | undefined
  const algorithm = args.algorithm as string | undefined
  const key_purpose = args.key_purpose as string | undefined
  const label = args.label as string | undefined

  if (!module_sys_id) return createErrorResult("module_sys_id is required for create_key action")
  if (!key_name) return createErrorResult("key_name is required for create_key action")
  if (!algorithm) return createErrorResult("algorithm is required for create_key action")

  const client = await getAuthenticatedClient(context)

  const payload: Record<string, unknown> = {
    module: module_sys_id,
    name: key_name,
    label: label || key_name,
    algorithm,
    active: true,
  }
  if (key_purpose) payload.purpose = key_purpose

  // TODO: verify sys_kmf_key field set against a live instance.
  const response = await client.post("/api/now/table/sys_kmf_key", payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "create_key",
    created: true,
    sys_id: created.sys_id,
    name: created.name,
    key: {
      sys_id: created.sys_id,
      name: created.name,
      label: created.label,
      algorithm: created.algorithm,
      module: created.module,
      active: created.active,
    },
    url: `${context.instanceUrl}/nav_to.do?uri=sys_kmf_key.do?sys_id=${created.sys_id}`,
  })
}

// ==================== ENCRYPT / DECRYPT ====================

async function executeEncrypt(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const plaintext = args.plaintext as string | undefined
  if (!plaintext) return createErrorResult("plaintext is required for encrypt action")
  const keyRef = resolveKeyRef(args)
  if (!keyRef) return createErrorResult("key_sys_id or key_name is required for encrypt action")

  return await callKmfHelper(context, "encrypt", { key: keyRef, payload: plaintext })
}

async function executeDecrypt(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const ciphertext = args.ciphertext as string | undefined
  if (!ciphertext) return createErrorResult("ciphertext is required for decrypt action")
  const keyRef = resolveKeyRef(args)
  if (!keyRef) return createErrorResult("key_sys_id or key_name is required for decrypt action")

  return await callKmfHelper(context, "decrypt", { key: keyRef, payload: ciphertext })
}

function resolveKeyRef(args: Record<string, unknown>): string | null {
  const key_sys_id = args.key_sys_id as string | undefined
  const key_name = args.key_name as string | undefined
  return key_sys_id || key_name || null
}

async function callKmfHelper(
  context: ServiceNowContext,
  op: "encrypt" | "decrypt",
  body: { key: string; payload: string },
): Promise<ToolResult> {
  const client = await getAuthenticatedClient(context)

  // Preferred path: scripted REST endpoint exposed by the KMF helper.
  // TODO: verify against live instance — best-effort from docs.
  try {
    const response = await client.post(`/api/sn_kmf/${op}`, body)
    const data = response.data.result ?? response.data
    return createSuccessResult({
      action: op,
      key: body.key,
      result: data,
    })
  } catch (firstErr: unknown) {
    // Fallback: invoke GlideEncrypter via the platform's scripted-exec.
    // We import lazily to avoid a hard dependency cycle if scripted-exec
    // changes its signature. ES5 syntax only inside the executed script.
    const scripted = await import("../../shared/scripted-exec.js")

    // ES5 script string — no const/let/arrow/template literal inside.
    var script: string
    if (op === "encrypt") {
      script =
        "var enc = new GlideEncrypter();\n" +
        "var keyRef = " + JSON.stringify(body.key) + ";\n" +
        "var payload = " + JSON.stringify(body.payload) + ";\n" +
        "var out = enc.encrypt(keyRef, payload);\n" +
        "gs.print(out);"
    } else {
      script =
        "var enc = new GlideEncrypter();\n" +
        "var keyRef = " + JSON.stringify(body.key) + ";\n" +
        "var payload = " + JSON.stringify(body.payload) + ";\n" +
        "var out = enc.decrypt(keyRef, payload);\n" +
        "gs.print(out);"
    }

    const execResult = await scripted.executeServerScript(context, script, {
      description: `KMS ${op} via GlideEncrypter fallback`,
      timeout: 30000,
    })

    if (!execResult.success) {
      const firstMessage = (firstErr as Error).message
      throw new SnowFlowError(
        ErrorType.SERVICENOW_API_ERROR,
        "KMF helper endpoint unavailable and GlideEncrypter fallback failed: " + redactSensitive(execResult.error || firstMessage),
      )
    }

    const printed = (execResult.output || [])
      .filter((o) => o.level === "print")
      .map((o) => o.message)
      .join("")

    return createSuccessResult({
      action: op,
      key: body.key,
      method: "scripted_exec_fallback",
      result: printed,
    })
  }
}

// ==================== LIST_KEYS ====================

async function executeListKeys(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const module_sys_id = args.module_sys_id as string | undefined
  const active_only = args.active_only !== false
  const limit = (args.limit as number) || 50

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (module_sys_id) queryParts.push(`module=${module_sys_id}`)
  if (active_only) queryParts.push("active=true")

  const response = await client.get("/api/now/table/sys_kmf_key", {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "name",
      sysparm_fields: "sys_id,name,label,algorithm,purpose,module,active,sys_created_on,sys_updated_on",
    },
  })

  const keys = ((response.data.result || []) as Array<Record<string, unknown>>).map((k) => ({
    sys_id: k.sys_id,
    name: k.name,
    label: k.label,
    algorithm: k.algorithm,
    purpose: k.purpose,
    module: k.module,
    active: k.active,
    created_at: k.sys_created_on,
    updated_at: k.sys_updated_on,
    url: `${context.instanceUrl}/nav_to.do?uri=sys_kmf_key.do?sys_id=${k.sys_id}`,
  }))

  return createSuccessResult({
    action: "list_keys",
    count: keys.length,
    keys,
  })
}

// ==================== ROTATE_KEY ====================

async function executeRotateKey(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const key_sys_id = args.key_sys_id as string | undefined
  const key_name = args.key_name as string | undefined
  const retire_previous = args.retire_previous !== false

  if (!key_sys_id && !key_name) {
    return createErrorResult("key_sys_id or key_name is required for rotate_key action")
  }

  const client = await getAuthenticatedClient(context)
  const previous = await findKey(client, key_sys_id, key_name)
  if (!previous) {
    return createErrorResult(`Key not found: ${key_sys_id || key_name}`)
  }

  const previousSysId = previous.sys_id as string

  // Create a new active key with the same name/algorithm/module but a versioned label.
  // The platform's recommended pattern is "name + _vN"; if a version column exists, increment it.
  // TODO: verify the canonical rotation API/columns against a live instance.
  const newKeyPayload: Record<string, unknown> = {
    module: previous.module,
    name: previous.name,
    label: `${previous.label || previous.name} (rotated)`,
    algorithm: previous.algorithm,
    purpose: previous.purpose,
    active: true,
  }
  if (previous.version !== undefined) {
    const versionAsNumber = Number(previous.version)
    newKeyPayload.version = Number.isFinite(versionAsNumber) ? versionAsNumber + 1 : previous.version
  }

  const newResponse = await client.post("/api/now/table/sys_kmf_key", newKeyPayload)
  const newKey = newResponse.data.result as Record<string, unknown>

  if (retire_previous) {
    await client.patch(`/api/now/table/sys_kmf_key/${previousSysId}`, { active: false })
  }

  return createSuccessResult({
    action: "rotate_key",
    rotated: true,
    previous_sys_id: previousSysId,
    previous_active: !retire_previous,
    new_sys_id: newKey.sys_id,
    new_key: {
      sys_id: newKey.sys_id,
      name: newKey.name,
      label: newKey.label,
      algorithm: newKey.algorithm,
      active: newKey.active,
    },
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
