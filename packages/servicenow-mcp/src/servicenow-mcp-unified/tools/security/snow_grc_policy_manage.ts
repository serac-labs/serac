/**
 * snow_grc_policy_manage - Unified GRC Policy lifecycle management
 *
 * Manages the policy lifecycle in the GRC: Policy and Compliance Management
 * plugin. Wraps the sn_compliance_policy, sn_compliance_policy_statement,
 * sn_compliance_control_objective, and sn_compliance_control tables.
 *
 * Companion to snow_create_security_policy (which authors a generic security
 * policy record) and snow_compliance_manage (which handles the downstream
 * exception/evidence/attestation flow on individual controls). This tool
 * focuses on the policy artifact itself — drafting a policy, attaching
 * the statements that make it up, and linking those statements to the
 * control objectives they are meant to satisfy.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

// TODO: verify table names against a live instance. Policy & Compliance ships
// as `sn_compliance_*` on Tokyo+. Older instances and certain GRC variants
// expose the same tables under `sn_grc_*` (notably `sn_grc_policy` and
// `sn_grc_control_objective`).
const TABLE_POLICY = "sn_compliance_policy"
const TABLE_STATEMENT = "sn_compliance_policy_statement"
const TABLE_OBJECTIVE = "sn_compliance_control_objective"
const TABLE_CONTROL = "sn_compliance_control"

const PLUGIN_NAME = "GRC: Policy and Compliance Management (com.sn_compliance)"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_grc_policy_manage",
  description: `Unified tool for ServiceNow GRC policy authoring and linkage. Wraps the sn_compliance_policy, sn_compliance_policy_statement, sn_compliance_control_objective, and sn_compliance_control tables that ship with the GRC: Policy and Compliance Management plugin.

Actions:
- list_policies — list policies, optionally filtered by state, type, or framework
- get_policy — retrieve a single policy by sys_id (includes counts of linked statements)
- create_policy — draft a new policy with owner, type, and effective date
- create_statement — add a policy statement (clause / requirement) to an existing policy
- link_to_control — link a policy statement to a control objective, attaching the policy intent to the control framework
- list_controls — list controls, optionally filtered by objective or active flag

Use when: the agent needs to draft a new GRC policy, break it into statements, and connect those statements to the control objectives that operationalise them. For the downstream exception / evidence / attestation flow on individual controls, use snow_compliance_manage; for the generic security policy record, use snow_create_security_policy.

Returns: policy rows with sys_id, owner, type, state, effective_date; statement rows with sys_id, policy reference, statement_text; control objective and control rows with sys_id, name, and reference linkage. GRC plugin gating: the first call against these tables will surface a clear error if the GRC: Policy and Compliance Management plugin is not active on the target instance.`,
  category: "security",
  subcategory: "policies",
  use_cases: ["grc", "policy", "compliance", "controls", "statements"],
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
          "list_policies",
          "get_policy",
          "create_policy",
          "create_statement",
          "link_to_control",
          "list_controls",
        ],
      },
      // Identifiers
      policy_sys_id: {
        type: "string",
        description: "[get_policy/create_statement] Policy sys_id",
      },
      statement_sys_id: {
        type: "string",
        description: "[link_to_control] Statement sys_id (sn_compliance_policy_statement)",
      },
      objective_sys_id: {
        type: "string",
        description: "[link_to_control/list_controls] Control objective sys_id (sn_compliance_control_objective)",
      },
      // LIST_POLICIES filters
      state: {
        type: "string",
        description: "[list_policies] Filter by policy state",
        enum: ["draft", "review", "approved", "published", "retired"],
      },
      policy_type: {
        type: "string",
        description: "[list_policies] Filter by policy type label",
      },
      framework: {
        type: "string",
        description: "[list_policies] Filter by compliance framework (SOX, GDPR, HIPAA, ISO27001, etc.)",
      },
      limit: {
        type: "number",
        description: "[list_policies/list_controls] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list_policies/get_policy/list_controls] Comma-separated list of fields to return",
      },
      // CREATE_POLICY
      name: {
        type: "string",
        description: "[create_policy] Policy name / title (required)",
      },
      description: {
        type: "string",
        description: "[create_policy] Policy description / scope",
      },
      owner: {
        type: "string",
        description: "[create_policy] Policy owner sys_user sys_id",
      },
      type: {
        type: "string",
        description: "[create_policy] Policy type label (information_security, privacy, operational, hr, financial, custom)",
      },
      effective_date: {
        type: "string",
        description: "[create_policy] ISO date string (YYYY-MM-DD) when the policy takes effect",
      },
      review_date: {
        type: "string",
        description: "[create_policy] ISO date string (YYYY-MM-DD) when the policy is next due for review",
      },
      // CREATE_STATEMENT
      statement_text: {
        type: "string",
        description: "[create_statement] Statement / clause text",
      },
      statement_short_description: {
        type: "string",
        description: "[create_statement] Short description for the statement",
      },
      statement_number: {
        type: "string",
        description: "[create_statement] Optional clause number or identifier (e.g. 4.1.2)",
      },
      // LINK_TO_CONTROL (no extra fields beyond statement_sys_id + objective_sys_id)
      // LIST_CONTROLS
      active_only: {
        type: "boolean",
        description: "[list_controls] Only return active controls",
        default: false,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "list_policies":
        return await executeListPolicies(args, context)
      case "get_policy":
        return await executeGetPolicy(args, context)
      case "create_policy":
        return await executeCreatePolicy(args, context)
      case "create_statement":
        return await executeCreateStatement(args, context)
      case "link_to_control":
        return await executeLinkToControl(args, context)
      case "list_controls":
        return await executeListControls(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: list_policies, get_policy, create_policy, create_statement, link_to_control, list_controls`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error & { response?: { status?: number } }
    if (err.response?.status === 404) {
      return createErrorResult(
        new SnowFlowError(
          ErrorType.PLUGIN_MISSING,
          `GRC policy table not found. The ${PLUGIN_NAME} plugin may not be active on this instance. Confirm that sn_compliance_policy and sn_compliance_control_objective tables exist.`,
          { originalError: err },
        ),
      )
    }
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `GRC policy ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function findPolicy(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  sysId: string,
): Promise<Record<string, unknown> | null> {
  const direct = await client.get(`/api/now/table/${TABLE_POLICY}/${sysId}`)
  if (direct.data.result && direct.data.result.sys_id) {
    return direct.data.result
  }
  return null
}

// ==================== LIST_POLICIES ====================

async function executeListPolicies(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const state = args.state as string | undefined
  const policy_type = args.policy_type as string | undefined
  const framework = args.framework as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (state) queryParts.push(`state=${state}`)
  if (policy_type) queryParts.push(`type=${policy_type}`)
  if (framework) queryParts.push(`framework=${framework}`)

  const response = await client.get(`/api/now/table/${TABLE_POLICY}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "name",
      sysparm_display_value: "true",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,number,name,owner,type,state,framework,effective_date,review_date,sys_updated_on" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_policies",
    count: results.length,
    policies: results.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      name: r.name,
      owner: r.owner,
      type: r.type,
      state: r.state,
      framework: r.framework,
      effective_date: r.effective_date,
      review_date: r.review_date,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_POLICY}.do?sys_id=${r.sys_id}`,
    })),
  })
}

// ==================== GET_POLICY ====================

async function executeGetPolicy(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const policy_sys_id = args.policy_sys_id as string | undefined

  if (!policy_sys_id) {
    return createErrorResult("policy_sys_id is required for get_policy action")
  }

  const client = await getAuthenticatedClient(context)
  const policy = await findPolicy(client, policy_sys_id)
  if (!policy) {
    return createErrorResult(`Policy not found: ${policy_sys_id}`)
  }

  let statementCount = 0
  try {
    const statements = await client.get(`/api/now/table/${TABLE_STATEMENT}`, {
      params: { sysparm_query: `policy=${policy_sys_id}`, sysparm_fields: "sys_id", sysparm_limit: 500 },
    })
    statementCount = (statements.data.result || []).length
  } catch {
    // TODO: verify statement -> policy reference column on a live instance.
  }

  return createSuccessResult({
    action: "get_policy",
    sys_id: policy_sys_id,
    policy,
    related: {
      statement_count: statementCount,
    },
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_POLICY}.do?sys_id=${policy_sys_id}`,
  })
}

// ==================== CREATE_POLICY ====================

async function executeCreatePolicy(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const name = args.name as string | undefined

  if (!name) {
    return createErrorResult("name is required for create_policy action")
  }

  const client = await getAuthenticatedClient(context)

  const payload: Record<string, unknown> = {
    name,
    state: "draft",
  }
  if (args.description) payload.description = args.description
  if (args.owner) payload.owner = args.owner
  if (args.type) payload.type = args.type
  if (args.effective_date) payload.effective_date = args.effective_date
  if (args.review_date) payload.review_date = args.review_date

  const response = await client.post(`/api/now/table/${TABLE_POLICY}`, payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "create_policy",
    created: true,
    sys_id: created.sys_id,
    name: created.name,
    policy: created,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_POLICY}.do?sys_id=${created.sys_id}`,
  })
}

// ==================== CREATE_STATEMENT ====================

async function executeCreateStatement(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const policy_sys_id = args.policy_sys_id as string | undefined
  const statement_text = args.statement_text as string | undefined

  if (!policy_sys_id) {
    return createErrorResult("policy_sys_id is required for create_statement action")
  }
  if (!statement_text) {
    return createErrorResult("statement_text is required for create_statement action")
  }

  const client = await getAuthenticatedClient(context)
  const policy = await findPolicy(client, policy_sys_id)
  if (!policy) {
    return createErrorResult(`Policy not found: ${policy_sys_id}`)
  }

  // TODO: verify sn_compliance_policy_statement column set on a live
  // instance. Common fields: policy (ref), statement (text), number,
  // short_description.
  const payload: Record<string, unknown> = {
    policy: policy_sys_id,
    statement: statement_text,
  }
  if (args.statement_short_description) payload.short_description = args.statement_short_description
  if (args.statement_number) payload.number = args.statement_number

  const response = await client.post(`/api/now/table/${TABLE_STATEMENT}`, payload)
  const created = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "create_statement",
    created: true,
    sys_id: created.sys_id,
    policy: { sys_id: policy_sys_id, name: policy.name },
    statement: created,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_STATEMENT}.do?sys_id=${created.sys_id}`,
  })
}

// ==================== LINK_TO_CONTROL ====================

async function executeLinkToControl(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const statement_sys_id = args.statement_sys_id as string | undefined
  const objective_sys_id = args.objective_sys_id as string | undefined

  if (!statement_sys_id) {
    return createErrorResult("statement_sys_id is required for link_to_control action")
  }
  if (!objective_sys_id) {
    return createErrorResult("objective_sys_id is required for link_to_control action")
  }

  const client = await getAuthenticatedClient(context)

  // Verify both records exist before linking.
  const statementCheck = await client.get(`/api/now/table/${TABLE_STATEMENT}/${statement_sys_id}`)
  if (!statementCheck.data.result || !statementCheck.data.result.sys_id) {
    return createErrorResult(`Policy statement not found: ${statement_sys_id}`)
  }
  const objectiveCheck = await client.get(`/api/now/table/${TABLE_OBJECTIVE}/${objective_sys_id}`)
  if (!objectiveCheck.data.result || !objectiveCheck.data.result.sys_id) {
    return createErrorResult(`Control objective not found: ${objective_sys_id}`)
  }

  // TODO: verify how policy statements link to control objectives on a live
  // instance. On Tokyo+ Policy and Compliance Management the canonical link
  // is a reference field `content` on sn_compliance_control_objective that
  // points at sn_compliance_policy_statement. Some implementations use a
  // dedicated m2m table `sn_compliance_m2m_objective_statement`. We patch
  // the objective's `content` field first; if that fails the caller should
  // retry against the m2m table.
  const patchResponse = await client.patch(`/api/now/table/${TABLE_OBJECTIVE}/${objective_sys_id}`, {
    content: statement_sys_id,
  })
  const updated = patchResponse.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "link_to_control",
    linked: true,
    statement_sys_id,
    objective_sys_id,
    control_objective: updated,
    url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_OBJECTIVE}.do?sys_id=${objective_sys_id}`,
  })
}

// ==================== LIST_CONTROLS ====================

async function executeListControls(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const objective_sys_id = args.objective_sys_id as string | undefined
  const active_only = args.active_only === true
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (objective_sys_id) queryParts.push(`content=${objective_sys_id}`)
  if (active_only) queryParts.push("active=true")

  const response = await client.get(`/api/now/table/${TABLE_CONTROL}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      sysparm_orderby: "name",
      sysparm_display_value: "true",
      ...(fields
        ? { sysparm_fields: fields }
        : { sysparm_fields: "sys_id,number,name,content,owner,compliance,active,sys_updated_on" }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>

  return createSuccessResult({
    action: "list_controls",
    count: results.length,
    controls: results.map((r) => ({
      sys_id: r.sys_id,
      number: r.number,
      name: r.name,
      content: r.content,
      owner: r.owner,
      compliance: r.compliance,
      active: r.active,
      updated_at: r.sys_updated_on,
      url: `${context.instanceUrl}/nav_to.do?uri=${TABLE_CONTROL}.do?sys_id=${r.sys_id}`,
    })),
  })
}

export const version = "1.0.0"
export const author = "groeimetai"
