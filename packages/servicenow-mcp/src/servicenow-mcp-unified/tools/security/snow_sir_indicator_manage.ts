/**
 * snow_sir_indicator_manage - Unified Indicator of Compromise (IOC) lifecycle for SIR / Threat Intelligence
 *
 * Manages the IOC catalogue used by Security Incident Response and the
 * Threat Intelligence subapp. Wraps the observable and indicator tables
 * (sn_ti_observable, sn_ti_indicator) where IOCs are persisted, looked up,
 * linked to incidents, and aged out.
 *
 * Companion to snow_analyze_threat_intelligence (which correlates a single
 * IOC against feeds in a one-shot read-only call). This tool focuses on
 * the persistent lifecycle — creating IOC records, marking them
 * active/resolved, linking them to incidents, and searching by value.
 *
 * Table-name volatility note: across SN releases the IOC table has been
 * `sn_ti_observable`, `sn_ti_indicator`, and `sn_si_observable`. This
 * tool defaults to sn_ti_observable and falls back to sn_si_observable
 * if the first 404s. Mark all uncertain table names with TODO: verify.
 *
 * Requires either the Threat Intelligence application or the Security
 * Incident Response plugin (com.snc.security_incident). A 404 on both
 * fallback tables is surfaced as a plugin-missing error.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

const SIR_PLUGIN = "com.snc.security_incident"
// Primary IOC observable table. TODO: verify against a live instance.
const TI_OBSERVABLE_TABLE = "sn_ti_observable"
// Fallback when sn_ti_observable is not present on the instance.
// TODO: verify sn_si_observable on releases that ship the SIR plugin without Threat Intel.
const SI_OBSERVABLE_TABLE_FALLBACK = "sn_si_observable"
// Higher-level indicator (groups observables under a single intel record).
// TODO: verify sn_ti_indicator on a live instance.
const TI_INDICATOR_TABLE = "sn_ti_indicator"
const SIR_INCIDENT_TABLE = "sn_si_incident"
// Join table used to attach observables/indicators to incidents.
// TODO: verify against a live instance — release-dependent.
const SIR_INCIDENT_OBSERVABLE_JOIN = "sn_si_m2m_observable_incident"

// IOC state values used by the SIR/TI tables. The exact codes vary by
// release; values are passed as strings to let the platform coerce.
const IOC_STATE = {
  active: "active",
  resolved: "resolved",
}

export const toolDefinition: MCPToolDefinition = {
  name: "snow_sir_indicator_manage",
  description: `Unified tool for the Indicator of Compromise (IOC) lifecycle on sn_ti_observable, sn_ti_indicator, and the SIR observable join table. Manages persistent IOC records — distinct from snow_analyze_threat_intelligence, which only correlates a single IOC against feeds without persisting state.

Actions:
- create_ioc — create a new IOC record (value, type, finding required) on sn_ti_observable
- list_iocs — list IOCs, optionally filtered by type, state, source, or seen-since
- link_to_incident — link an existing IOC to a SIR incident via the observable-incident join table
- mark_active — mark an IOC active (re-open after resolution)
- mark_resolved — mark an IOC resolved (closed, no longer interesting)
- search_by_value — find IOCs by exact or fragment match on value (IP, domain, hash, URL, email)

Use when: the agent needs to manage persistent IOC records — open a new IOC after triage, attach existing IOCs to a new incident, search for prior sightings of a value, or close out an IOC after eradication. Companion tools: snow_analyze_threat_intelligence (one-shot feed correlation), snow_sir_incident_manage (parent incident lifecycle), snow_sir_evidence_manage (evidence chain of custody).

Table-name volatility: the IOC table name varies by SN release (sn_ti_observable / sn_ti_indicator / sn_si_observable). This tool defaults to sn_ti_observable and falls back to sn_si_observable if the primary table is absent.

Plugin gating: requires either Threat Intelligence or the Security Incident Response plugin (com.snc.security_incident). A 404 on both fallback tables is surfaced with the required plugin name.

Returns: action-specific data. create_ioc returns the created record. list_iocs / search_by_value return arrays of IOCs with value, type, state, source, last_seen. link_to_incident returns the join-row sys_id. mark_active / mark_resolved return the updated record.`,
  category: "security",
  subcategory: "threat-intelligence",
  use_cases: ["sir", "threat-intelligence", "ioc", "indicators", "security"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Indicator management action to perform",
        enum: [
          "create_ioc",
          "list_iocs",
          "link_to_incident",
          "mark_active",
          "mark_resolved",
          "search_by_value",
        ],
      },
      // Identifiers
      sys_id: {
        type: "string",
        description: "[link_to_incident/mark_active/mark_resolved] sys_id of the IOC observable record",
      },
      incident_sys_id: {
        type: "string",
        description: "[link_to_incident] sys_id of the SIR incident the IOC should be attached to",
      },
      incident_number: {
        type: "string",
        description: "[link_to_incident] SIR incident number (e.g. SIR0010001), alternative to incident_sys_id",
      },
      // CREATE_IOC
      ioc_value: {
        type: "string",
        description: "[create_ioc/search_by_value] The IOC value (IP, domain, hash, URL, email, file path)",
      },
      ioc_type: {
        type: "string",
        description: "[create_ioc/list_iocs/search_by_value] IOC type",
        enum: [
          "ip",
          "domain",
          "url",
          "email",
          "hash_md5",
          "hash_sha1",
          "hash_sha256",
          "file_path",
          "user_agent",
          "registry_key",
        ],
      },
      finding: {
        type: "string",
        description: "[create_ioc] Why this IOC is interesting (one-line finding / context)",
      },
      source: {
        type: "string",
        description: "[create_ioc/list_iocs] Source of the IOC (SIEM, EDR, threat feed name, manual)",
      },
      confidence: {
        type: "string",
        description: "[create_ioc] Confidence level",
        enum: ["low", "medium", "high"],
      },
      tlp: {
        type: "string",
        description: "[create_ioc] Traffic Light Protocol marking",
        enum: ["white", "green", "amber", "red"],
      },
      // LIST / SEARCH filters
      state_filter: {
        type: "string",
        description: "[list_iocs] Filter by IOC state",
        enum: ["active", "resolved"],
      },
      seen_since: {
        type: "string",
        description: "[list_iocs] Filter by last-seen date (encoded query date >= YYYY-MM-DD)",
      },
      match_mode: {
        type: "string",
        description: "[search_by_value] How to match the value",
        enum: ["exact", "contains", "starts_with"],
        default: "exact",
      },
      limit: {
        type: "number",
        description: "[list_iocs/search_by_value] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list_iocs/search_by_value] Comma-separated list of fields to return",
      },
      // MARK transitions
      note: {
        type: "string",
        description: "[mark_active/mark_resolved] Optional work note describing the state change",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "create_ioc":
        return await executeCreateIoc(args, context)
      case "list_iocs":
        return await executeListIocs(args, context)
      case "link_to_incident":
        return await executeLinkToIncident(args, context)
      case "mark_active":
        return await executeMarkState(args, context, IOC_STATE.active)
      case "mark_resolved":
        return await executeMarkState(args, context, IOC_STATE.resolved)
      case "search_by_value":
        return await executeSearchByValue(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: create_ioc, list_iocs, link_to_incident, mark_active, mark_resolved, search_by_value`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `SIR indicator ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

/**
 * Wraps a Table API call that targets the IOC observable table. Falls back
 * from sn_ti_observable to sn_si_observable on 404 so this tool keeps
 * working across SN releases that ship one but not the other. Returns
 * the resolved table name alongside the call result so the caller can
 * reuse it for subsequent calls on the same record.
 */
