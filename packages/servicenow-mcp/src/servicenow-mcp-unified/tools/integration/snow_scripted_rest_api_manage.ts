/**
 * snow_scripted_rest_api_manage
 *
 * Authors inbound Scripted REST APIs: the sys_ws_definition record and the
 * sys_ws_operation resources hanging off it. This is the build side; calling a
 * finished endpoint is snow_scripted_rest_api's job.
 *
 * Field names and payload shapes are copied from shared/scripted-exec.ts, which
 * deploys Serac's own executor endpoint through exactly these two tables against
 * live instances — with one exception. `requires_acl_authorization` is a column
 * scripted-exec names in a comment and deliberately never sends, and ServiceNow's
 * published docs do not enumerate sys_ws_operation's fields, so that one name is
 * carried from a comment and unverified against a live instance. Which is why the
 * tool reports the value the instance returned rather than the value it sent: if
 * the column is wrong, protected or absent on this version, the caller is told so
 * instead of being reassured that ACL enforcement is on. Every other column here
 * (name, service_id, short_description, active on the definition; name,
 * web_service_definition, http_method, relative_path, operation_script, active,
 * requires_authentication on the resource) is one scripted-exec really writes.
 *
 * The one thing this tool refuses to fake: a created resource is not necessarily
 * a reachable URL. ServiceNow computes `operation_uri` itself, and the route
 * takes a moment to appear — scripted-exec pings up to five times at 1.5s before
 * it believes its own deployment. So a create returns the URI ServiceNow
 * assigned plus an explicit routing verdict, never a bare `created: true`.
 */

import type { AxiosInstance } from "axios"
import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

const DEFINITION_TABLE = "/api/now/table/sys_ws_definition"
const OPERATION_TABLE = "/api/now/table/sys_ws_operation"
const DEFINITION_FIELDS = "sys_id,name,service_id,namespace,base_uri,short_description,active"
// requires_acl_authorization is requested here so the tool can report what the
// instance stores rather than what the caller asked for. Asking for a column the
// table does not have is safe: "Invalid fields are ignored" per the Table API
// reference, so it simply comes back absent — which this tool reports as
// unconfirmed, not as off.
const OPERATION_FIELDS =
  "sys_id,name,http_method,relative_path,operation_uri,active,requires_authentication,requires_acl_authorization,web_service_definition"
// One page of resources. A definition with more than this many is not something
// this tool will delete, because it cannot see the rest to delete them first.
const OPERATION_PAGE_LIMIT = 200

