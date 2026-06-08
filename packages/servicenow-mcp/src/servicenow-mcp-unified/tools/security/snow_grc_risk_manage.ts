/**
 * snow_grc_risk_manage - Unified GRC Advanced Risk lifecycle
 *
 * Manages the risk register, risk assessments, treatments, and ownership
 * assignment in the GRC: Advanced Risk plugin. Wraps the sn_risk_advanced_risk,
 * sn_risk_risk_treatment, and sn_risk_risk_owner tables.
 *
 * Companion to snow_security_risk_assessment (security-focused risk
 * scoring), snow_vulnerability_risk_assessment (vulnerability-derived risk
 * scoring), and snow_grc_vendor_risk_manage (third-party vendor risk).
 * This tool focuses on the core risk register operations — registering a
 * risk, scoring it, attaching a treatment plan, and assigning an owner.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

// TODO: verify against a live instance. GRC: Advanced Risk ships on Tokyo+
// under `sn_risk_advanced_risk`. Older releases used `sn_risk_risk` as the
// base risk table — and some legacy plugin variants surface a `sn_grc_risk`
// alias view. We always target the advanced table here.
const TABLE_RISK = "sn_risk_advanced_risk"
const TABLE_TREATMENT = "sn_risk_risk_treatment"
const TABLE_OWNER = "sn_risk_risk_owner"

const PLUGIN_NAME = "GRC: Advanced Risk (com.sn_risk_advanced)"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_grc_risk_manage",
  description: `Unified tool for ServiceNow GRC Advanced Risk register lifecycle: registering risks, scoring them, attaching treatment plans, and assigning ownership. Wraps the sn_risk_advanced_risk, sn_risk_risk_treatment, and sn_risk_risk_owner tables that ship with the GRC: Advanced Risk plugin.

Actions:
- list — list risks, optionally filtered by category, state, or owner
- get — retrieve a single risk by sys_id (includes counts of treatments and owners)
- create — register a new risk with category, inherent score, and owner
- assess — update the risk's inherent or residual likelihood/impact scores
- treat — attach a treatment plan (accept, mitigate, transfer, avoid) with target date
- assign_owner — assign or transfer the risk owner (writes sn_risk_risk_owner)

Use when: the agent needs to manage the risk register itself — registering newly identified risks, refreshing inherent/residual scoring after an assessment, choosing a treatment strategy, and naming an accountable owner. For security-specific scoring use snow_security_risk_assessment; for vendor third-party risk use snow_grc_vendor_risk_manage.

Returns: risk rows with sys_id, number, name, category, inherent and residual scores, state; treatment rows with strategy, target date, and owner; ownership rows with sys_user reference and role. GRC plugin gating: the first call against the risk tables will surface a clear error if the GRC: Advanced Risk plugin is not active on the target instance.`,
  category: "security",
  subcategory: "risk-management",
  use_cases: ["grc", "risk", "risk-register", "treatment", "ownership"],
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
        enum: ["list", "get", "create", "assess", "treat", "assign_owner"],
      },
      // Identifiers
      sys_id: {
        type: "string",
        description: "[get/assess/treat/assign_owner] Risk sys_id",
      },
      // LIST filters
      category: {
        type: "string",
        description: "[list/create] Risk category (operational, financial, strategic, compliance, security, third_party)",
      },
      state: {
        type: "string",
        description: "[list/create/assess] Risk state",
        enum: ["draft", "assessed", "in_treatment", "monitored", "closed"],
      },
      owner: {
        type: "string",
        description: "[list] Filter by current owner sys_user sys_id",
      },
      limit: {
        type: "number",
        description: "[list] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list/get] Comma-separated list of fields to return",
      },
      // CREATE
      name: {
        type: "string",
        description: "[create] Risk name / title (required)",
      },
      description: {
        type: "string",
        description: "[create] Risk description / scenario detail",
      },
      inherent_likelihood: {
        type: "number",
        description: "[create/assess] Inherent likelihood score (1-5 scale, instance-configurable)",
      },
      inherent_impact: {
        type: "number",
        description: "[create/assess] Inherent impact score (1-5 scale, instance-configurable)",
      },
      // ASSESS (residual scoring)
      residual_likelihood: {
        type: "number",
        description: "[assess] Residual likelihood score after existing controls (1-5 scale)",
      },
      residual_impact: {
        type: "number",
        description: "[assess] Residual impact score after existing controls (1-5 scale)",
      },
      assessment_note: {
        type: "string",
        description: "[assess] Optional work note describing the assessment rationale",
      },
      // TREAT
      treatment_strategy: {
        type: "string",
        description: "[treat] Treatment strategy",
        enum: ["accept", "mitigate", "transfer", "avoid"],
      },
      treatment_description: {
        type: "string",
        description: "[treat] Description of the treatment plan",
      },
      treatment_target_date: {
        type: "string",
        description: "[treat] ISO date string (YYYY-MM-DD) for target completion",
      },
      treatment_owner: {
        type: "string",
        description: "[treat] sys_user sys_id of the treatment owner",
      },
      // ASSIGN_OWNER
      assigned_user: {
        type: "string",
        description: "[assign_owner] sys_user sys_id of the new owner (required)",
      },
      owner_role: {
        type: "string",
        description: "[assign_owner] Owner role label (risk_owner, control_owner, accountable, responsible)",
        default: "risk_owner",
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
      case "create":
        return await executeCreate(args, context)
      case "assess":
        return await executeAssess(args, context)
      case "treat":
        return await executeTreat(args, context)
      case "assign_owner":
        return await executeAssignOwner(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list, get, create, assess, treat, assign_owner`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error & { response?: { status?: number } }
    if (err.response?.status === 404) {
      return createErrorResult(
        new SnowFlowError(
          ErrorType.PLUGIN_MISSING,
          `GRC risk table not found. The ${PLUGIN_NAME} plugin may not be active on this instance. Confirm that sn_risk_advanced_risk exists.`,
          { originalError: err },
        ),
      )
    }
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `GRC risk ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function findRisk(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string,
): Promise<Record<string, unknown> | null> {
  const direct = await client.get(`/api/now/table/${TABLE_RISK}/${sysId}`)
  if (direct.data.result && direct.data.result.sys_id) {
    return direct.data.result
  }
  return null
}

// ==================== LIST ====================

async function executeList(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const category = args.category as string | undefined
  const state = args.state as string | undefined
  const owner = args.owner as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (category) queryParts.push(`category=${category}`)
  if (state) queryParts.push(`state=${state}`)
  if (owner) queryParts.push(`owner=${owner}`)

  const response = await client.get(`/api/now/table/${TABLE_RISK}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "sys_created_on",
      sysparm_display_value: "true",
      ...(fields
        ? { sysparm_fields: fields }
        : {
            sysparm_fields:
              "sys_id,number,name,category,state,owner,inherent_score,residual_score,inherent_likelihood,inherent_impact,sys_updated_on",
          }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list",
    count: results.length,
    risks: results.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      name: r.name,
      category: r.category,
      state: r.state,
      owner: r.owner,
      inherent_score: r.inherent_score,
      residual_score: r.residual_score,
      inherent_likelihood: r.inherent_likelihood,
      inherent_impact: r.inherent_impact,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_RISK}.do?sys_id=${r.sys_id}`,
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
  const risk = await findRisk(client, sys_id)
  if (!risk) {
    return createErrorResult(`Risk not found: ${sys_id}`)
  }

  // Count related treatments and owners (best-effort).
  let treatmentCount = 0
  let ownerCount = 0
  try {
    const treatments = await client.get(`/api/now/table/${TABLE_TREATMENT}`, {
      params: { sysparm_query: `risk=${sys_id}`, sysparm_fields: "sys_id", sysparm_limit: 200 },
    })
    treatmentCount = (treatments.data.result || []).length
  } catch {
    // TODO: verify treatment -> risk reference column on a live instance.
  }
  try {
    const owners = await client.get(`/api/now/table/${TABLE_OWNER}`, {
      params: { sysparm_query: `risk=${sys_id}`, sysparm_fields: "sys_id", sysparm_limit: 200 },
    })
    ownerCount = (owners.data.result || []).length
  } catch {
    // TODO: verify owner -> risk reference column on a live instance.
  }

  return createSuccessResult({
    action: "get",
    sys_id,
    risk,
    related: {
      treatment_count: treatmentCount,
      owner_count: ownerCount,
    },
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_RISK}.do?sys_id=${sys_id}`,
  })
}

// ==================== CREATE ====================

async function executeCreate(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const name = args.name as string | undefined

  if (!name) {
    return createErrorResult("name is required for create action")
  }

  const client = await getAuthenticatedClient(context)

  const payload: Record<string, unknown> = {
    name,
    state: (args.state as string) || "draft",
  }
  if (args.description) payload.description = args.description
  if (args.category) payload.category = args.category
  if (args.inherent_likelihood !== undefined) payload.inherent_likelihood = args.inherent_likelihood
  if (args.inherent_impact !== undefined) payload.inherent_impact = args.inherent_impact

  const response = await client.post(`/api/now/table/${TABLE_RISK}`, payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "create",
    created: true,
    sys_id: created.sys_id,
    name: created.name,
    risk: created,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_RISK}.do?sys_id=${created.sys_id}`,
  })
}

// ==================== ASSESS ====================

async function executeAssess(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined

  if (!sys_id) {
    return createErrorResult("sys_id is required for assess action")
  }

  const client = await getAuthenticatedClient(context)
  const risk = await findRisk(client, sys_id)
  if (!risk) {
    return createErrorResult(`Risk not found: ${sys_id}`)
  }

  const updatableFields: Array<[string, string]> = [
    ["inherent_likelihood", "inherent_likelihood"],
    ["inherent_impact", "inherent_impact"],
    ["residual_likelihood", "residual_likelihood"],
    ["residual_impact", "residual_impact"],
    ["state", "state"],
  ]
  const patch: Record<string, unknown> = {}
  for (const [argKey, fieldName] of updatableFields) {
    if (args[argKey] !== undefined) {
      patch[fieldName] = args[argKey]
    }
  }
  if (args.assessment_note) patch.work_notes = args.assessment_note

  if (Object.keys(patch).length === 0) {
    return createErrorResult("No assessment fields provided (likelihood, impact, or state)")
  }

  const response = await client.patch(`/api/now/table/${TABLE_RISK}/${sys_id}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "assess",
    assessed: true,
    sys_id,
    updated_fields: Object.keys(patch),
    risk: updated,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_RISK}.do?sys_id=${sys_id}`,
  })
}

// ==================== TREAT ====================

async function executeTreat(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const treatment_strategy = args.treatment_strategy as string | undefined

  if (!sys_id) {
    return createErrorResult("sys_id is required for treat action")
  }
  if (!treatment_strategy) {
    return createErrorResult("treatment_strategy is required for treat action (accept, mitigate, transfer, avoid)")
  }

  const client = await getAuthenticatedClient(context)
  const risk = await findRisk(client, sys_id)
  if (!risk) {
    return createErrorResult(`Risk not found: ${sys_id}`)
  }

  // TODO: verify sn_risk_risk_treatment column set on a live instance.
  // Common fields: risk (ref), strategy/treatment_type, description,
  // target_date, owner, state.
  const payload: Record<string, unknown> = {
    risk: sys_id,
    strategy: treatment_strategy,
    state: "planned",
  }
  if (args.treatment_description) payload.description = args.treatment_description
  if (args.treatment_target_date) payload.target_date = args.treatment_target_date
  if (args.treatment_owner) payload.owner = args.treatment_owner

  const response = await client.post(`/api/now/table/${TABLE_TREATMENT}`, payload)
  const created = response.data.result as Record<string, unknown>

  // Move the risk into "in_treatment" state if it isn't already in a more
  // advanced state. Don't block on failure — the treatment row was created.
  try {
    if (risk.state !== "in_treatment" && risk.state !== "monitored" && risk.state !== "closed") {
      await client.patch(`/api/now/table/${TABLE_RISK}/${sys_id}`, { state: "in_treatment" })
    }
  } catch {
    // Surface non-fatally — treatment is recorded either way.
  }

  return createSuccessResult({
    action: "treat",
    created: true,
    sys_id: created.sys_id,
    risk_sys_id: sys_id,
    treatment: created,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_TREATMENT}.do?sys_id=${created.sys_id}`,
  })
}

// ==================== ASSIGN_OWNER ====================

async function executeAssignOwner(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const assigned_user = args.assigned_user as string | undefined
  const owner_role = (args.owner_role as string) || "risk_owner"

  if (!sys_id) {
    return createErrorResult("sys_id is required for assign_owner action")
  }
  if (!assigned_user) {
    return createErrorResult("assigned_user is required for assign_owner action")
  }

  const client = await getAuthenticatedClient(context)
  const risk = await findRisk(client, sys_id)
  if (!risk) {
    return createErrorResult(`Risk not found: ${sys_id}`)
  }

  // TODO: verify sn_risk_risk_owner column set on a live instance. Common
  // fields: risk (ref), user (sys_user ref), role.
  const payload: Record<string, unknown> = {
    risk: sys_id,
    user: assigned_user,
    role: owner_role,
  }

  const response = await client.post(`/api/now/table/${TABLE_OWNER}`, payload)
  const created = response.data.result as Record<string, unknown>

  // Also patch the primary owner field on the risk so the risk list view
  // reflects the assignment immediately. Non-fatal on failure.
  let primaryOwnerUpdated = false
  try {
    await client.patch(`/api/now/table/${TABLE_RISK}/${sys_id}`, { owner: assigned_user })
    primaryOwnerUpdated = true
  } catch {
    // TODO: verify primary owner column on sn_risk_advanced_risk on a live instance.
  }

  return createSuccessResult({
    action: "assign_owner",
    assigned: true,
    sys_id: created.sys_id,
    risk_sys_id: sys_id,
    primary_owner_updated: primaryOwnerUpdated,
    ownership: created,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_RISK}.do?sys_id=${sys_id}`,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