async function callOnObservableTable<T>(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  invoke: (table: string) => Promise<T>,
): Promise<{ result: T; table: string }> {
  try {
    const result = await invoke(TI_OBSERVABLE_TABLE)
    return { result, table: TI_OBSERVABLE_TABLE }
  } catch (err: unknown) {
    const e = err as { response?: { status?: number } }
    if (e?.response?.status === 404) {
      try {
        const result = await invoke(SI_OBSERVABLE_TABLE_FALLBACK)
        return { result, table: SI_OBSERVABLE_TABLE_FALLBACK }
      } catch (err2: unknown) {
        const e2 = err2 as { response?: { status?: number }; message?: string }
        if (e2?.response?.status === 404) {
          throw new SnowFlowError(
            ErrorType.PLUGIN_MISSING,
            `Neither ${TI_OBSERVABLE_TABLE} nor ${SI_OBSERVABLE_TABLE_FALLBACK} was found on this instance. Activate the Security Incident Response plugin (${SIR_PLUGIN}) or the Threat Intelligence application under System Definition > Plugins.`,
            {
              details: {
                plugin: SIR_PLUGIN,
                tried_tables: [TI_OBSERVABLE_TABLE, SI_OBSERVABLE_TABLE_FALLBACK],
              },
            },
          )
        }
        throw new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, e2.message || "IOC API call failed", {
          originalError: err2 as Error,
        })
      }
    }
    throw new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, (err as Error).message || "IOC API call failed", {
      originalError: err as Error,
    })
  }
}