export const toolDefinition: MCPToolDefinition = {
  name: "snow_scripted_rest_api_manage",
  description:
    "Build and maintain inbound Scripted REST APIs on the instance: the sys_ws_definition record (list/get/create/update/delete) and its sys_ws_operation resources (add_operation/update_operation/delete_operation). " +
    "Returns the operation_uri ServiceNow assigned to each resource, and — with verify_routing=true, or action=verify afterwards — whether that URL actually answers yet; a freshly created resource is routable only after a short delay, so it reports 'created but not yet routable' rather than claiming success it did not observe. Probing calls the resource for real, which runs whatever its script does. " +
    "This tool AUTHORS endpoints. To CALL an endpoint that already exists, use snow_scripted_rest_api instead.",
  // Metadata for tool discovery (not sent to LLM)
  category: "integration",
  subcategory: "scripted-rest-api",
  use_cases: ["scripted-rest-api", "inbound-api", "custom-endpoint", "web-service"],
  complexity: "advanced",
  frequency: "medium",

  // Permission enforcement
  // Classification: WRITE — creates and edits sys_ws_definition / sys_ws_operation
  // records, which are configuration and belong in an update set.
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "list", // List Scripted REST API definitions
          "get", // One definition plus all of its resources
          "create", // Create a definition (optionally its first resource)
          "update", // Update a definition
          "delete", // Delete a definition and its resources
          "add_operation", // Add a resource to a definition
          "update_operation", // Update a resource
          "delete_operation", // Delete a resource
          "verify", // Probe an existing resource's URL to see whether it routes
        ],
        description:
          "Action to perform. list/get/create/update/delete act on the API definition (sys_ws_definition); add_operation/update_operation/delete_operation act on its resources (sys_ws_operation); verify probes an existing resource's URL, which calls the resource.",
      },
      sys_id: {
        type: "string",
        description:
          "sys_id of the Scripted REST API definition (get/update/delete/add_operation). Alias: definition_sys_id. " +
          "update_operation/delete_operation/verify also accept it when operation_sys_id is missing, but those actions need the RESOURCE's sys_id — passing the definition's there just 404s.",
      },
      name: {
        type: "string",
        description:
          "[create/update] Name of the API. ServiceNow derives the API ID from it when api_id is omitted. Also usable instead of sys_id to look a definition up.",
      },
      api_id: {
        type: "string",
        description:
          "[create] Explicit API ID (service_id column), the segment that appears in the URL. Leave empty to let ServiceNow derive it from the name.",
      },
      short_description: { type: "string", description: "[create/update] Short description of the API" },
      // No field that update/update_operation can write declares a JSON-schema
      // `default`. Models routinely echo defaults back while meaning to change
      // one other field, and here that is not a no-op: an echoed http_method or
      // relative_path silently re-routes a live endpoint, and an echoed
      // requires_acl_authorization=false silently disarms it. The create-side
      // defaults live in the executor instead, where nothing can mistake them
      // for an instruction. Every update action writes only what it was passed.
      active: {
        type: "boolean",
        description:
          "Whether the record is active. Applies to the definition on create/update, and to the resource on add_operation/update_operation. Defaults to true when creating; on the update actions it is left alone unless passed.",
      },
      filter: {
        type: "string",
        description: '[list] Encoded query against sys_ws_definition (e.g. "nameLIKEorder" or "active=true")',
      },
      limit: { type: "number", description: "[list] Maximum definitions to return", default: 50 },
      operation_sys_id: {
        type: "string",
        description: "sys_id of the resource record (update_operation/delete_operation/verify)",
      },
      operation_name: { type: "string", description: "[create/add_operation/update_operation] Name of the resource" },
      http_method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        description:
          "[create/add_operation/update_operation] HTTP method the resource implements. Creating without it gets GET. On update_operation, pass it only to change the method — it moves the endpoint.",
      },
      relative_path: {
        type: "string",
        description:
          '[create/add_operation/update_operation] Path relative to the API base, e.g. "/orders" or "/orders/{id}". Creating without it gets "/". On update_operation, pass it only to move the resource — every caller of the old path breaks.',
      },
      operation_script: {
        type: "string",
        description:
          "[create/add_operation/update_operation] The resource script, shaped as (function process(request, response) { ... })(request, response). Runs server-side on Rhino, so ES5 only — ES6+ syntax is reported back as a warning.",
      },
      requires_authentication: {
        type: "boolean",
        description:
          "[create/add_operation/update_operation] Require an authenticated caller. Creating without it requires authentication.",
      },
      requires_acl_authorization: {
        type: "boolean",
        description:
          "[create/add_operation/update_operation] Enforce rest_endpoint ACLs on the resource. Creating without it leaves the column unset — see the tool's response notes for why. Authentication alone authorises EVERY authenticated user, so put a gs.hasRole() check in the script if you leave this off. Passing false on update_operation actively turns enforcement off; the response always reports the value the instance stored, not the one you sent.",
      },
      verify_routing: {
        type: "boolean",
        description:
          "[create/add_operation/update_operation/verify] After writing, call the resource URL to see whether it routes yet. WARNING: this invokes your resource script for real, with whatever side effects it has.",
        default: false,
      },
    },
    required: ["action"],
  },
}

/**
 * Action → handler. Exported so the schema's `action` enum can be checked
 * against what the executor really dispatches, instead of the two drifting.
 */
