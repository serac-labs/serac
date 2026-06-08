/**
 * snow_compliance_manage - Unified compliance lifecycle management
 *
 * Manages compliance exceptions and control evidence beyond initial rule
 * definition and scanning. Wraps the GRC policy and control tables
 * (sn_compliance_policy_exception, sn_compliance_control, sn_compliance_evidence)
 * that ship with the Governance, Risk & Compliance (GRC) plugin.
 *
 * Companion to snow_create_compliance_rule (rule authoring) and
 * snow_run_compliance_scan (scan execution). This tool focuses on the
 * follow-up workflow — handling exceptions to a rule, attaching evidence
 * to controls, and marking controls as compliant.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_compliance_manage",
  description: `Unified tool for ServiceNow compliance lifecycle beyond rule authoring and scanning: list_exceptions, exception_create, evidence_link, evidence_list, mark_compliant. Wraps the GRC tables sn_compliance_policy_exception, sn_compliance_control, and sn_compliance_evidence.

Actions:
- list_exceptions — list policy exceptions, optionally filtered by control, state, or framework
- exception_create — open a new policy exception against a control with justification and expiry
- evidence_link — attach an existing evidence record (or arbitrary URL) to a control
- evidence_list — list evidence rows linked to a given control
- mark_compliant — set a control's compliance state to compliant with an attestation note

Use when: the agent needs to manage the human side of compliance — granting time-bound exceptions to a control, attaching evidence collected outside ServiceNow to satisfy audit requirements, or attesting that a control is compliant. For authoring the rule itself, use snow_create_compliance_rule; for running a scan against a framework, use snow_run_compliance_scan.

Returns: exception rows with sys_id, state, expiry; evidence rows with type and link reference; control state transitions with attestation work notes.`,
  category: "security",
  subcategory: "compliance",
  use_cases: ["compliance", "grc", "exceptions", "evidence", "controls"],
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
        enum: ["list_exceptions", "exception_create", "evidence_link", "evidence_list", "mark_compliant"],
      },
      // Identifiers
      control_sys_id: {
        type: "string",
        description: "[exception_create/evidence_link/evidence_list/mark_compliant] sn_compliance_control sys_id",
      },
      exception_sys_id: {
        type: "string",
        description: "[list_exceptions] Filter to a specific exception by sys_id",
      },
      // LIST_EXCEPTIONS filters
      state: {
        type: "string",
        description: "[list_exceptions] Filter by exception state",
        enum: ["draft", "review", "approved", "rejected", "expired", "withdrawn"],
      },
      framework: {
        type: "string",
        description: "[list_exceptions] Filter by compliance framework (SOX, GDPR, HIPAA, etc.)",
      },
      limit: {
        type: "number",
        description: "[list_exceptions/evidence_list] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list_exceptions/evidence_list] Comma-separated list of fields to return",
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
      // EVIDENCE_LINK
      evidence_sys_id: {
        type: "string",
        description: "[evidence_link] Existing sn_compliance_evidence sys_id to link",
      },
      evidence_url: {
        type: "string",
        description: "[evidence_link] External evidence URL (used to create a new sn_compliance_evidence row when evidence_sys_id is absent)",
      },
      evidence_type: {
        type: "string",
        description: "[evidence_link] Evidence type label",
        enum: ["document", "screenshot", "report", "attestation", "log", "other"],
        default: "document",
      },
      evidence_description: {
        type: "string",
        description: "[evidence_link] Optional description for the evidence record",
      },
      // MARK_COMPLIANT
      attestation_note: {
        type: "string",
        description: "[mark_compliant] Work note explaining why the control is being marked compliant",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list_exceptions":
        return await executeListExceptions(args, context)
      case "exception_create":
        return await executeExceptionCreate(args, context)
      case "evidence_link":
        return await executeEvidenceLink(args, context)
      case "evidence_list":
        return await executeEvidenceList(args, context)
      case "mark_compliant":
        return await executeMarkCompliant(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list_exceptions, exception_create, evidence_link, evidence_list, mark_compliant`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Compliance ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function findControl(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string,
): Promise<Record<string, unknown> | null> {
  // TODO: verify sn_compliance_control table name on a live instance. Some
  // GRC plugin versions ship the control table as `sn_compliance_control`
  // while older releases use `sn_grc_control`.
  const direct = await client.get(`/api/now/table/sn_compliance_control/${sysId}`)
  if (direct.data.result && direct.data.result.sys_id) {
    return direct.data.result
  }
  return null
}

// ==================== LIST_EXCEPTIONS ====================

async function executeListExceptions(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const control_sys_id = args.control_sys_id as string | undefined
  const exception_sys_id = args.exception_sys_id as string | undefined
  const state = args.state as string | undefined
  const framework = args.framework as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (exception_sys_id) queryParts.push(`sys_id=${exception_sys_id}`)
  if (control_sys_id) queryParts.push(`control=${control_sys_id}`)
  if (state) queryParts.push(`state=${state}`)
  if (framework) queryParts.push(`framework=${framework}`)

  // TODO: verify sn_compliance_policy_exception table name on a live instance
  const response = await client.get("/api/now/table/sn_compliance_policy_exception", {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "sys_created_on",
      sysparm_display_value: "true",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,short_description,control,framework,state,expiry,requestor,sys_created_on" }),
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
      url: `${context.instanceUrl}/nav_to.do?uri=sn_compliance_policy_exception.do?sys_id=${r.sys_id}`,
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
  const expiry = args.expiry as string | undefined
  const requestor = args.requestor as string | undefined

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
  const control = await findControl(client, control_sys_id)
  if (!control) {
    return createErrorResult(`Compliance control not found: ${control_sys_id}`)
  }

  // TODO: verify sn_compliance_policy_exception field set on a live instance
  const payload: Record<string, unknown> = {
    control: control_sys_id,
    short_description,
    justification,
    state: "draft",
  }
  if (expiry) payload.expiry = expiry
  if (requestor) payload.requestor = requestor

  const response = await client.post("/api/now/table/sn_compliance_policy_exception", payload)
  const result = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "exception_create",
    created: true,
    sys_id: result.sys_id,
    control: { sys_id: control_sys_id, name: control.name },
    exception: result,
    url: `${context.instanceUrl}/nav_to.do?uri=sn_compliance_policy_exception.do?sys_id=${result.sys_id}`,
  })
}

// ==================== EVIDENCE_LINK ====================

async function executeEvidenceLink(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const control_sys_id = args.control_sys_id as string | undefined
  const evidence_sys_id = args.evidence_sys_id as string | undefined
  const evidence_url = args.evidence_url as string | undefined
  const evidence_type = (args.evidence_type as string) || "document"
  const evidence_description = args.evidence_description as string | undefined

  if (!control_sys_id) {
    return createErrorResult("control_sys_id is required for evidence_link action")
  }
  if (!evidence_sys_id && !evidence_url) {
    return createErrorResult("evidence_sys_id or evidence_url is required for evidence_link action")
  }

  const client = await getAuthenticatedClient(context)
  const control = await findControl(client, control_sys_id)
  if (!control) {
    return createErrorResult(`Compliance control not found: ${control_sys_id}`)
  }

  let evidenceRecord: Record<string, unknown>
  let mode: "linked" | "created_and_linked"

  if (evidence_sys_id) {
    // TODO: verify sn_compliance_evidence table name on a live instance
    const direct = await client.get(`/api/now/table/sn_compliance_evidence/${evidence_sys_id}`)
    if (!direct.data.result || !direct.data.result.sys_id) {
      return createErrorResult(`Evidence record not found: ${evidence_sys_id}`)
    }
    // Patch the control reference onto the existing evidence row
    const patchResponse = await client.patch(`/api/now/table/sn_compliance_evidence/${evidence_sys_id}`, {
      control: control_sys_id,
    })
    evidenceRecord = patchResponse.data.result as Record<string, unknown>
    mode = "linked"
  } else {
    const payload: Record<string, unknown> = {
      control: control_sys_id,
      type: evidence_type,
      url: evidence_url,
    }
    if (evidence_description) payload.description = evidence_description
    const created = await client.post("/api/now/table/sn_compliance_evidence", payload)
    evidenceRecord = created.data.result as Record<string, unknown>
    mode = "created_and_linked"
  }

  return createSuccessResult({
    action: "evidence_link",
    link_action: mode,
    sys_id: evidenceRecord.sys_id,
    control: { sys_id: control_sys_id, name: control.name },
    evidence: evidenceRecord,
  })
}

// ==================== EVIDENCE_LIST ====================

async function executeEvidenceList(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const control_sys_id = args.control_sys_id as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  if (!control_sys_id) {
    return createErrorResult("control_sys_id is required for evidence_list action")
  }

  const client = await getAuthenticatedClient(context)
  const control = await findControl(client, control_sys_id)
  if (!control) {
    return createErrorResult(`Compliance control not found: ${control_sys_id}`)
  }

  // TODO: verify sn_compliance_evidence.control column on a live instance
  const response = await client.get("/api/now/table/sn_compliance_evidence", {
    params: {
      sysparm_query: `control=${control_sys_id}`,
      sysparm_limit: limit,
      sysparm_orderby: "sys_created_on",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,type,url,description,control,sys_created_on" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "evidence_list",
    control: { sys_id: control_sys_id, name: control.name },
    count: results.length,
    evidence: results,
  })
}

// ==================== MARK_COMPLIANT ====================

async function executeMarkCompliant(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const control_sys_id = args.control_sys_id as string | undefined
  const attestation_note = args.attestation_note as string | undefined

  if (!control_sys_id) {
    return createErrorResult("control_sys_id is required for mark_compliant action")
  }
  if (!attestation_note) {
    return createErrorResult("attestation_note is required for mark_compliant action")
  }

  const client = await getAuthenticatedClient(context)
  const control = await findControl(client, control_sys_id)
  if (!control) {
    return createErrorResult(`Compliance control not found: ${control_sys_id}`)
  }

  // TODO: verify sn_compliance_control compliance state values on a live
  // instance — documented choices include "compliant", "non_compliant",
  // "not_applicable", and "not_assessed".
  const payload: Record<string, unknown> = {
    compliance: "compliant",
    work_notes: attestation_note,
  }

  const response = await client.patch(`/api/now/table/sn_compliance_control/${control_sys_id}`, payload)
  const result = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "mark_compliant",
    updated: true,
    sys_id: control_sys_id,
    control: result,
    url: `${context.instanceUrl}/nav_to.do?uri=sn_compliance_control.do?sys_id=${control_sys_id}`,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