async function resolveIncidentSysId(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  incidentSysId: string | undefined,
  incidentNumber: string | undefined,
): Promise<string | null> {
  if (incidentSysId) return incidentSysId
  if (incidentNumber) {
    const search = await client.get(`/api/now/table/${SIR_INCIDENT_TABLE}`, {
      params: { sysparm_query: `number=${incidentNumber}`, sysparm_limit: 1, sysparm_fields: "sys_id" },
    })
    const results = (search.data.result || []) as Array<Record<string, unknown>>
    if (results.length > 0) return results[0].sys_id as string
  }
  return null
}

// ==================== CREATE_IOC ====================

async function executeCreateIoc(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const ioc_value = args.ioc_value as string | undefined
  const ioc_type = args.ioc_type as string | undefined
  const finding = args.finding as string | undefined
  const source = args.source as string | undefined
  const confidence = args.confidence as string | undefined
  const tlp = args.tlp as string | undefined

  if (!ioc_value) return createErrorResult("ioc_value is required for create_ioc action")
  if (!ioc_type) return createErrorResult("ioc_type is required for create_ioc action")
  if (!finding) return createErrorResult("finding is required for create_ioc action")

  const client = await getAuthenticatedClient(context)

  const payload: Record<string, unknown> = {
    value: ioc_value,
    type: ioc_type,
    finding,
    state: IOC_STATE.active,
  }
  if (source) payload.source = source
  if (confidence) payload.confidence = confidence
  if (tlp) payload.tlp = tlp

  const { result, table } = await callOnObservableTable(client, async (t) => {
    const response = await client.post(`/api/now/table/${t}`, payload)
    return response.data.result as Record<string, unknown>
  })

  return createSuccessResult({
    action: "create_ioc",
    created: true,
    sys_id: result.sys_id,
    table,
    ioc: result,
    url: `${context.instanceUrl}/nav_to.do?uri=${table}.do?sys_id=${result.sys_id}`,
  })
}

// ==================== LIST_IOCS ====================

