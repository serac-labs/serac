/**
 * snow_grc_issue_manage - Unified GRC compliance issue and exception management
 *
 * Manages compliance issues, exceptions, and remediation tracking inside
 * the GRC: Policy and Compliance Management plugin. Wraps the
 * sn_compliance_issue, sn_compliance_policy_exception, sn_compliance_remediation,
 * and sn_compliance_evidence tables.
 *
 * Companion to snow_compliance_manage (which handles the control-side
 * exception and evidence flow). This tool is the issue-side complement —
 * listing the compliance issues raised against controls, creating
 * exceptions for them, tracking remediation, and marking them resolved.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

// TODO: verify against a live instance. Issue tracking moved from
// `sn_grc_issue` to `sn_compliance_issue` in the Tokyo refactor of GRC.
// Some Now Platform variants still expose both via a backing view.
const TABLE_ISSUE = "sn_compliance_issue"
const TABLE_EXCEPTION = "sn_compliance_policy_exception"
const TABLE_REMEDIATION = "sn_compliance_remediation"
const TABLE_EVIDENCE = "sn_compliance_evidence"

const PLUGIN_NAME = "GRC: Policy and Compliance Management (com.sn_compliance)"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_grc_issue_manage",
  description: `Unified tool for ServiceNow GRC compliance issues and exceptions beyond control-side authoring. Wraps the sn_compliance_issue, sn_compliance_policy_exception, sn_compliance_remediation, and sn_compliance_evidence tables that ship with the GRC: Policy and Compliance Management plugin.

Actions:
- list_issues — list compliance issues, optionally filtered by control, state, or severity
- list_exceptions — list policy exceptions raised against controls
- exception_create — open a new policy exception with justification and expiry
- link_evidence — attach an evidence record (or external URL) to a compliance issue
- mark_remediated — close an issue by attaching a remediation record and transitioning state

Use when: the agent needs to manage the issue side of GRC — listing issues raised by automated scans or auditors, granting time-bound exceptions, attaching evidence that supports the remediation, and closing the issue once remediated. For the control-side exception/evidence/attestation flow use snow_compliance_manage; for audit-driven findings use snow_grc_audit_manage.

Returns: issue rows with sys_id, control reference, severity, state; exception rows with state, expiry, requestor; remediation rows with plan, target date, owner; evidence rows with type and reference link. GRC plugin gating: the first call against these tables will surface a clear error if the GRC: Policy and Compliance Management plugin is not active on the target instance.`,
  category: "security",
  subcategory: "compliance-issues",
  use_cases: ["grc", "compliance", "issues", "exceptions", "remediation"],
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
        enum: ["list_exceptions", "exception_create", "link_evidence", "mark_remediated", "list_issues"],
      },
      // Identifiers
      issue_sys_id: {
        type: "string",
        description: "[link_evidence/mark_remediated] Compliance issue sys_id",
      },
      control_sys_id: {
        type: "string",
        description: "[exception_create/list_issues/list_exceptions] Compliance control sys_id (sn_compliance_control)",
      },
      // LIST filters
      state: {
        type: "string",
        description: "[list_issues/list_exceptions] Filter by state",
      },
      severity: {
        type: "string",
        description: "[list_issues] Filter by issue severity",
        enum: ["critical", "high", "medium", "low", "informational"],
      },
      framework: {
        type: "string",
        description: "[list_issues/list_exceptions] Filter by compliance framework (SOX, GDPR, HIPAA, ISO27001, etc.)",
      },
      limit: {
        type: "number",
        description: "[list_issues/list_exceptions] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list_issues/list_exceptions] Comma-separated list of fields to return",
      },
      // EXCEPTION_CREATE
      short_description: {
        type: "string",
        description: "[exception_create] Short description of the exception",
      },
      justification: {
        type: "string",
        description: "[exception_create] Business justification for the exception",
      },
      expiry: {
        type: "string",
        description: "[exception_create] ISO date string (YYYY-MM-DD) when the exception expires",
      },
      requestor: {
        type: "string",
        description: "[exception_create] sys_user sys_id of the requestor (defaults to the calling user)",
      },
      // LINK_EVIDENCE
      evidence_sys_id: {
        type: "string",
        description: "[link_evidence] Existing sn_compliance_evidence sys_id to link",
      },
      evidence_url: {
        type: "string",
        description: "[link_evidence] External evidence URL (used to create a new evidence row when evidence_sys_id is absent)",
      },
      evidence_type: {
        type: "string",
        description: "[link_evidence] Evidence type label",
        enum: ["document", "screenshot", "report", "attestation", "log", "other"],
        default: "document",
      },
      evidence_description: {
        type: "string",
        description: "[link_evidence] Optional description for the evidence record",
      },
      // MARK_REMEDIATED
      remediation_summary: {
        type: "string",
        description: "[mark_remediated] Summary of the remediation action taken",
      },
      remediation_owner: {
        type: "string",
        description: "[mark_remediated] sys_user sys_id of the person who remediated the issue",
      },
      remediation_completed_at: {
        type: "string",
        description: "[mark_remediated] ISO date string (YYYY-MM-DD) when the remediation was completed (defaults to today)",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list_issues":
        return await executeListIssues(args, context)
      case "list_exceptions":
        return await executeListExceptions(args, context)
      case "exception_create":
        return await executeExceptionCreate(args, context)
      case "link_evidence":
        return await executeLinkEvidence(args, context)
      case "mark_remediated":
        return await executeMarkRemediated(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list_issues, list_exceptions, exception_create, link_evidence, mark_remediated`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error & { response?: { status?: number } }
    if (err.response?.status === 404) {
      return createErrorResult(
        new SnowFlowError(
          ErrorType.PLUGIN_MISSING,
          `GRC compliance issue table not found. The ${PLUGIN_NAME} plugin may not be active on this instance. Confirm that sn_compliance_issue and sn_compliance_policy_exception tables exist.`,
          { originalError: err },
        ),
      )
    }
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `GRC issue ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function findIssue(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string,
): Promise<Record<string, unknown> | null> {
  const direct = await client.get(`/api/now/table/${TABLE_ISSUE}/${sysId}`)
  if (direct.data.result && direct.data.result.sys_id) {
    return direct.data.result
  }
  return null
}

// ==================== LIST_ISSUES ====================

async function executeListIssues(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const control_sys_id = args.control_sys_id as string | undefined
  const state = args.state as string | undefined
  const severity = args.severity as string | undefined
  const framework = args.framework as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (control_sys_id) queryParts.push(`control=${control_sys_id}`)
  if (state) queryParts.push(`state=${state}`)
  if (severity) queryParts.push(`severity=${severity}`)
  if (framework) queryParts.push(`framework=${framework}`)

  const response = await client.get(`/api/now/table/${TABLE_ISSUE}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "sys_created_on",
      sysparm_display_value: "true",
      ...(fields
        ? { sysparm_fields: fields }
        : {
            sysparm_fields:
              "sys_id,number,short_description,control,severity,state,framework,assigned_to,sys_created_on",
          }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_issues",
    count: results.length,
    issues: results.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      short_description: r.short_description,
      control: r.control,
      severity: r.severity,
      state: r.state,
      framework: r.framework,
      assigned_to: r.assigned_to,
      created_at: r.sys_created_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_ISSUE}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== LIST_EXCEPTIONS ====================

async function executeListExceptions(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const control_sys_id = args.control_sys_id as string | undefined
  const state = args.state as string | undefined
  const framework = args.framework as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (control_sys_id) queryParts.push(`control=${control_sys_id}`)
  if (state) queryParts.push(`state=${state}`)
  if (framework) queryParts.push(`framework=${framework}`)

  const response = await client.get(`/api/now/table/${TABLE_EXCEPTION}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "sys_created_on",
      sysparm_display_value: "true",
      ...(fields
        ? { sysparm_fields: fields }
        : {
            sysparm_fields:
              "sys_id,short_description,control,framework,state,expiry,requestor,sys_created_on",
          }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_exceptions",
    count: results.length,
    exceptions: results.map((r) => ({
      sys_id: r.sys_id,
      short_description: r.short_description,
      control: r.control,
      framework: r.framework,
      state: r.state,
      expiry: r.expiry,
      requestor: r.requestor,
      created_at: r.sys_created_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_EXCEPTION}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== EXCEPTION_CREATE ====================

async function executeExceptionCreate(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const control_sys_id = args.control_sys_id as string | undefined
  const short_description = args.short_description as string | undefined
  const justification = args.justification as string | undefined

  if (!control_sys_id) {
    return createErrorResult("control_sys_id is required for exception_create action")
  }
  if (!short_description) {
    return createErrorResult("short_description is required for exception_create action")
  }
  if (!justification) {
    return createErrorResult("justification is required for exception_create action")
  }

  const client = await getAuthenticatedClient(context)

  // TODO: verify sn_compliance_policy_exception column set on a live instance.
  const payload: Record<string, unknown> = {
    control: control_sys_id,
    short_description,
    justification,
    state: "draft",
  }
  if (args.expiry) payload.expiry = args.expiry
  if (args.requestor) payload.requestor = args.requestor

  const response = await client.post(`/api/now/table/${TABLE_EXCEPTION}`, payload)
  const result = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "exception_create",
    created: true,
    sys_id: result.sys_id,
    control_sys_id,
    exception: result,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_EXCEPTION}.do?sys_id=${result.sys_id}`,
  })
}

// ==================== LINK_EVIDENCE ====================

async function executeLinkEvidence(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const issue_sys_id = args.issue_sys_id as string | undefined
  const evidence_sys_id = args.evidence_sys_id as string | undefined
  const evidence_url = args.evidence_url as string | undefined
  const evidence_type = (args.evidence_type as string) || "document"
  const evidence_description = args.evidence_description as string | undefined

  if (!issue_sys_id) {
    return createErrorResult("issue_sys_id is required for link_evidence action")
  }
  if (!evidence_sys_id && !evidence_url) {
    return createErrorResult("evidence_sys_id or evidence_url is required for link_evidence action")
  }

  const client = await getAuthenticatedClient(context)
  const issue = await findIssue(client, issue_sys_id)
  if (!issue) {
    return createErrorResult(`Compliance issue not found: ${issue_sys_id}`)
  }

  let evidenceRecord: Record<string, unknown>
  let mode: "linked" | "created_and_linked"

  if (evidence_sys_id) {
    // TODO: verify sn_compliance_evidence column set on a live instance —
    // some releases use `issue` and others use `parent` as the polymorphic
    // reference back to the originating record.
    const direct = await client.get(`/api/now/table/${TABLE_EVIDENCE}/${evidence_sys_id}`)
    if (!direct.data.result || !direct.data.result.sys_id) {
      return createErrorResult(`Evidence record not found: ${evidence_sys_id}`)
    }
    const patchResponse = await client.patch(`/api/now/table/${TABLE_EVIDENCE}/${evidence_sys_id}`, {
      issue: issue_sys_id,
    })
    evidenceRecord = patchResponse.data.result as Record<string, unknown>
    mode = "linked"
  } else {
    const payload: Record<string, unknown> = {
      issue: issue_sys_id,
      type: evidence_type,
      url: evidence_url,
    }
    if (evidence_description) payload.description = evidence_description
    const created = await client.post(`/api/now/table/${TABLE_EVIDENCE}`, payload)
    evidenceRecord = created.data.result as Record<string, unknown>
    mode = "created_and_linked"
  }

  return createSuccessResult({
    action: "link_evidence",
    link_action: mode,
    sys_id: evidenceRecord.sys_id,
    issue_sys_id,
    evidence: evidenceRecord,
  })
}

// ==================== MARK_REMEDIATED ====================

async function executeMarkRemediated(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const issue_sys_id = args.issue_sys_id as string | undefined
  const remediation_summary = args.remediation_summary as string | undefined

  if (!issue_sys_id) {
    return createErrorResult("issue_sys_id is required for mark_remediated action")
  }
  if (!remediation_summary) {
    return createErrorResult("remediation_summary is required for mark_remediated action")
  }

  const client = await getAuthenticatedClient(context)
  const issue = await findIssue(client, issue_sys_id)
  if (!issue) {
    return createErrorResult(`Compliance issue not found: ${issue_sys_id}`)
  }

  const completedAt = (args.remediation_completed_at as string | undefined) || new Date().toISOString().split("T")[0]

  // Create remediation record. TODO: verify sn_compliance_remediation column
  // set on a live instance — common fields are issue (ref), summary,
  // completed_at, owner, state.
  let remediationRecord: Record<string, unknown> | null = null
  try {
    const payload: Record<string, unknown> = {
      issue: issue_sys_id,
      summary: remediation_summary,
      completed_at: completedAt,
      state: "completed",
    }
    if (args.remediation_owner) payload.owner = args.remediation_owner
    const remediation = await client.post(`/api/now/table/${TABLE_REMEDIATION}`, payload)
    remediationRecord = remediation.data.result as Record<string, unknown>
  } catch (e: unknown) {
    // If the remediation table doesn't exist on this instance, fall back to
    // a work-note on the issue itself.
    const err = e as Error
    // Non-fatal: still transition the issue state below and report the warning.
    remediationRecord = { warning: `Remediation record not created: ${err.message}` }
  }

  // Transition the issue to remediated/closed.
  const issuePatch: Record<string, unknown> = {
    state: "remediated",
    work_notes: remediation_summary,
  }
  const issueResponse = await client.patch(`/api/now/table/${TABLE_ISSUE}/${issue_sys_id}`, issuePatch)
  const updatedIssue = issueResponse.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "mark_remediated",
    remediated: true,
    sys_id: issue_sys_id,
    issue: updatedIssue,
    remediation: remediationRecord,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_ISSUE}.do?sys_id=${issue_sys_id}`,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