export const ACTIONS = {
  list: listDefinitions,
  get: getDefinition,
  create: createDefinition,
  update: updateDefinition,
  delete: deleteDefinition,
  add_operation: addOperation,
  update_operation: updateOperation,
  delete_operation: deleteOperation,
  verify: verifyOperation,
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = str(args.action)
  const handler = action ? ACTIONS[action as keyof typeof ACTIONS] : undefined
  // Checked before authenticating: a typo shouldn't cost a round trip, and it
  // makes the dispatch table testable without an instance.
  if (!handler) {
    return createErrorResult(
      `Unknown action: ${action ?? "(none)"}. Valid actions: ${Object.keys(ACTIONS).join(", ")}.`,
    )
  }

  try {
    return await handler(await getAuthenticatedClient(context), args)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const status = statusOf(error)
    if (status === 403) {
      return createErrorResult(
        `Permission denied (403) on ${action}. Creating or editing a Scripted REST API needs the web_service_admin role (per ServiceNow's "Create a scripted REST service" procedure) or admin. Original error: ${message}`,
      )
    }
    return createErrorResult(message)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Definition (sys_ws_definition)
// ───────────────────────────────────────────────────────────────────────────

async function listDefinitions(client: AxiosInstance, args: Record<string, unknown>): Promise<ToolResult> {
  const response = await client.get(DEFINITION_TABLE, {
    params: {
      sysparm_query: str(args.filter),
      sysparm_fields: DEFINITION_FIELDS,
      sysparm_limit: num(args.limit) ?? 50,
    },
  })
  const definitions = asArray(rec(response.data).result).map(rec)

  return createSuccessResult(
    {
      action: "list",
      count: definitions.length,
      definitions: definitions.map(summariseDefinition),
    },
    { operation: "list_scripted_rest_apis" },
    `Found ${definitions.length} Scripted REST API definition(s)`,
  )
}

async function getDefinition(client: AxiosInstance, args: Record<string, unknown>): Promise<ToolResult> {
  const definition = await resolveDefinition(client, args)
  const operations = await fetchOperations(client, str(definition.sys_id) ?? "")

  return createSuccessResult(
    {
      action: "get",
      definition: summariseDefinition(definition),
      operations: operations.map(summariseOperation),
      operation_count: operations.length,
      ...(operations.length === 0
        ? { warning: "This API has no resources, so it serves nothing. Add one with action=add_operation." }
        : operations.length === OPERATION_PAGE_LIMIT
          ? {
              warning: `Only the first ${OPERATION_PAGE_LIMIT} resources were read, so this list is probably incomplete.`,
            }
          : {}),
    },
    { operation: "get_scripted_rest_api" },
    `${str(definition.name) ?? "(unnamed)"} — ${operations.length} resource(s), base_uri ${str(definition.base_uri) ?? "(unknown)"}`,
  )
}

async function createDefinition(client: AxiosInstance, args: Record<string, unknown>): Promise<ToolResult> {
  const name = str(args.name)
  if (!name) return createErrorResult("name is required for action=create")

  const response = await client.post(DEFINITION_TABLE, {
    name,
    // Omitted service_id is set by ServiceNow from the name (the form calls it
    // "API ID" and fills it automatically), so only send it when asked for.
    ...(str(args.api_id) ? { service_id: str(args.api_id) } : {}),
    ...(str(args.short_description) ? { short_description: str(args.short_description) } : {}),
    active: bool(args.active, true),
  })
  const definition = rec(rec(response.data).result)
  const definitionId = str(definition.sys_id)
  if (!definitionId) {
    return createErrorResult("ServiceNow accepted the sys_ws_definition insert but returned no sys_id.")
  }

  // A definition on its own serves nothing, so create the first resource in the
  // same call when the caller supplied a script for it. A failure there must not
  // surface as a plain error: the definition already exists on the instance and
  // the caller has to know its sys_id to finish or clean up.
  const operation = str(args.operation_script)
    ? await createOperation(client, definition, args).catch((error: unknown) => messageOf(error))
    : undefined
  if (typeof operation === "string") {
    return createErrorResult(
      `The sys_ws_definition was created (sys_id ${definitionId}, name "${name}") but its first resource was rejected: ${operation}. ` +
        `The API exists and currently serves nothing — retry the resource with action="add_operation", sys_id="${definitionId}", or delete the definition with action="delete".`,
    )
  }

  return createSuccessResult(
    {
      action: "create",
      created: true,
      definition: summariseDefinition(definition),
      ...(operation ? { operation: operation.data } : {}),
      ...(operation?.warnings?.length ? { warnings: operation.warnings } : {}),
      next_steps: operation
        ? [
            operation.data.routing.routable === true
              ? `Call it with snow_scripted_rest_api, or from outside: ${operation.data.url ?? "(unknown URL)"}`
              : `Re-check routing later with action=verify, operation_sys_id="${operation.data.sys_id}"`,
          ]
        : [
            `Add a resource: action="add_operation", sys_id="${definitionId}", relative_path="/...", operation_script="(function process(request, response) { ... })(request, response);"`,
            "Until then this API has no resources and answers nothing.",
          ],
    },
    { operation: "create_scripted_rest_api" },
    `Created Scripted REST API "${name}"\n  sys_id: ${definitionId}\n  base_uri: ${str(definition.base_uri) ?? "(not returned)"}` +
      (operation ? `\n  resource: ${operation.data.url ?? "(unknown URL)"} — ${operation.data.routing.verdict}` : ""),
  )
}

async function updateDefinition(client: AxiosInstance, args: Record<string, unknown>): Promise<ToolResult> {
  const definition = await resolveDefinition(client, args)
  const payload = {
    ...(str(args.name) ? { name: str(args.name) } : {}),
    ...(str(args.short_description) ? { short_description: str(args.short_description) } : {}),
    ...(args.active === undefined ? {} : { active: bool(args.active, true) }),
  }
  if (Object.keys(payload).length === 0) {
    return createErrorResult("Nothing to update. Provide at least one of: name, short_description, active.")
  }

  const response = await client.patch(`${DEFINITION_TABLE}/${str(definition.sys_id)}`, payload)

  return createSuccessResult(
    {
      action: "update",
      updated: true,
      definition: summariseDefinition(rec(rec(response.data).result)),
      fields_updated: Object.keys(payload),
    },
    { operation: "update_scripted_rest_api" },
  )
}

async function deleteDefinition(client: AxiosInstance, args: Record<string, unknown>): Promise<ToolResult> {
  const definition = await resolveDefinition(client, args)
  const definitionId = str(definition.sys_id) ?? ""
  const operations = await fetchOperations(client, definitionId)
  // fetchOperations reads a single page. A full page means there may be resources
  // this tool cannot see, and deleting the definition anyway would orphan them
  // while reporting operations_deleted as if the delete had been clean.
  if (operations.length === OPERATION_PAGE_LIMIT) {
    return createErrorResult(
      `This API has at least ${OPERATION_PAGE_LIMIT} resources, which is one full page — the most this tool reads at a time — so it will not delete the definition and orphan the ones it cannot see. ` +
        `Remove resources with action="delete_operation" until fewer than ${OPERATION_PAGE_LIMIT} remain, or delete the API from System Web Services > Scripted REST APIs in the UI.`,
    )
  }

  // Resources first: a sys_ws_operation left behind points at a definition that
  // no longer exists.
  const deleted: Array<{ sys_id?: string; deleted: boolean; error?: string }> = await Promise.all(
    operations.map((operation) =>
      client
        .delete(`${OPERATION_TABLE}/${str(operation.sys_id)}`)
        .then(() => ({ sys_id: str(operation.sys_id), deleted: true }))
        .catch((error: unknown) => ({
          sys_id: str(operation.sys_id),
          deleted: false,
          error: messageOf(error),
        })),
    ),
  )
  const failed = deleted.filter((entry) => !entry.deleted)
  if (failed.length > 0) {
    return createErrorResult(
      `Could not delete ${failed.length} of ${operations.length} resource(s), so the definition was left in place: ` +
        failed.map((entry) => `${entry.sys_id}: ${entry.error}`).join("; "),
    )
  }

  await client.delete(`${DEFINITION_TABLE}/${definitionId}`)

  return createSuccessResult(
    {
      action: "delete",
      deleted: true,
      sys_id: definitionId,
      operations_deleted: deleted.length,
    },
    { operation: "delete_scripted_rest_api" },
    `Deleted Scripted REST API ${str(definition.name) ?? definitionId} and ${deleted.length} resource(s)`,
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Resources (sys_ws_operation)
// ───────────────────────────────────────────────────────────────────────────

async function addOperation(client: AxiosInstance, args: Record<string, unknown>): Promise<ToolResult> {
  if (!str(args.operation_script)) return createErrorResult("operation_script is required for action=add_operation")

  const definition = await resolveDefinition(client, args)
  const operation = await createOperation(client, definition, args)

  return createSuccessResult(
    {
      action: "add_operation",
      created: true,
      definition: summariseDefinition(definition),
      operation: operation.data,
      ...(operation.warnings.length > 0 ? { warnings: operation.warnings } : {}),
    },
    { operation: "add_scripted_rest_operation" },
    `Added ${operation.data.http_method} resource to ${str(definition.name) ?? "(unnamed API)"}\n  url: ${operation.data.url ?? "(unknown)"}\n  ${operation.data.routing.verdict}`,
  )
}

async function updateOperation(client: AxiosInstance, args: Record<string, unknown>): Promise<ToolResult> {
  const operationId = str(args.operation_sys_id) ?? str(args.sys_id)
  if (!operationId) return createErrorResult("operation_sys_id is required for action=update_operation")

  const script = str(args.operation_script)
  const payload = {
    ...(str(args.operation_name) ? { name: str(args.operation_name) } : {}),
    ...(str(args.http_method) ? { http_method: str(args.http_method) } : {}),
    ...(str(args.relative_path) ? { relative_path: normalisePath(str(args.relative_path)) } : {}),
    ...(script ? { operation_script: script } : {}),
    ...(args.active === undefined ? {} : { active: bool(args.active, true) }),
    ...(args.requires_authentication === undefined
      ? {}
      : { requires_authentication: bool(args.requires_authentication, true) }),
    ...(args.requires_acl_authorization === undefined
      ? {}
      : { requires_acl_authorization: bool(args.requires_acl_authorization, false) }),
  }
  if (Object.keys(payload).length === 0) {
    return createErrorResult(
      "Nothing to update. Provide at least one of: operation_name, http_method, relative_path, operation_script, active, requires_authentication, requires_acl_authorization.",
    )
  }

  const response = await client.patch(`${OPERATION_TABLE}/${operationId}`, payload)
  const operation = rec(rec(response.data).result)
  // Only decoration here: the definition supplies fallback URLs if ServiceNow
  // returned no operation_uri. A failed read is not worth failing the update over.
  const definition = await fetchDefinitionById(client, refValue(operation.web_service_definition)).catch(() => ({}))

  // relative_path changes move the URL, so re-read what ServiceNow now says it is
  // rather than reporting the one the caller remembered.
  const routing = await routeReport(client, definition, operation, args)
  const warnings = [
    ...(script ? es5Warnings(script) : []),
    // Only when this call touched the flag — an unrelated script edit should not
    // start lecturing about a security posture the caller did not change.
    ...("requires_acl_authorization" in payload
      ? aclWarnings(bool(args.requires_acl_authorization, false), flag(operation.requires_acl_authorization))
      : []),
  ]

  return createSuccessResult(
    {
      action: "update_operation",
      updated: true,
      operation: { ...summariseOperation(operation), url: routing.url, routing },
      fields_updated: Object.keys(payload),
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    { operation: "update_scripted_rest_operation" },
  )
}

async function deleteOperation(client: AxiosInstance, args: Record<string, unknown>): Promise<ToolResult> {
  const operationId = str(args.operation_sys_id) ?? str(args.sys_id)
  if (!operationId) return createErrorResult("operation_sys_id is required for action=delete_operation")

  await client.delete(`${OPERATION_TABLE}/${operationId}`)

  return createSuccessResult(
    { action: "delete_operation", deleted: true, operation_sys_id: operationId },
    { operation: "delete_scripted_rest_operation" },
  )
}

async function verifyOperation(client: AxiosInstance, args: Record<string, unknown>): Promise<ToolResult> {
  const operationId = str(args.operation_sys_id) ?? str(args.sys_id)
  if (!operationId) return createErrorResult("operation_sys_id is required for action=verify")

  const response = await client.get(`${OPERATION_TABLE}/${operationId}`, {
    params: { sysparm_fields: OPERATION_FIELDS },
  })
  const operation = rec(rec(response.data).result)
  if (!str(operation.sys_id)) return createErrorResult(`No sys_ws_operation found with sys_id ${operationId}`)

  // Decoration again: the probe runs off the operation's own operation_uri, and
  // the definition only supplies fallback URLs, so a failed read costs detail in
  // the report rather than the verdict.
  const definition = await fetchDefinitionById(client, refValue(operation.web_service_definition)).catch(() => ({}))
  const routing = await routeReport(client, definition, operation, { ...args, verify_routing: true })

  return createSuccessResult(
    {
      action: "verify",
      operation: { ...summariseOperation(operation), url: routing.url, routing },
      definition: summariseDefinition(definition),
    },
    { operation: "verify_scripted_rest_operation" },
    `${routing.verdict}${routing.url ? `\n  url: ${routing.url}` : ""}`,
  )
}

/**
 * Create one sys_ws_operation under `definition`, then report where it lives
 * and whether that URL answers. Shared by create and add_operation.
 *
 * The payload mirrors shared/scripted-exec.ts, which deploys Serac's own
 * executor through this table.
 */
async function createOperation(
  client: AxiosInstance,
  definition: Record<string, unknown>,
  args: Record<string, unknown>,
) {
  const script = str(args.operation_script) ?? ""
  const response = await client.post(OPERATION_TABLE, {
    name: str(args.operation_name) ?? `${str(args.http_method) ?? "GET"} ${normalisePath(str(args.relative_path))}`,
    web_service_definition: str(definition.sys_id),
    http_method: str(args.http_method) ?? "GET",
    relative_path: normalisePath(str(args.relative_path)),
    operation_script: script,
    active: bool(args.active, true),
    requires_authentication: bool(args.requires_authentication, true),
    // requires_acl_authorization is only sent when the caller asks for it.
    // Carried forward from shared/scripted-exec.ts, which learned this the hard
    // way: with it on and no rest_endpoint ACL defined for the resource,
    // ServiceNow's behaviour is version-dependent and can deny every caller —
    // including the admin integration user the endpoint exists to serve. The
    // cost of leaving it off is that authentication alone authorises every
    // authenticated user, which is why the response says so and why
    // scripted-exec puts a gs.hasRole() check inside its own script.
    ...(bool(args.requires_acl_authorization, false) ? { requires_acl_authorization: true } : {}),
  })
  // The Table API returns the inserted record, so what the instance actually
  // stored is already in hand — no extra read to find out whether the security
  // flag survived the insert.
  const operation = rec(rec(response.data).result)
  const routing = await routeReport(client, definition, operation, args)

  return {
    data: {
      ...summariseOperation(operation),
      url: routing.url,
      routing,
    },
    warnings: [
      ...es5Warnings(script),
      ...aclWarnings(bool(args.requires_acl_authorization, false), flag(operation.requires_acl_authorization)),
    ],
  }
}

/**
 * What the instance stored for requires_acl_authorization, said plainly.
 *
 * Driven by the response body, never by the argument. This is the one column the
 * tool writes that no other code in the repo has proven, so "the caller asked for
 * true" is not evidence that enforcement is on: a wrong column name, a read-only
 * or protected field, or a scoped-app restriction all end with the flag dropped
 * and the caller believing an endpoint is guarded when every authenticated user
 * can call it. An absent column is reported as unconfirmed rather than collapsed
 * into either state — the Table API ignores invalid sysparm_fields entries, so
 * absence means "this instance did not give us the value", not "it is off".
 */
export function aclWarnings(requested: boolean, stored: boolean | undefined): string[] {
  if (stored === true) return []
  if (stored === undefined)
    return [
      `The instance returned no requires_acl_authorization value for this resource, so ACL enforcement is unconfirmed${requested ? " even though you asked for it" : ""}. ` +
        "Treat the resource as callable by every authenticated user until you have checked the Security section of its form, and keep a gs.hasRole() check at the top of the script.",
    ]
  return [
    requested
      ? "You asked for requires_acl_authorization=true but the record ServiceNow returned has it off, so any authenticated user can call this resource. Set it on the resource form, define a rest_endpoint ACL for it, and until then gate the script with gs.hasRole()."
      : "requires_acl_authorization is off on this resource, so any authenticated user can call it. Add a gs.hasRole() check at the top of the script, or set requires_acl_authorization=true and define a rest_endpoint ACL for it.",
  ]
}

async function fetchOperations(client: AxiosInstance, definitionId: string) {
  const response = await client.get(OPERATION_TABLE, {
    params: {
      sysparm_query: `web_service_definition=${definitionId}`,
      sysparm_fields: OPERATION_FIELDS,
      sysparm_limit: OPERATION_PAGE_LIMIT,
    },
  })
  return asArray(rec(response.data).result).map(rec)
}

// ───────────────────────────────────────────────────────────────────────────
// Routing
// ───────────────────────────────────────────────────────────────────────────

/**
 * Where a resource lives, and — only when asked — whether that URL answers.
 *
 * `operation_uri` is computed by ServiceNow, not by us, so it is read back from
 * the record rather than assembled from the arguments. The probe is opt-in
 * because calling a user's resource runs the user's script, side effects and
 * all; without it the verdict is honestly "unverified".
 */
async function routeReport(
  client: AxiosInstance,
  definition: Record<string, unknown>,
  operation: Record<string, unknown>,
  args: Record<string, unknown>,
) {
  const candidates = buildResourceUrlCandidates({
    operationUri: str(operation.operation_uri),
    baseUri: str(definition.base_uri),
    namespace: str(definition.namespace),
    serviceId: str(definition.service_id),
    relativePath: str(operation.relative_path),
  })
  const url = candidates[0]
  if (candidates.length === 0) {
    return {
      url,
      candidate_urls: candidates,
      routable: null,
      verdict:
        "the record was written but its URL is unknown — ServiceNow returned no operation_uri and the definition's base_uri/namespace/api_id were not available to reconstruct one. Read it back with action=get.",
    }
  }

  if (!bool(args.verify_routing, false)) {
    return {
      url,
      candidate_urls: candidates,
      routable: null,
      verdict:
        "created/updated, routing unverified — pass verify_routing=true to probe it (that invokes the resource script for real), or call it yourself with snow_scripted_rest_api",
    }
  }

  const method = str(operation.http_method) ?? "GET"
  const probes: Array<{ url: string; status: number | null; attempt: number }> = []
  // A freshly created route is not live immediately — scripted-exec pings up to
  // five times at 1.5s before it trusts its own deployment. Every candidate is
  // tried within each round, so a wrong first candidate costs one request rather
  // than the whole retry budget.
  for (const attempt of [1, 2, 3, 4, 5]) {
    for (const candidate of candidates) {
      const status = await probe(client, candidate, method)
      probes.push({ url: candidate, status, attempt })
      if (status !== null && status !== 404) {
        return {
          url: candidate,
          candidate_urls: candidates,
          routable: true,
          probe_status: status,
          verdict: `routable — ${method} ${candidate} answered HTTP ${status} on attempt ${attempt} (any status other than 404 means the route resolved; the status itself comes from your script or from ServiceNow's auth layer)`,
        }
      }
    }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  return {
    url,
    candidate_urls: candidates,
    routable: false,
    // The last round only, named for what it is: every round probes the same
    // candidates, so repeating all of them is noise, but calling the tail
    // "probes" would read as the whole record of what was tried.
    probes_last_attempt: probes.slice(-candidates.length),
    probes_total: probes.length,
    verdict:
      "created but not yet routable — every candidate URL returned 404 (or was unreachable) across five attempts at 1.5s. The route can still appear a little later, so re-check with action=verify; other explanations are an inactive resource or a script that answers 404 itself.",
  }
}

async function probe(client: AxiosInstance, url: string, method: string) {
  const response = await client
    .request({ url, method })
    .catch((error: unknown) => (statusOf(error) === undefined ? null : { status: statusOf(error) as number }))
  return response ? response.status : null
}

/**
 * URLs a resource may answer on, most authoritative first.
 *
 * Generalised from buildCandidateUrls() in shared/scripted-exec.ts, which needs
 * the fallbacks because operation_uri is occasionally absent from the insert
 * response and because base_uri/namespace are computed server-side.
 */
export function buildResourceUrlCandidates(input: {
  operationUri?: string
  baseUri?: string
  namespace?: string
  serviceId?: string
  relativePath?: string
}): string[] {
  const path = input.relativePath ? normalisePath(input.relativePath).replace(/\/+$/, "") : ""
  return [
    input.operationUri,
    input.baseUri ? input.baseUri.replace(/\/+$/, "") + path : undefined,
    input.namespace && input.serviceId ? `/api/${input.namespace}/${input.serviceId}${path}` : undefined,
    input.serviceId ? `/api/${input.serviceId}${path}` : undefined,
  ]
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
    .map((candidate) => (candidate.startsWith("/") ? candidate : `/${candidate}`))
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

async function resolveDefinition(client: AxiosInstance, args: Record<string, unknown>) {
  const sysId = str(args.sys_id) ?? str(args.definition_sys_id)
  if (sysId) {
    const definition = await fetchDefinitionById(client, sysId)
    if (!str(definition.sys_id)) throw new Error(`No sys_ws_definition found with sys_id ${sysId}`)
    return definition
  }

  const name = str(args.name)
  if (!name) throw new Error("sys_id or name is required to identify the Scripted REST API")

  const response = await client.get(DEFINITION_TABLE, {
    params: { sysparm_query: `name=${name}`, sysparm_fields: DEFINITION_FIELDS, sysparm_limit: 1 },
  })
  const definition = rec(asArray(rec(response.data).result)[0])
  if (!str(definition.sys_id)) throw new Error(`No Scripted REST API named "${name}"`)
  return definition
}

/**
 * A 404 is an answer — "there is no such definition" — and the caller gets that
 * verbatim. A 401, 403, 500 or timeout is not an answer, and swallowing one here
 * would make resolveDefinition report "No sys_ws_definition found with sys_id X"
 * for a record that exists, which sends an agent off to create a duplicate. So
 * everything else propagates to execute, which knows what a 403 means.
 */
async function fetchDefinitionById(client: AxiosInstance, sysId: string | undefined) {
  if (!sysId) return {}
  const response = await client
    .get(`${DEFINITION_TABLE}/${sysId}`, { params: { sysparm_fields: DEFINITION_FIELDS } })
    .catch((error: unknown) => {
      if (statusOf(error) === 404) return null
      throw error
    })
  return rec(rec(response?.data).result)
}

const summariseDefinition = (definition: Record<string, unknown>) => ({
  sys_id: str(definition.sys_id),
  name: str(definition.name),
  api_id: str(definition.service_id),
  namespace: str(definition.namespace),
  base_uri: str(definition.base_uri),
  short_description: str(definition.short_description),
  active: definition.active === "true" || definition.active === true,
})

const summariseOperation = (operation: Record<string, unknown>) => ({
  sys_id: str(operation.sys_id),
  name: str(operation.name),
  http_method: str(operation.http_method),
  relative_path: str(operation.relative_path),
  operation_uri: str(operation.operation_uri),
  active: operation.active === "true" || operation.active === true,
  requires_authentication: operation.requires_authentication === "true" || operation.requires_authentication === true,
  // Tri-state on purpose, unlike the two above: those are columns scripted-exec
  // proves exist, this one is not, so `undefined` ("the instance did not return
  // it") has to stay distinguishable from `false` ("the instance says it is off").
  requires_acl_authorization: flag(operation.requires_acl_authorization),
})

/**
 * Resource scripts run on ServiceNow's server-side engine, which is ES5 (Rhino).
 * Reported, not enforced: the record saves either way, and mis-flagging a
 * caller's valid script into a hard failure would be worse than a warning.
 */
const ES5_PATTERNS = [
  { type: "const", regex: /\bconst\s+/g },
  { type: "let", regex: /\blet\s+/g },
  { type: "arrow_function", regex: /=>\s*[{(]/g },
  { type: "template_literal", regex: /`[^`]*`/g },
  { type: "class", regex: /\bclass\s+\w+/g },
]

function es5Warnings(script: string): string[] {
  const violations = ES5_PATTERNS.flatMap((pattern) =>
    Array.from(script.matchAll(pattern.regex), (match) => ({
      type: pattern.type,
      line: script.slice(0, match.index ?? 0).split("\n").length,
    })),
  )
  if (violations.length === 0) return []
  return [
    `operation_script contains ES6+ syntax (${violations.map((violation) => `${violation.type} at line ${violation.line}`).join(", ")}). ServiceNow's server-side engine is ES5 — use var and function() instead. The record was saved as given.`,
  ]
}

const normalisePath = (path: string | undefined) => {
  if (!path || path === "/") return "/"
  return path.startsWith("/") ? path : `/${path}`
}

const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined)
const num = (value: unknown) => (typeof value === "number" ? value : undefined)
// Agents routinely stringify booleans, so "true"/"false" are accepted alongside
// the real thing — same reasoning as confirmationFlag() in update-set-guard.ts.
const bool = (value: unknown, fallback: boolean) => {
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  return fallback
}
// Same coercion for a value read back off a record, except that "the field was
// not in the response" stays undefined instead of becoming a claim about it.
const flag = (value: unknown) => {
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  return undefined
}
const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {}
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
// Reference fields come back as { link, value } unless sysparm_fields flattened them.
const refValue = (value: unknown) => str(value) ?? str(rec(value).value)
const statusOf = (error: unknown) => {
  const status = rec(rec(error).response).status
  return typeof status === "number" ? status : undefined
}
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const version = "1.0.0"
export const author = "Serac"
