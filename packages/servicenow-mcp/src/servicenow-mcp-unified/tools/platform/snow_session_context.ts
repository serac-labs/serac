/**
 * snow_session_context - Inspect the current ServiceNow session
 *
 * Returns in one call: authenticated user, roles (direct + inherited),
 * current update set, domain, timezone, locale. Replaces the 3-4
 * scattered queries agents usually issue to build this picture.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_session_context",
  description:
    "Dump the current ServiceNow session context for the authenticated user: sys_id, username, email, roles (with inherited flag), current update set, domain, timezone, locale. One call instead of 3-4 scattered queries. Use this to ground ACL / role-based reasoning before running a script or diagnosing permissions.",
  category: "platform",
  subcategory: "session",
  use_cases: ["debugging", "acl", "roles", "update-sets", "session-inspection"],
  complexity: "beginner",
  frequency: "medium",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      include_inherited_roles: {
        type: "boolean",
        description: "Return inherited roles in addition to directly granted ones. Default: true.",
        default: true,
      },
    },
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const includeInherited = args.include_inherited_roles !== false

  const client = await getAuthenticatedClient(context)

  const userPromise = client.get("/api/now/table/sys_user", {
    params: {
      sysparm_query: "sys_id=javascript:gs.getUserID()",
      sysparm_fields: "sys_id,user_name,name,email,time_zone,locale,active,last_login_time,sys_domain,department,location",
      sysparm_display_value: "true",
      sysparm_limit: 1,
    },
  })

  const rolesPromise = client.get("/api/now/table/sys_user_has_role", {
    params: {
      sysparm_query: includeInherited
        ? "user=javascript:gs.getUserID()"
        : "user=javascript:gs.getUserID()^inherited=false",
      sysparm_fields: "role.name,inherited,granted_by.name",
      sysparm_display_value: "true",
      sysparm_limit: 500,
    },
  })

  const updateSetPrefPromise = client.get("/api/now/table/sys_user_preference", {
    params: {
      sysparm_query: "user=javascript:gs.getUserID()^name=sys_update_set",
      sysparm_fields: "value",
      sysparm_limit: 1,
    },
  })

  const caught = await Promise.all([
    userPromise.catch((err: Error) => ({ __error: err.message || "user lookup failed" })),
    rolesPromise.catch((err: Error) => ({ __error: err.message || "roles lookup failed" })),
    updateSetPrefPromise.catch((err: Error) => ({ __error: err.message || "update-set preference lookup failed" })),
  ])

  const userResp = caught[0]
  if ("__error" in userResp) {
    return createErrorResult(
      new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Session context failed: ${userResp.__error}`),
    )
  }

  const user = userResp.data?.result?.[0]
  if (!user) {
    return createErrorResult("Could not resolve current user (gs.getUserID() returned nothing).")
  }

  const rolesResp = caught[1]
  const rolesRows = "__error" in rolesResp ? [] : ((rolesResp.data?.result ?? []) as Array<Record<string, string>>)

  const roles = rolesRows.map((row) => ({
    name: row["role.name"],
    inherited: row.inherited === "true",
    granted_by: row["granted_by.name"] || undefined,
  }))

  const updateSetRef = caught[2]
  const updateSetSysId =
    "__error" in updateSetRef ? undefined : (updateSetRef.data?.result?.[0]?.value as string | undefined)

  const updateSet = updateSetSysId
    ? await client
        .get(`/api/now/table/sys_update_set/${updateSetSysId}`, {
          params: { sysparm_fields: "sys_id,name,state,description,application.name,is_default" },
        })
        .then((r: { data: { result?: Record<string, string> } }) => r.data?.result)
        .catch(() => undefined)
    : undefined

  const roleNames = roles.map((r) => r.name).sort()
  const directRoles = roles.filter((r) => !r.inherited).map((r) => r.name)

  const result = {
    user: {
      sys_id: user.sys_id,
      user_name: user.user_name,
      name: user.name,
      email: user.email,
      active: user.active === "true",
      last_login: user.last_login_time,
      timezone: user.time_zone,
      locale: user.locale,
      department: user.department,
      location: user.location,
    },
    domain: user.sys_domain,
    roles: {
      all: roleNames,
      direct: directRoles,
      total_count: roles.length,
      details: roles,
    },
    update_set: updateSet
      ? {
          sys_id: updateSet.sys_id,
          name: updateSet.name,
          state: updateSet.state,
          description: updateSet.description,
          application: updateSet["application.name"],
          is_default: updateSet.is_default === "true",
        }
      : null,
    instance_url: context.instanceUrl,
  }

  const summary = [
    `User: ${result.user.name} <${result.user.email}> (${result.user.user_name})`,
    `Roles: ${roleNames.length} total, ${directRoles.length} direct`,
    `Update set: ${result.update_set ? result.update_set.name : "none (using Default)"}`,
    `Timezone: ${result.user.timezone || "unknown"}`,
  ].join("\n")

  return createSuccessResult(result, { role_count: roleNames.length }, summary)
}

export const version = "1.0.0"
export const author = "Serac SDK"
