/**
 * snow_hr_profile_manage - Unified HR profile management
 *
 * Wraps the HRSD employee profile surface: sn_hr_core_profile, the canonical
 * employee record consumed by every HR case.
 *
 * Companion to snow_create_hr_case and snow_create_hr_task — those tools
 * open work against an employee, and this tool maintains the underlying
 * employee record they reference.
 *
 * Requires the HR Core plugin (com.sn_hr_core).
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_hr_profile_manage",
  description: `Unified tool for ServiceNow HR employee profiles (sn_hr_core_profile). Searches join through profile.user reference for sys_user fields (department, email, active).

Actions:
- get_profile — fetch a profile by sys_id, user sys_id, or employee_number
- update_profile — patch profile fields (employment_type, position, primary_job, location, personal_email, work_mobile, mobile_phone, im_name)
- search_employees — search profiles by name, email, department, or employee_number

Use when: the agent needs to read or maintain the canonical employee record used across all HR cases. Companion tools: snow_create_hr_case (opens HR tickets against a profile), snow_create_hr_task (creates task work on a case), snow_hr_lifecycle_event (drives onboarding/offboarding flows).

Requires the HR Core plugin (com.sn_hr_core). When the plugin is missing the underlying tables don't exist and the tool returns a clear plugin-missing error.`,
  category: "itsm",
  subcategory: "hr",
  use_cases: ["hr-service-delivery", "employee-profile", "hr-core"],
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
        enum: ["get_profile", "update_profile", "search_employees"],
      },
      // Identification
      sys_id: {
        type: "string",
        description: "[get_profile/update_profile] Profile sys_id",
      },
      user: {
        type: "string",
        description: "[get_profile] sys_user sys_id (alternative to sys_id)",
      },
      employee_number: {
        type: "string",
        description: "[get_profile/search_employees/update_profile] Employee number (alternative to sys_id)",
      },
      // UPDATE fields (real columns on sn_hr_core_profile)
      employment_type: {
        type: "string",
        description: "[update_profile] Employment type (e.g. full_time, part_time, contractor)",
      },
      position: {
        type: "string",
        description: "[update_profile] sn_hr_core_position sys_id",
      },
      primary_job: {
        type: "string",
        description: "[update_profile] sn_hr_core_job sys_id",
      },
      location: {
        type: "string",
        description: "[update_profile] cmn_location sys_id",
      },
      personal_email: {
        type: "string",
        description: "[update_profile] Personal email address",
      },
      work_mobile: {
        type: "string",
        description: "[update_profile] Work mobile phone number",
      },
      mobile_phone: {
        type: "string",
        description: "[update_profile] Mobile phone number",
      },
      im_name: {
        type: "string",
        description: "[update_profile] Instant-message / display name",
      },
      // SEARCH fields
      name: {
        type: "string",
        description: "[search_employees] Substring match against legal_first_name and im_name (OR'd)",
      },
      email: {
        type: "string",
        description: "[search_employees] Email substring match (dot-walks through user.email on sys_user)",
      },
      department: {
        type: "string",
        description: "[search_employees] Department substring match (dot-walks through user.department on sys_user)",
      },
      // Listing
      active_only: {
        type: "boolean",
        description: "[search_employees] Only return profiles whose linked sys_user is active",
        default: true,
      },
      limit: {
        type: "number",
        description: "[search_employees] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[get_profile/search_employees] Comma-separated list of fields to return",
      },
    },
    required: ["action"],
  },
}

const PROFILE_TABLE = "sn_hr_core_profile"

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "get_profile":
        return await executeGetProfile(args, context)
      case "update_profile":
        return await executeUpdateProfile(args, context)
      case "search_employees":
        return await executeSearchEmployees(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: get_profile, update_profile, search_employees`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error & { response?: { status?: number } }
    if (err.response?.status === 404 || /Invalid table/i.test(err.message || "")) {
      return createErrorResult(
        new SnowFlowError(
          ErrorType.PLUGIN_MISSING,
          `HR Core profile tables not found. Install the com.sn_hr_core plugin and verify ${PROFILE_TABLE} exists.`,
          { originalError: err },
        ),
      )
    }
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `HR profile ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function findProfile(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const sys_id = args.sys_id as string | undefined
  const user = args.user as string | undefined
  const employee_number = args.employee_number as string | undefined

  if (sys_id) {
    const direct = await client.get(`/api/now/table/${PROFILE_TABLE}/${sys_id}`)
    if (direct.data.result && direct.data.result.sys_id) return direct.data.result
  }

  const orParts: string[] = []
  if (user) orParts.push(`user=${user}`)
  if (employee_number) orParts.push(`employee_number=${employee_number}`)
  if (orParts.length === 0) return null

  const search = await client.get(`/api/now/table/${PROFILE_TABLE}`, {
    params: {
      sysparm_query: orParts.join("^OR"),
      sysparm_limit: 1,
    },
  })
  const results = (search.data.result || []) as Array<Record<string, unknown>>
  return results.length > 0 ? results[0] : null
}

// ==================== GET_PROFILE ====================

async function executeGetProfile(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  if (!args.sys_id && !args.user && !args.employee_number) {
    return createErrorResult("sys_id, user, or employee_number is required for get_profile")
  }

  const client = await getAuthenticatedClient(context)
  const profile = await findProfile(client, args)
  if (!profile) {
    return createErrorResult(`Profile not found: ${args.sys_id || args.user || args.employee_number}`)
  }

  return createSuccessResult({
    action: "get_profile",
    sys_id: profile.sys_id,
    profile,
    url: `${context.instanceUrl}/nav_to.do?uri=${PROFILE_TABLE}.do?sys_id=${profile.sys_id}`,
  })
}

// ==================== UPDATE_PROFILE ====================

async function executeUpdateProfile(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  if (!args.sys_id && !args.user && !args.employee_number) {
    return createErrorResult("sys_id, user, or employee_number is required for update_profile")
  }

  const client = await getAuthenticatedClient(context)
  const profile = await findProfile(client, args)
  if (!profile) {
    return createErrorResult(`Profile not found: ${args.sys_id || args.user || args.employee_number}`)
  }

  // Real columns on sn_hr_core_profile (verified against sys_dictionary on a live HRSD instance).
  // Customer-specific custom fields are intentionally not exposed — agents should add them
  // through a follow-up table-update call.
  const updatable = [
    "employment_type",
    "position",
    "primary_job",
    "location",
    "personal_email",
    "work_mobile",
    "mobile_phone",
    "im_name",
  ]
  const patch: Record<string, unknown> = {}
  for (const key of updatable) {
    if (args[key] !== undefined) patch[key] = args[key]
  }

  if (Object.keys(patch).length === 0) {
    return createErrorResult(
      "No update fields provided. Valid: employment_type, position, primary_job, location, personal_email, work_mobile, mobile_phone, im_name",
    )
  }

  const targetSysId = profile.sys_id as string
  const response = await client.patch(`/api/now/table/${PROFILE_TABLE}/${targetSysId}`, patch)
  const updated = response.data.result as Record<string, unknown>

  return createSuccessResult({
    action: "update_profile",
    updated: true,
    sys_id: targetSysId,
    updated_fields: Object.keys(patch),
    profile: updated,
    url: `${context.instanceUrl}/nav_to.do?uri=${PROFILE_TABLE}.do?sys_id=${targetSysId}`,
  })
}

// ==================== SEARCH_EMPLOYEES ====================

async function executeSearchEmployees(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const name = args.name as string | undefined
  const email = args.email as string | undefined
  const employee_number = args.employee_number as string | undefined
  const department = args.department as string | undefined
  const active_only = args.active_only !== false
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  if (!name && !email && !employee_number && !department) {
    return createErrorResult("At least one of name, email, employee_number, or department is required for search_employees")
  }

  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  // sn_hr_core_profile has no `name` column; the tool searches the two real name fields OR'd.
  if (name) queryParts.push(`legal_first_nameLIKE${name}^ORim_nameLIKE${name}`)
  // Dot-walk through the user reference for sys_user-side fields (email, department, active).
  if (email) queryParts.push(`user.emailLIKE${email}`)
  if (employee_number) queryParts.push(`employee_number=${employee_number}`)
  if (department) queryParts.push(`user.departmentLIKE${department}`)
  if (active_only) queryParts.push("user.active=true")

  const response = await client.get(`/api/now/table/${PROFILE_TABLE}`, {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_limit: limit,
      ...(fields
        ? { sysparm_fields: fields }
        : {
            sysparm_fields:
              "sys_id,user,employee_number,legal_first_name,im_name,personal_email,location,position,primary_job",
          }),
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>
  return createSuccessResult({
    action: "search_employees",
    count: results.length,
    employees: results.map((r) => ({
      sys_id: r.sys_id,
      user: r.user,
      employee_number: r.employee_number,
      legal_first_name: r.legal_first_name,
      im_name: r.im_name,
      personal_email: r.personal_email,
      location: r.location,
      position: r.position,
      primary_job: r.primary_job,
      url: `${context.instanceUrl}/nav_to.do?uri=${PROFILE_TABLE}.do?sys_id=${r.sys_id}`,
    })),
  })
}

export const version = "1.1.0"
export const author = "groeimetai"
