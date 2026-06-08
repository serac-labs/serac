/**
 * snow_grc_audit_manage - Unified GRC Audit Management lifecycle
 *
 * Manages the ServiceNow Audit Management (GRC) lifecycle: engagements,
 * audits, findings, and audit evidence. Wraps the audit tables that ship
 * with the GRC: Audit Management plugin (sn_audit_audit, sn_audit_finding,
 * sn_audit_engagement, sn_audit_evidence).
 *
 * Companion to snow_compliance_manage (policy exceptions and control
 * evidence) and snow_create_audit_rule (audit rule authoring). This tool
 * focuses on the audit lifecycle itself — opening an audit engagement,
 * tracking individual audits inside the engagement, logging findings, and
 * attaching evidence to support the findings.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

// TODO: verify against a live instance. The GRC Audit Management plugin
// has shipped audit tables under `sn_audit_*` since Tokyo. Some older
// implementations and certain Now Platform variants expose the same data
// under `sn_grc_audit_*`. Detect and fall back if needed.
const TABLE_AUDIT = "sn_audit_audit"
const TABLE_FINDING = "sn_audit_finding"
const TABLE_ENGAGEMENT = "sn_audit_engagement"
const TABLE_EVIDENCE = "sn_audit_evidence"

const PLUGIN_NAME = "GRC: Audit Management (com.sn_audit)"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_grc_audit_manage",
  description: `Unified tool for ServiceNow GRC Audit Management: engagements, audits, findings, and evidence. Wraps the sn_audit_audit, sn_audit_finding, sn_audit_engagement, and sn_audit_evidence tables that ship with the GRC: Audit Management plugin.

Actions:
- list — list audits, optionally filtered by engagement, state, or auditor
- get — retrieve a single audit by sys_id
- create_audit — open a new audit inside an existing engagement
- update_audit — patch fields on an existing audit (state, scope, lead auditor, dates)
- add_finding — log a finding against an audit with severity and recommendation
- list_findings — list findings, optionally filtered by audit, severity, or state
- attach_evidence — attach an evidence record (or external URL) to an audit or finding

Use when: the agent needs to drive an audit engagement end to end — opening individual audits, logging the findings that come out of them, and attaching the evidence collected during fieldwork. For policy and control evidence outside an audit context, use snow_compliance_manage; for risk register operations, use snow_grc_risk_manage.

Returns: audit rows with sys_id, engagement, state, lead auditor, planned and actual dates; finding rows with severity, recommendation, target remediation date; evidence rows with type and reference link. GRC plugin gating: the first call against the audit tables will surface a clear error if the GRC: Audit Management plugin is not active on the target instance.`,
  category: "security",
  subcategory: "audit",
  use_cases: ["grc", "audit", "audit-management", "findings", "evidence"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Management action to perform",
        enum: [
          "list",
          "get",
          "create_audit",
          "update_audit",
          "add_finding",
          "list_findings",
          "attach_evidence",
        ],
      },
      // Identifiers
      sys_id: {
        type: "string",
        description: "[get/update_audit/add_finding/attach_evidence] Audit sys_id",
      },
      engagement_sys_id: {
        type: "string",
        description: "[create_audit/list] Audit engagement sys_id (sn_audit_engagement)",
      },
      finding_sys_id: {
        type: "string",
        description: "[attach_evidence] Finding sys_id when attaching evidence to a specific finding",
      },
      // LIST filters
      state: {
        type: "string",
        description: "[list/list_findings] Filter by state (draft, scheduled, in_progress, completed, closed, cancelled)",
      },
      auditor: {
        type: "string",
        description: "[list] Filter by lead auditor sys_user sys_id",
      },
      severity: {
        type: "string",
        description: "[list_findings] Filter by finding severity",
        enum: ["critical", "high", "medium", "low", "informational"],
      },
      limit: {
        type: "number",
        description: "[list/list_findings] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list/get/list_findings] Comma-separated list of fields to return",
      },
      // CREATE_AUDIT
      short_description: {
        type: "string",
        description: "[create_audit] Short description of the audit",
      },
      description: {
        type: "string",
        description: "[create_audit/update_audit] Long description / scope narrative",
      },
      scope: {
        type: "string",
        description: "[create_audit/update_audit] Audit scope (free text)",
      },
      lead_auditor: {
        type: "string",
        description: "[create_audit/update_audit] Lead auditor sys_user sys_id",
      },
      planned_start_date: {
        type: "string",
        description: "[create_audit/update_audit] ISO date string (YYYY-MM-DD) when the audit is planned to start",
      },
      planned_end_date: {
        type: "string",
        description: "[create_audit/update_audit] ISO date string (YYYY-MM-DD) when the audit is planned to end",
      },
      audit_type: {
        type: "string",
        description: "[create_audit] Audit type label (internal, external, regulatory, sox, soc, iso, custom)",
      },
      // UPDATE_AUDIT
      audit_state: {
        type: "string",
        description: "[update_audit] New audit state",
        enum: ["draft", "scheduled", "in_progress", "completed", "closed", "cancelled"],
      },
      // ADD_FINDING
      finding_short_description: {
        type: "string",
        description: "[add_finding] Short description of the finding",
      },
      finding_description: {
        type: "string",
        description: "[add_finding] Long description / observation detail",
      },
      finding_severity: {
        type: "string",
        description: "[add_finding] Severity rating",
        enum: ["critical", "high", "medium", "low", "informational"],
      },
      recommendation: {
        type: "string",
        description: "[add_finding] Recommended remediation action",
      },
      target_remediation_date: {
        type: "string",
        description: "[add_finding] ISO date string (YYYY-MM-DD) for target remediation",
      },
      assigned_to: {
        type: "string",
        description: "[add_finding] sys_user sys_id of the remediation owner",
      },
      // ATTACH_EVIDENCE
      evidence_type: {
        type: "string",
        description: "[attach_evidence] Evidence type label",
        enum: ["document", "screenshot", "report", "attestation", "log", "interview", "other"],
        default: "document",
      },
      evidence_url: {
        type: "string",
        description: "[attach_evidence] External URL pointing at the evidence (used when no existing sys_id is given)",
      },
      evidence_sys_id: {
        type: "string",
        description: "[attach_evidence] Existing sn_audit_evidence sys_id to link instead of creating a new row",
      },
      evidence_description: {
        type: "string",
        description: "[attach_evidence] Description for the evidence record",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list":
        return await executeList(args, context)
      case "get":
        return await executeGet(args, context)
      case "create_audit":
        return await executeCreateAudit(args, context)
      case "update_audit":
        return await executeUpdateAudit(args, context)
      case "add_finding":
        return await executeAddFinding(args, context)
      case "list_findings":
        return await executeListFindings(args, context)
      case "attach_evidence":
        return await executeAttachEvidence(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list, get, create_audit, update_audit, add_finding, list_findings, attach_evidence`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error & { response?: { status?: number } }
    // Plugin-gating: a 404 on the first audit-table call almost always means
    // the GRC: Audit Management plugin is not active on this instance.
    if (err.response?.status === 404) {
      return createErrorResult(
        new SnowFlowError(
          ErrorType.PLUGIN_MISSING,
          `GRC audit table not found. The ${PLUGIN_NAME} plugin may not be active on this instance. Confirm that sn_audit_audit and sn_audit_finding tables exist.`,
          { originalError: err },
        ),
      )
    }
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `GRC audit ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function findAudit(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string,
): Promise<Record<string, unknown> | null> {
  const direct = await client.get(`/api/now/table/${TABLE_AUDIT}/${sysId}`)
  if (direct.data.result && direct.data.result.sys_id) {
    return direct.data.result
  }
  return null
}

// ==================== LIST ====================

async function executeList(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const engagement_sys_id = args.engagement_sys_id as string | undefined
  const state = args.state as string | undefined
  const auditor = args.auditor as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (engagement_sys_id) queryParts.push(`engagement=${engagement_sys_id}`)
  if (state) queryParts.push(`state=${state}`)
  if (auditor) queryParts.push(`lead_auditor=${auditor}`)

  const response = await client.get(`/api/now/table/${TABLE_AUDIT}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "sys_created_on",
      sysparm_display_value: "true",
      ...(fields
        ? { sysparm_fields: fields }
        : {
            sysparm_fields:
              "sys_id,number,short_description,engagement,state,lead_auditor,audit_type,planned_start_date,planned_end_date,sys_created_on",
          }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list",
    count: results.length,
    audits: results.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      short_description: r.short_description,
      engagement: r.engagement,
      state: r.state,
      lead_auditor: r.lead_auditor,
      audit_type: r.audit_type,
      planned_start_date: r.planned_start_date,
      planned_end_date: r.planned_end_date,
      created_at: r.sys_created_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_AUDIT}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== GET ====================

async function executeGet(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined

  if (!sys_id) {
    return createErrorResult("sys_id is required for get action")
  }

  const client = await getAuthenticatedClient(context)
  const audit = await findAudit(client, sys_id)
  if (!audit) {
    return createErrorResult(`Audit not found: ${sys_id}`)
  }

  // Count related findings for context (best-effort)
  let findingCount = 0
  try {
    const findings = await client.get(`/api/now/table/${TABLE_FINDING}`, {
      params: { sysparm_query: `audit=${sys_id}`, sysparm_fields: "sys_id", sysparm_limit: 500 },
    })
    findingCount = (findings.data.result || []).length
  } catch {
    // TODO: verify finding -> audit reference column on a live instance.
  }

  return createSuccessResult({
    action: "get",
    sys_id,
    audit,
    related: {
      finding_count: findingCount,
    },
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_AUDIT}.do?sys_id=${sys_id}`,
  })
}

// ==================== CREATE_AUDIT ====================

async function executeCreateAudit(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const engagement_sys_id = args.engagement_sys_id as string | undefined
  const short_description = args.short_description as string | undefined

  if (!engagement_sys_id) {
    return createErrorResult("engagement_sys_id is required for create_audit action")
  }
  if (!short_description) {
    return createErrorResult("short_description is required for create_audit action")
  }

  const client = await getAuthenticatedClient(context)

  // Verify the engagement exists before creating an audit under it.
  // TODO: verify sn_audit_engagement reference column name (engagement vs parent) on a live instance.
  const engagementCheck = await client.get(`/api/now/table/${TABLE_ENGAGEMENT}/${engagement_sys_id}`)
  if (!engagementCheck.data.result || !engagementCheck.data.result.sys_id) {
    return createErrorResult(`Audit engagement not found: ${engagement_sys_id}`)
  }

  const payload: Record<string, unknown> = {
    engagement: engagement_sys_id,
    short_description,
    state: "draft",
  }
  if (args.description) payload.description = args.description
  if (args.scope) payload.scope = args.scope
  if (args.lead_auditor) payload.lead_auditor = args.lead_auditor
  if (args.planned_start_date) payload.planned_start_date = args.planned_start_date
  if (args.planned_end_date) payload.planned_end_date = args.planned_end_date
  if (args.audit_type) payload.audit_type = args.audit_type

  const response = await client.post(`/api/now/table/${TABLE_AUDIT}`, payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "create_audit",
    created: true,
    sys_id: created.sys_id,
    audit: created,
    engagement_sys_id,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_AUDIT}.do?sys_id=${created.sys_id}`,
  })
}

// ==================== UPDATE_AUDIT ====================

async function executeUpdateAudit(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined

  if (!sys_id) {
    return createErrorResult("sys_id is required for update_audit action")
  }

  const client = await getAuthenticatedClient(context)
  const audit = await findAudit(client, sys_id)
  if (!audit) {
    return createErrorResult(`Audit not found: ${sys_id}`)
  }

  const updatableFields: Array<[string, string]> = [
    ["description", "description"],
    ["scope", "scope"],
    ["lead_auditor", "lead_auditor"],
    ["planned_start_date", "planned_start_date"],
    ["planned_end_date", "planned_end_date"],
    ["audit_state", "state"],
  ]

  const patch: Record<string, unknown> = {}
  for (const [argKey, fieldName] of updatableFields) {
    if (args[argKey] !== undefined) {
      patch[fieldName] = args[argKey]
    }
  }

  if (Object.keys(patch).length === 0) {
    return createErrorResult("No update fields provided")
  }

  const response = await client.patch(`/api/now/table/${TABLE_AUDIT}/${sys_id}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "update_audit",
    updated: true,
    sys_id,
    updated_fields: Object.keys(patch),
    audit: updated,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_AUDIT}.do?sys_id=${sys_id}`,
  })
}

// ==================== ADD_FINDING ====================

async function executeAddFinding(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const finding_short_description = args.finding_short_description as string | undefined
  const finding_severity = args.finding_severity as string | undefined

  if (!sys_id) {
    return createErrorResult("sys_id (audit sys_id) is required for add_finding action")
  }
  if (!finding_short_description) {
    return createErrorResult("finding_short_description is required for add_finding action")
  }
  if (!finding_severity) {
    return createErrorResult("finding_severity is required for add_finding action")
  }

  const client = await getAuthenticatedClient(context)
  const audit = await findAudit(client, sys_id)
  if (!audit) {
    return createErrorResult(`Audit not found: ${sys_id}`)
  }

  // TODO: verify sn_audit_finding column set on a live instance — some
  // releases use `parent` or `audit_record` rather than `audit` for the
  // reference back to the parent audit.
  const payload: Record<string, unknown> = {
    audit: sys_id,
    short_description: finding_short_description,
    severity: finding_severity,
    state: "open",
  }
  if (args.finding_description) payload.description = args.finding_description
  if (args.recommendation) payload.recommendation = args.recommendation
  if (args.target_remediation_date) payload.target_remediation_date = args.target_remediation_date
  if (args.assigned_to) payload.assigned_to = args.assigned_to

  const response = await client.post(`/api/now/table/${TABLE_FINDING}`, payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "add_finding",
    created: true,
    sys_id: created.sys_id,
    audit: { sys_id, short_description: audit.short_description },
    finding: created,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_FINDING}.do?sys_id=${created.sys_id}`,
  })
}

// ==================== LIST_FINDINGS ====================

async function executeListFindings(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const state = args.state as string | undefined
  const severity = args.severity as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (sys_id) queryParts.push(`audit=${sys_id}`)
  if (state) queryParts.push(`state=${state}`)
  if (severity) queryParts.push(`severity=${severity}`)

  const response = await client.get(`/api/now/table/${TABLE_FINDING}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "sys_created_on",
      sysparm_display_value: "true",
      ...(fields
        ? { sysparm_fields: fields }
        : {
            sysparm_fields:
              "sys_id,number,short_description,audit,severity,state,recommendation,target_remediation_date,assigned_to,sys_created_on",
          }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_findings",
    count: results.length,
    findings: results.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      short_description: r.short_description,
      audit: r.audit,
      severity: r.severity,
      state: r.state,
      recommendation: r.recommendation,
      target_remediation_date: r.target_remediation_date,
      assigned_to: r.assigned_to,
      created_at: r.sys_created_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_FINDING}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== ATTACH_EVIDENCE ====================

async function executeAttachEvidence(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const audit_sys_id = args.sys_id as string | undefined
  const finding_sys_id = args.finding_sys_id as string | undefined
  const evidence_sys_id = args.evidence_sys_id as string | undefined
  const evidence_url = args.evidence_url as string | undefined
  const evidence_type = (args.evidence_type as string) || "document"
  const evidence_description = args.evidence_description as string | undefined

  if (!audit_sys_id && !finding_sys_id) {
    return createErrorResult("sys_id (audit) or finding_sys_id is required for attach_evidence action")
  }
  if (!evidence_sys_id && !evidence_url) {
    return createErrorResult("evidence_sys_id or evidence_url is required for attach_evidence action")
  }

  const client = await getAuthenticatedClient(context)

  // Verify parent exists.
  if (audit_sys_id) {
    const audit = await findAudit(client, audit_sys_id)
    if (!audit) {
      return createErrorResult(`Audit not found: ${audit_sys_id}`)
    }
  }
  if (finding_sys_id) {
    // TODO: verify sn_audit_finding table on a live instance.
    const findingCheck = await client.get(`/api/now/table/${TABLE_FINDING}/${finding_sys_id}`)
    if (!findingCheck.data.result || !findingCheck.data.result.sys_id) {
      return createErrorResult(`Finding not found: ${finding_sys_id}`)
    }
  }

  let evidenceRecord: Record<string, unknown>
  let mode: "linked" | "created_and_linked"

  if (evidence_sys_id) {
    // Patch the audit/finding reference onto the existing evidence row.
    // TODO: verify sn_audit_evidence column set on a live instance — some
    // releases use `audit` and `finding`, others use `parent` with a
    // polymorphic reference.
    const direct = await client.get(`/api/now/table/${TABLE_EVIDENCE}/${evidence_sys_id}`)
    if (!direct.data.result || !direct.data.result.sys_id) {
      return createErrorResult(`Evidence record not found: ${evidence_sys_id}`)
    }
    const patchPayload: Record<string, unknown> = {}
    if (audit_sys_id) patchPayload.audit = audit_sys_id
    if (finding_sys_id) patchPayload.finding = finding_sys_id
    const patchResponse = await client.patch(`/api/now/table/${TABLE_EVIDENCE}/${evidence_sys_id}`, patchPayload)
    evidenceRecord = patchResponse.data.result as Record<string, unknown>
    mode = "linked"
  } else {
    const payload: Record<string, unknown> = {
      type: evidence_type,
      url: evidence_url,
    }
    if (audit_sys_id) payload.audit = audit_sys_id
    if (finding_sys_id) payload.finding = finding_sys_id
    if (evidence_description) payload.description = evidence_description
    const created = await client.post(`/api/now/table/${TABLE_EVIDENCE}`, payload)
    evidenceRecord = created.data.result as Record<string, unknown>
    mode = "created_and_linked"
  }

  return createSuccessResult({
    action: "attach_evidence",
    link_action: mode,
    sys_id: evidenceRecord.sys_id,
    audit_sys_id: audit_sys_id || null,
    finding_sys_id: finding_sys_id || null,
    evidence: evidenceRecord,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
