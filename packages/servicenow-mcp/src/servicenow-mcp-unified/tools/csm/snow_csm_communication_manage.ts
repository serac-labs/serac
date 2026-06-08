/**
 * snow_csm_communication_manage - Unified CSM interaction management
 *
 * Wraps the interaction lifecycle: interaction (the customer-facing
 * communication record), interaction_related_record (joins an interaction
 * to one or more parent records like a CSM case), and the channel-specific
 * communication tables (email, chat, phone) reachable through them.
 *
 * Companion to snow_create_customer_case — that tool opens the case, and
 * this tool logs the email/chat/call interactions that drive the case
 * forward and links them back to it.
 *
 * Requires the Customer Service Management plugin (com.sn_customerservice).
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_csm_communication_manage",
  description: `Unified tool for ServiceNow CSM customer interactions. Wraps the interaction table (emails, chats, calls), interaction_related_record (case links), and channel-specific records reachable through them.

Actions:
- list — list interactions filtered by account, channel, state, or date
- get — fetch a single interaction by sys_id with linked records
- log_interaction — create a new interaction record (channel, direction, body, opened_for, account, contact)
- link_to_case — attach an existing interaction to a CSM case via interaction_related_record
- list_for_case — list every interaction linked to a given case
- list_by_channel — list interactions for a channel (email, chat, phone) within an optional date range

Use when: the agent needs to log or audit customer communications around a CSM case. Companion tools: snow_create_customer_case (opens the case), snow_csm_contract_manage (defines what the customer is entitled to). For internal IT communications use the platform's sys_email tools instead.

Requires com.sn_customerservice. When the plugin is missing the underlying tables don't exist and the tool returns a clear plugin-missing error.`,
  category: "itsm",
  subcategory: "csm",
  use_cases: ["customer-service", "interactions", "communications", "csm"],
  complexity: "intermediate",
  frequency: "high",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Management action to perform",
        enum: ["list", "get", "log_interaction", "link_to_case", "list_for_case", "list_by_channel"],
      },
      // Identification
      sys_id: {
        type: "string",
        description: "[get/link_to_case] interaction sys_id",
      },
      number: {
        type: "string",
        description: "[get] Interaction number (alternative to sys_id)",
      },
      case_sys_id: {
        type: "string",
        description: "[link_to_case/list_for_case] sn_customerservice_case sys_id",
      },
      // Filtering
      account: {
        type: "string",
        description: "[list/log_interaction] Customer account sys_id",
      },
      contact: {
        type: "string",
        description: "[list/log_interaction] Customer contact sys_id",
      },
      channel: {
        type: "string",
        description: "[list/log_interaction/list_by_channel] Communication channel",
        enum: ["email", "chat", "phone", "sms", "social", "web", "walk-in"],
      },
      state: {
        type: "string",
        description: "[list] Interaction state filter (new, work_in_progress, on_hold, closed_complete)",
      },
      from_date: {
        type: "string",
        description: "[list/list_by_channel] Earliest opened_at date filter (YYYY-MM-DD)",
      },
      // LOG_INTERACTION fields
      short_description: {
        type: "string",
        description: "[log_interaction] Subject/short_description for the interaction",
      },
      direction: {
        type: "string",
        description: "[log_interaction] Communication direction",
        enum: ["inbound", "outbound"],
      },
      body: {
        type: "string",
        description: "[log_interaction] Free-text body or comment captured on the interaction",
      },
      opened_for: {
        type: "string",
        description: "[log_interaction] sys_user the interaction was opened for",
      },
      assigned_to: {
        type: "string",
        description: "[log_interaction] Agent (sys_user) handling the interaction",
      },
      // LIST
      limit: {
        type: "number",
        description: "[list/list_for_case/list_by_channel] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list/get/list_for_case/list_by_channel] Comma-separated list of fields to return",
      },
    },
    required: ["action"],
  },
}

const INTERACTION_TABLE = "interaction"
const INTERACTION_RELATED_TABLE = "interaction_related_record"

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list":
        return await executeList(args, context)
      case "get":
        return await executeGet(args, context)
      case "log_interaction":
        return await executeLogInteraction(args, context)
      case "link_to_case":
        return await executeLinkToCase(args, context)
      case "list_for_case":
        return await executeListForCase(args, context)
      case "list_by_channel":
        return await executeListByChannel(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list, get, log_interaction, link_to_case, list_for_case, list_by_channel`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error & { response?: { status?: number } }
    if (err.response?.status === 404 || /Invalid table/i.test(err.message || "")) {
      return createErrorResult(
        new SnowFlowError(
          ErrorType.PLUGIN_MISSING,
          `CSM interaction tables not found. Install the com.sn_customerservice plugin and verify ${INTERACTION_TABLE} exists.`,
          { originalError: err },
        ),
      )
    }
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `CSM communication ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== LIST ====================

async function executeList(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const account = args.account as string | undefined
  const contact = args.contact as string | undefined
  const channel = args.channel as string | undefined
  const state = args.state as string | undefined
  const from_date = args.from_date as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  // The base interaction table has no `account` or `contact` columns. CSM-specific
  // attributes typically extend interaction via a child table (sn_customerservice_interaction)
  // when the plugin is installed. Filter only on the columns guaranteed to exist on
  // the base interaction table; surface account/contact as-is for callers extending the schema.
  const queryParts: string[] = []
  if (channel) queryParts.push(`channel=${channel}`)
  if (state) queryParts.push(`state=${state}`)
  if (from_date) queryParts.push(`opened_at>=${from_date}`)
  if (account) queryParts.push(`opened_for=${account}`)
  if (contact) queryParts.push(`opened_for=${contact}`)

  const response = await client.get(`/api/now/table/${INTERACTION_TABLE}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "opened_at",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,number,short_description,channel,state,direction,opened_for,assignment_group,assigned_to,opened_at" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>
  return createSuccessResult({
    action: "list",
    count: results.length,
    interactions: results.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      short_description: r.short_description,
      channel: r.channel,
      state: r.state,
      direction: r.direction,
      opened_for: r.opened_for,
      assignment_group: r.assignment_group,
      assigned_to: r.assigned_to,
      opened_at: r.opened_at,
      url: `${context.instanceUrl}/nav_to.do?uri=${INTERACTION_TABLE}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== GET ====================

async function executeGet(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const number = args.number as string | undefined
  if (!sys_id && !number) return createErrorResult("sys_id or number is required for get")

  const client = await getAuthenticatedClient(context)
  const interaction = await findInteraction(client, sys_id, number)
  if (!interaction) return createErrorResult(`Interaction not found: ${sys_id || number}`)

  const interactionSysId = interaction.sys_id as string

  // Pull linked records (best-effort). interaction_related_record uses
  // document_table + document_id to point at the parent record.
  let linkedRecords: Array<Record<string, unknown>> = []
  try {
    const linksResponse = await client.get(`/api/now/table/${INTERACTION_RELATED_TABLE}`, {
      params: {
        sysparm_query: `interaction=${interactionSysId}`,
        sysparm_fields: "sys_id,document_table,document_id,type",
        sysparm_limit: 50,
      },
    })
    linkedRecords = (linksResponse.data.result || []) as Array<Record<string, unknown>>
  } catch {
    // Best-effort — older releases may not expose interaction_related_record.
  }

  return createSuccessResult({
    action: "get",
    sys_id: interactionSysId,
    interaction,
    linked_records: linkedRecords,
    url: `${context.instanceUrl}/nav_to.do?uri=${INTERACTION_TABLE}.do?sys_id=${interactionSysId}`,
  })
}

// ==================== LOG_INTERACTION ====================

async function executeLogInteraction(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const channel = args.channel as string | undefined
  const short_description = args.short_description as string | undefined

  if (!channel) return createErrorResult("channel is required for log_interaction")
  if (!short_description) return createErrorResult("short_description is required for log_interaction")

  const client = await getAuthenticatedClient(context)

  // Canonical interaction columns. The base interaction table has no `account` or `contact`
  // columns — those exist only on plugin-extended children. `opened_for` is the closest
  // base-table analogue. `body` is captured as work_notes (the journal column).
  // interaction.type is mandatory and uses a constrained choice list (phone/chat/messaging/video);
  // map our broader `channel` value onto it where possible.
  const channelToType: Record<string, string> = {
    phone: "phone",
    chat: "chat",
    sms: "messaging",
    email: "messaging",
    social: "messaging",
    web: "messaging",
    "walk-in": "phone",
  }
  const payload: Record<string, unknown> = {
    channel,
    type: channelToType[channel] || "phone",
    state: "new",
    short_description,
  }
  if (args.direction) payload.direction = args.direction
  // Map account/contact onto opened_for as a best-effort base-table fallback.
  if (args.opened_for) payload.opened_for = args.opened_for
  else if (args.account) payload.opened_for = args.account
  else if (args.contact) payload.opened_for = args.contact
  if (args.assigned_to) payload.assigned_to = args.assigned_to
  if (args.body) payload.work_notes = args.body

  const response = await client.post(`/api/now/table/${INTERACTION_TABLE}`, payload)
  const created = response.data.result as Record<string, unknown>

  // If a case_sys_id was supplied, link immediately
  let linkSysId: string | null = null
  const case_sys_id = args.case_sys_id as string | undefined
  if (case_sys_id) {
    try {
      const linkResponse = await client.post(`/api/now/table/${INTERACTION_RELATED_TABLE}`, {
        interaction: created.sys_id,
        document_table: "sn_customerservice_case",
        document_id: case_sys_id,
      })
      linkSysId = linkResponse.data.result.sys_id
    } catch {
      // Caller can retry via link_to_case
    }
  }

  return createSuccessResult({
    action: "log_interaction",
    created: true,
    sys_id: created.sys_id,
    channel,
    interaction: created,
    case_link_sys_id: linkSysId,
    url: `${context.instanceUrl}/nav_to.do?uri=${INTERACTION_TABLE}.do?sys_id=${created.sys_id}`,
  })
}

// ==================== LINK_TO_CASE ====================

async function executeLinkToCase(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const case_sys_id = args.case_sys_id as string | undefined

  if (!sys_id) return createErrorResult("sys_id (interaction) is required for link_to_case")
  if (!case_sys_id) return createErrorResult("case_sys_id is required for link_to_case")

  const client = await getAuthenticatedClient(context)

  // interaction_related_record uses document_table + document_id (not related_record_*)
  const response = await client.post(`/api/now/table/${INTERACTION_RELATED_TABLE}`, {
    interaction: sys_id,
    document_table: "sn_customerservice_case",
    document_id: case_sys_id,
  })
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "link_to_case",
    linked: true,
    sys_id: created.sys_id,
    interaction_sys_id: sys_id,
    case_sys_id,
    link: created,
  })
}

// ==================== LIST_FOR_CASE ====================

async function executeListForCase(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const case_sys_id = args.case_sys_id as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  if (!case_sys_id) return createErrorResult("case_sys_id is required for list_for_case")

  const client = await getAuthenticatedClient(context)

  // interaction_related_record links use document_table + document_id (not related_record_*)
  const linksResponse = await client.get(`/api/now/table/${INTERACTION_RELATED_TABLE}`, {
    params: {
      sysparm_query: `document_id=${case_sys_id}^document_table=sn_customerservice_case`,
      sysparm_fields: "sys_id,interaction",
      sysparm_limit: limit,
    },
  })
  const links = (linksResponse.data.result || []) as Array<Record<string, unknown>>

  const interactionIds = links
    .map((l) => {
      const ref = l.interaction
      if (typeof ref === "string") return ref
      if (ref && typeof ref === "object" && "value" in ref) return (ref as { value: string }).value
      return null
    })
    .filter((v): v is string => typeof v === "string" && v.length > 0)

  if (interactionIds.length === 0) {
    return createSuccessResult({
      action: "list_for_case",
      case_sys_id,
      count: 0,
      interactions: [],
    })
  }

  const interactionsResponse = await client.get(`/api/now/table/${INTERACTION_TABLE}`, {
    params: {
      sysparm_query: `sys_idIN${interactionIds.join(",")}`,
      sysparm_limit: limit,
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,number,short_description,channel,state,direction,opened_at" }),
    },
  })
  const interactions = (interactionsResponse.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_for_case",
    case_sys_id,
    count: interactions.length,
    interactions: interactions.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      short_description: r.short_description,
      channel: r.channel,
      state: r.state,
      direction: r.direction,
      opened_at: r.opened_at,
      url: `${context.instanceUrl}/nav_to.do?uri=${INTERACTION_TABLE}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== LIST_BY_CHANNEL ====================

async function executeListByChannel(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const channel = args.channel as string | undefined
  const from_date = args.from_date as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  if (!channel) return createErrorResult("channel is required for list_by_channel")

  const client = await getAuthenticatedClient(context)

  const queryParts = [`channel=${channel}`]
  if (from_date) queryParts.push(`opened_at>=${from_date}`)

  const response = await client.get(`/api/now/table/${INTERACTION_TABLE}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "opened_at",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,number,short_description,channel,state,direction,opened_for,opened_at" }),
    },
  })
  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_by_channel",
    channel,
    count: results.length,
    interactions: results.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      short_description: r.short_description,
      state: r.state,
      direction: r.direction,
      opened_for: r.opened_for,
      opened_at: r.opened_at,
      url: `${context.instanceUrl}/nav_to.do?uri=${INTERACTION_TABLE}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== HELPERS ====================

async function findInteraction(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string | undefined,
  number: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (sysId) {
    const direct = await client.get(`/api/now/table/${INTERACTION_TABLE}/${sysId}`)
    if (direct.data.result && direct.data.result.sys_id) return direct.data.result
  }
  if (number) {
    const search = await client.get(`/api/now/table/${INTERACTION_TABLE}`, {
      params: { sysparm_query: `number=${number}`, sysparm_limit: 1 },
    })
    const results = (search.data.result || []) as Array<Record<string, unknown>>
    if (results.length > 0) return results[0]
  }
  return null
}

export const version = "1.0.0"
export const author = "groeimetai"