async function executeListIocs(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const ioc_type = args.ioc_type as string | undefined
  const state_filter = args.state_filter as string | undefined
  const source = args.source as string | undefined
  const seen_since = args.seen_since as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (ioc_type) queryParts.push(`type=${ioc_type}`)
  if (state_filter) queryParts.push(`state=${state_filter}`)
  if (source) queryParts.push(`source=${source}`)
  if (seen_since) queryParts.push(`last_seen>=${seen_since}`)

  const { result, table } = await callOnObservableTable(client, async (t) => {
    const response = await client.get(`/api/now/table/${t}`, {
      params: {
        sysparm_query: queryParts.join("^"),
        sysparm_limit: limit,
        sysparm_orderby: "sys_updated_on",
        sysparm_display_value: "true",
        ...(fields
          ? { sysparm_fields: fields }
          : {
              sysparm_fields:
                "sys_id,value,type,state,source,confidence,tlp,finding,last_seen,sys_created_on,sys_updated_on",
            }),
      },
    })
    return (response.data.result || []) as Array<Record<string, unknown>>
  })

  return createSuccessResult({
    action: "list_iocs",
    count: result.length,
    table,
    iocs: result.map((r) => ({
      sys_id: r.sys_id,
      value: r.value,
      type: r.type,
      state: r.state,
      source: r.source,
      confidence: r.confidence,
      tlp: r.tlp,
      finding: r.finding,
      last_seen: r.last_seen,
      created_at: r.sys_created_on,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${table}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== LINK_TO_INCIDENT ====================

async function executeLinkToIncident(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const incident_sys_id = args.incident_sys_id as string | undefined
  const incident_number = args.incident_number as string | undefined

  if (!sys_id) return createErrorResult("sys_id (IOC sys_id) is required for link_to_incident action")
  if (!incident_sys_id && !incident_number) {
    return createErrorResult("incident_sys_id or incident_number is required for link_to_incident action")
  }

  const client = await getAuthenticatedClient(context)
  const incidentSysId = await resolveIncidentSysId(client, incident_sys_id, incident_number)
  if (!incidentSysId) {
    return createErrorResult(`SIR incident not found: ${incident_sys_id || incident_number}`)
  }

  // Try the documented m2m join table first.
  // TODO: verify sn_si_m2m_observable_incident on a live instance — the join
  // table name has varied: sn_si_m2m_observable_incident, sn_ti_m2m_indicator_incident.
  try {
    const linkResponse = await client.post(`/api/now/table/${SIR_INCIDENT_OBSERVABLE_JOIN}`, {
      observable: sys_id,
      incident: incidentSysId,
    })
    const link = linkResponse.data.result as Record<string, unknown>
    return createSuccessResult({
      action: "link_to_incident",
      linked: true,
      link_sys_id: link.sys_id,
      ioc_sys_id: sys_id,
      incident_sys_id: incidentSysId,
      join_table: SIR_INCIDENT_OBSERVABLE_JOIN,
    })
  } catch (err: unknown) {
    const e = err as { response?: { status?: number }; message?: string }
    if (e?.response?.status === 404) {
      return createErrorResult(
        new SnowFlowError(
          ErrorType.PLUGIN_MISSING,
          `IOC join table ${SIR_INCIDENT_OBSERVABLE_JOIN} not found. The observable-to-incident relationship may use a different join table on this release. Activate the Security Incident Response plugin (${SIR_PLUGIN}) and verify the join table name.`,
          { details: { plugin: SIR_PLUGIN, tried_table: SIR_INCIDENT_OBSERVABLE_JOIN } },
        ),
      )
    }
    throw new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, e.message || "Failed to link IOC", {
      originalError: err as Error,
    })
  }
}

// ==================== MARK_ACTIVE / MARK_RESOLVED ====================

async function executeMarkState(
  args: Record<string, unknown>,
  context: ServiceNowContext,
  state: string,
): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const note = args.note as string | undefined

  if (!sys_id) return createErrorResult("sys_id is required for mark_active / mark_resolved actions")

  const client = await getAuthenticatedClient(context)

  const patch: Record<string, unknown> = { state }
  if (note) patch.work_notes = note

  const { result, table } = await callOnObservableTable(client, async (t) => {
    const response = await client.patch(`/api/now/table/${t}/${sys_id}`, patch)
    return response.data.result as Record<string, unknown>
  })

  return createSuccessResult({
    action: state === IOC_STATE.active ? "mark_active" : "mark_resolved",
    updated: true,
    sys_id,
    table,
    state: result.state,
    ioc: result,
    url: `${context.instanceUrl}/nav_to.do?uri=${table}.do?sys_id=${sys_id}`,
  })
}

// ==================== SEARCH_BY_VALUE ====================

async function executeSearchByValue(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const ioc_value = args.ioc_value as string | undefined
  const ioc_type = args.ioc_type as string | undefined
  const match_mode = (args.match_mode as string | undefined) || "exact"
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  if (!ioc_value) return createErrorResult("ioc_value is required for search_by_value action")

  const client = await getAuthenticatedClient(context)

  const valueOperator =
    match_mode === "contains" ? "valueLIKE" : match_mode === "starts_with" ? "valueSTARTSWITH" : "value="
  const queryParts: string[] = [`${valueOperator}${ioc_value}`]
  if (ioc_type) queryParts.push(`type=${ioc_type}`)

  // Search across both observable tables so callers don't need to know
  // which one the instance uses. Skip silently when one returns 404.
  const tables = [TI_OBSERVABLE_TABLE, SI_OBSERVABLE_TABLE_FALLBACK, TI_INDICATOR_TABLE]
  const hits: Array<Record<string, unknown>> = []
  const triedTables: Array<{ table: string; count: number; error?: string }> = []

  for (const t of tables) {
    try {
      const response = await client.get(`/api/now/table/${t}`, {
        params: {
          sysparm_query: queryParts.join("^"),
          sysparm_limit: limit,
          sysparm_orderby: "sys_updated_on",
          sysparm_display_value: "true",
          ...(fields
            ? { sysparm_fields: fields }
            : { sysparm_fields: "sys_id,value,type,state,source,confidence,last_seen,sys_updated_on" }),
        },
      })
      const rows = (response.data.result || []) as Array<Record<string, unknown>>
      triedTables.push({ table: t, count: rows.length })
      for (const r of rows) {
        hits.push({
          ...r,
          _source_table: t,
          url: `${context.instanceUrl}/nav_to.do?uri=${t}.do?sys_id=${r.sys_id}`,
        })
      }
    } catch (err: unknown) {
      const e = err as { response?: { status?: number }; message?: string }
      triedTables.push({ table: t, count: 0, error: e?.response?.status === 404 ? "table_not_found" : (e?.message || "error") })
    }
  }

  if (triedTables.every((t) => t.error === "table_not_found")) {
    return createErrorResult(
      new SnowFlowError(
        ErrorType.PLUGIN_MISSING,
        `No IOC tables found on this instance. Tried ${tables.join(", ")}. Activate the Security Incident Response plugin (${SIR_PLUGIN}) or the Threat Intelligence application.`,
        { details: { plugin: SIR_PLUGIN, tried_tables: tables } },
      ),
    )
  }

  return createSuccessResult({
    action: "search_by_value",
    count: hits.length,
    match_mode,
    tried_tables: triedTables,
    iocs: hits,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
