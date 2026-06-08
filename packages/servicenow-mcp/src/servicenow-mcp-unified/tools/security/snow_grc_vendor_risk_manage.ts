/**
 * snow_grc_vendor_risk_manage - Unified GRC Vendor Risk Management lifecycle
 *
 * Manages the third-party vendor risk lifecycle in the GRC: Vendor Risk
 * Management plugin. Wraps the sn_vdr_vendor, sn_vdr_assessment, and
 * sn_vdr_question_template tables.
 *
 * Companion to snow_grc_risk_manage (which covers the internal risk
 * register) and snow_compliance_manage (which handles control evidence).
 * This tool focuses on vendor-side risk — listing vendors, kicking off
 * an assessment using a question template, and linking the resulting
 * vendor risk back to the central risk register.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

// TODO: verify against a live instance. Vendor Risk Management uses the
// `sn_vdr_*` namespace on Tokyo+; earlier releases used `sn_vrm_*` as the
// prefix. We always target the newer prefix here.
const TABLE_VENDOR = "sn_vdr_vendor"
const TABLE_ASSESSMENT = "sn_vdr_assessment"
const TABLE_QUESTION_TEMPLATE = "sn_vdr_question_template"

// Cross-table reference used by link_to_risk
const TABLE_RISK = "sn_risk_advanced_risk"

const PLUGIN_NAME = "GRC: Vendor Risk Management (com.sn_vdr)"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_grc_vendor_risk_manage",
  description: `Unified tool for ServiceNow GRC Vendor Risk Management: vendor inventory, assessment kick-off, and linkage back to the central risk register. Wraps the sn_vdr_vendor, sn_vdr_assessment, and sn_vdr_question_template tables that ship with the GRC: Vendor Risk Management plugin.

Actions:
- list_vendors — list vendors in the third-party inventory, optionally filtered by tier or active flag
- assess_vendor — kick off a vendor assessment using a question template (creates an sn_vdr_assessment row in draft state)
- list_assessments — list assessments, optionally filtered by vendor, state, or framework
- create_assessment — create an assessment record directly with explicit fields (low-level alternative to assess_vendor)
- link_to_risk — link a vendor assessment back to an entry in the central risk register (sn_risk_advanced_risk)

Use when: the agent needs to drive third-party / vendor risk — inventorying vendors, kicking off questionnaire-based assessments, and connecting the vendor risk outcome to the central risk register. For internal risk register operations use snow_grc_risk_manage; for compliance issues and exceptions use snow_grc_issue_manage.

Returns: vendor rows with sys_id, name, tier, active flag; assessment rows with state, template, scheduled date; question template rows with sys_id and name. GRC plugin gating: the first call against the vendor tables will surface a clear error if the GRC: Vendor Risk Management plugin is not active on the target instance.`,
  category: "security",
  subcategory: "vendor-risk",
  use_cases: ["grc", "vendor-risk", "third-party", "assessment", "vrm"],
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
        enum: ["list_vendors", "assess_vendor", "list_assessments", "create_assessment", "link_to_risk"],
      },
      // Identifiers
      vendor_sys_id: {
        type: "string",
        description: "[assess_vendor/list_assessments/create_assessment] Vendor sys_id (sn_vdr_vendor)",
      },
      assessment_sys_id: {
        type: "string",
        description: "[link_to_risk] Assessment sys_id (sn_vdr_assessment)",
      },
      template_sys_id: {
        type: "string",
        description: "[assess_vendor/create_assessment] Question template sys_id (sn_vdr_question_template)",
      },
      risk_sys_id: {
        type: "string",
        description: "[link_to_risk] Risk sys_id (sn_risk_advanced_risk) to link the assessment to",
      },
      // LIST_VENDORS filters
      tier: {
        type: "string",
        description: "[list_vendors] Filter by vendor tier (tier_1, tier_2, tier_3, tier_4, critical, strategic)",
      },
      active_only: {
        type: "boolean",
        description: "[list_vendors] Only return active vendors",
        default: false,
      },
      // LIST_ASSESSMENTS filters
      state: {
        type: "string",
        description: "[list_assessments] Filter by assessment state",
        enum: ["draft", "scheduled", "in_progress", "submitted", "reviewed", "completed", "cancelled"],
      },
      framework: {
        type: "string",
        description: "[list_assessments] Filter by compliance framework (SOC2, ISO27001, NIST, custom)",
      },
      // Pagination / projection
      limit: {
        type: "number",
        description: "[list_vendors/list_assessments] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list_vendors/list_assessments] Comma-separated list of fields to return",
      },
      // ASSESS_VENDOR / CREATE_ASSESSMENT
      assessment_name: {
        type: "string",
        description: "[assess_vendor/create_assessment] Assessment name / short description",
      },
      scheduled_start_date: {
        type: "string",
        description: "[assess_vendor/create_assessment] ISO date string (YYYY-MM-DD) for scheduled start",
      },
      due_date: {
        type: "string",
        description: "[assess_vendor/create_assessment] ISO date string (YYYY-MM-DD) when the assessment is due",
      },
      assigned_to: {
        type: "string",
        description: "[assess_vendor/create_assessment] sys_user sys_id of the vendor-side respondent",
      },
      assessment_framework: {
        type: "string",
        description: "[create_assessment] Compliance framework label (SOC2, ISO27001, NIST, custom)",
      },
      // LINK_TO_RISK (no extra fields beyond assessment_sys_id + risk_sys_id)
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list_vendors":
        return await executeListVendors(args, context)
      case "assess_vendor":
        return await executeAssessVendor(args, context)
      case "list_assessments":
        return await executeListAssessments(args, context)
      case "create_assessment":
        return await executeCreateAssessment(args, context)
      case "link_to_risk":
        return await executeLinkToRisk(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list_vendors, assess_vendor, list_assessments, create_assessment, link_to_risk`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error & { response?: { status?: number } }
    if (err.response?.status === 404) {
      return createErrorResult(
        new SnowFlowError(
          ErrorType.PLUGIN_MISSING,
          `GRC vendor risk table not found. The ${PLUGIN_NAME} plugin may not be active on this instance. Confirm that sn_vdr_vendor and sn_vdr_assessment tables exist.`,
          { originalError: err },
        ),
      )
    }
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `GRC vendor risk ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function findVendor(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string,
): Promise<Record<string, unknown> | null> {
  const direct = await client.get(`/api/now/table/${TABLE_VENDOR}/${sysId}`)
  if (direct.data.result && direct.data.result.sys_id) {
    return direct.data.result
  }
  return null
}

async function findAssessment(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string,
): Promise<Record<string, unknown> | null> {
  const direct = await client.get(`/api/now/table/${TABLE_ASSESSMENT}/${sysId}`)
  if (direct.data.result && direct.data.result.sys_id) {
    return direct.data.result
  }
  return null
}

// ==================== LIST_VENDORS ====================

async function executeListVendors(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const tier = args.tier as string | undefined
  const active_only = args.active_only === true
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (tier) queryParts.push(`tier=${tier}`)
  if (active_only) queryParts.push("active=true")

  const response = await client.get(`/api/now/table/${TABLE_VENDOR}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "name",
      sysparm_display_value: "true",
      ...(fields
        ? { sysparm_fields: fields }
        : {
            sysparm_fields:
              "sys_id,number,name,tier,active,vendor_contact,inherent_risk,residual_risk,sys_updated_on",
          }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_vendors",
    count: results.length,
    vendors: results.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      name: r.name,
      tier: r.tier,
      active: r.active,
      vendor_contact: r.vendor_contact,
      inherent_risk: r.inherent_risk,
      residual_risk: r.residual_risk,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_VENDOR}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== ASSESS_VENDOR ====================

async function executeAssessVendor(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const vendor_sys_id = args.vendor_sys_id as string | undefined
  const template_sys_id = args.template_sys_id as string | undefined

  if (!vendor_sys_id) {
    return createErrorResult("vendor_sys_id is required for assess_vendor action")
  }
  if (!template_sys_id) {
    return createErrorResult("template_sys_id is required for assess_vendor action")
  }

  const client = await getAuthenticatedClient(context)

  const vendor = await findVendor(client, vendor_sys_id)
  if (!vendor) {
    return createErrorResult(`Vendor not found: ${vendor_sys_id}`)
  }

  // Verify the question template exists.
  // TODO: verify sn_vdr_question_template table name on a live instance.
  const templateCheck = await client.get(`/api/now/table/${TABLE_QUESTION_TEMPLATE}/${template_sys_id}`)
  if (!templateCheck.data.result || !templateCheck.data.result.sys_id) {
    return createErrorResult(`Question template not found: ${template_sys_id}`)
  }
  const template = templateCheck.data.result as Record<string, unknown>

  // TODO: verify sn_vdr_assessment column set on a live instance — common
  // fields are vendor (ref), template (ref), state, scheduled_start_date,
  // due_date, assigned_to.
  const assessment_name = (args.assessment_name as string) || `Assessment of ${vendor.name} (${template.name})`
  const payload: Record<string, unknown> = {
    vendor: vendor_sys_id,
    template: template_sys_id,
    short_description: assessment_name,
    state: "draft",
  }
  if (args.scheduled_start_date) payload.scheduled_start_date = args.scheduled_start_date
  if (args.due_date) payload.due_date = args.due_date
  if (args.assigned_to) payload.assigned_to = args.assigned_to

  const response = await client.post(`/api/now/table/${TABLE_ASSESSMENT}`, payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "assess_vendor",
    created: true,
    sys_id: created.sys_id,
    vendor: { sys_id: vendor_sys_id, name: vendor.name },
    template: { sys_id: template_sys_id, name: template.name },
    assessment: created,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_ASSESSMENT}.do?sys_id=${created.sys_id}`,
  })
}

// ==================== LIST_ASSESSMENTS ====================

async function executeListAssessments(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const vendor_sys_id = args.vendor_sys_id as string | undefined
  const state = args.state as string | undefined
  const framework = args.framework as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (vendor_sys_id) queryParts.push(`vendor=${vendor_sys_id}`)
  if (state) queryParts.push(`state=${state}`)
  if (framework) queryParts.push(`framework=${framework}`)

  const response = await client.get(`/api/now/table/${TABLE_ASSESSMENT}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "sys_created_on",
      sysparm_display_value: "true",
      ...(fields
        ? { sysparm_fields: fields }
        : {
            sysparm_fields:
              "sys_id,number,short_description,vendor,template,state,scheduled_start_date,due_date,framework,sys_created_on",
          }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_assessments",
    count: results.length,
    assessments: results.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      short_description: r.short_description,
      vendor: r.vendor,
      template: r.template,
      state: r.state,
      scheduled_start_date: r.scheduled_start_date,
      due_date: r.due_date,
      framework: r.framework,
      created_at: r.sys_created_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_ASSESSMENT}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== CREATE_ASSESSMENT ====================

async function executeCreateAssessment(
  args: Record<string, unknown>,
  context: ServiceNowContext,
): Promise<ToolResult> {
  const vendor_sys_id = args.vendor_sys_id as string | undefined
  const template_sys_id = args.template_sys_id as string | undefined
  const assessment_name = args.assessment_name as string | undefined

  if (!vendor_sys_id) {
    return createErrorResult("vendor_sys_id is required for create_assessment action")
  }
  if (!assessment_name) {
    return createErrorResult("assessment_name is required for create_assessment action")
  }

  const client = await getAuthenticatedClient(context)
  const vendor = await findVendor(client, vendor_sys_id)
  if (!vendor) {
    return createErrorResult(`Vendor not found: ${vendor_sys_id}`)
  }

  const payload: Record<string, unknown> = {
    vendor: vendor_sys_id,
    short_description: assessment_name,
    state: "draft",
  }
  if (template_sys_id) payload.template = template_sys_id
  if (args.scheduled_start_date) payload.scheduled_start_date = args.scheduled_start_date
  if (args.due_date) payload.due_date = args.due_date
  if (args.assigned_to) payload.assigned_to = args.assigned_to
  if (args.assessment_framework) payload.framework = args.assessment_framework

  const response = await client.post(`/api/now/table/${TABLE_ASSESSMENT}`, payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "create_assessment",
    created: true,
    sys_id: created.sys_id,
    vendor: { sys_id: vendor_sys_id, name: vendor.name },
    assessment: created,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_ASSESSMENT}.do?sys_id=${created.sys_id}`,
  })
}

// ==================== LINK_TO_RISK ====================

async function executeLinkToRisk(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const assessment_sys_id = args.assessment_sys_id as string | undefined
  const risk_sys_id = args.risk_sys_id as string | undefined

  if (!assessment_sys_id) {
    return createErrorResult("assessment_sys_id is required for link_to_risk action")
  }
  if (!risk_sys_id) {
    return createErrorResult("risk_sys_id is required for link_to_risk action")
  }

  const client = await getAuthenticatedClient(context)

  const assessment = await findAssessment(client, assessment_sys_id)
  if (!assessment) {
    return createErrorResult(`Vendor assessment not found: ${assessment_sys_id}`)
  }

  // Verify the target risk exists.
  // TODO: verify sn_risk_advanced_risk table name on a live instance.
  const riskCheck = await client.get(`/api/now/table/${TABLE_RISK}/${risk_sys_id}`)
  if (!riskCheck.data.result || !riskCheck.data.result.sys_id) {
    return createErrorResult(`Risk not found: ${risk_sys_id}`)
  }

  // TODO: verify the reference column name on sn_vdr_assessment used to link
  // back to the central risk register. Common implementations expose a
  // `risk` reference field; some custom rollouts use an m2m table named
  // `sn_vdr_m2m_assessment_risk` instead.
  const patchResponse = await client.patch(`/api/now/table/${TABLE_ASSESSMENT}/${assessment_sys_id}`, {
    risk: risk_sys_id,
  })
  const updated = patchResponse.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "link_to_risk",
    linked: true,
    assessment_sys_id,
    risk_sys_id,
    assessment: updated,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_ASSESSMENT}.do?sys_id=${assessment_sys_id}`,
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
