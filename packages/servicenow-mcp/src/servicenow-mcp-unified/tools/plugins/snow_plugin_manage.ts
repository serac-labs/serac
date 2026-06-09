/**
 * snow_plugin_manage - Unified Plugin Management
 *
 * Single tool for all ServiceNow plugin operations:
 * list, check, activate, deactivate.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_plugin_manage",
  description: `Manage ServiceNow plugins: list, check status, activate, deactivate, repair, or poll an async progress.

Actions:
- list — Search and list plugins. Filter by name/ID, show only active.
- check — Get detailed info on a specific plugin (status, version, dependencies). Pass verify_table to also query sys_db_object for a table the plugin should have created — covers the case where v_plugin reports inactive but the plugin's tables actually exist (known v_plugin staleness after CICD activation).
- activate — Activate a plugin via CICD API (/api/sn_cicd/plugin) with sys_plugins table-PATCH fallback. Returns the progress_id so callers can poll completion. Pass wait=true to block until the plugin reaches a final state (or timeout_ms elapses, default 10 min).
- deactivate — Deactivate a plugin via the same dual mechanism.
- repair — Rollback the plugin then re-activate it (clean reinstall). Returns both progress_ids; pass wait=true to block until the activate phase completes. Requires plugin-activation privileges in ServiceNow.
- progress — Poll a CICD progress record (/api/sn_cicd/progress/{id}) by progress_id. Use to check status of an earlier activate/repair without blocking.

Examples:
- { action: "list", search: "incident" }
- { action: "check", plugin_id: "com.snc.incident" }
- { action: "activate", plugin_id: "com.snc.incident", wait: true }
- { action: "repair", plugin_id: "com.snc.incident" }
- { action: "progress", progress_id: "1227ba16937083101bf5f99bdd03d60c" }`,
  category: "advanced",
  subcategory: "administration",
  use_cases: ["plugin-discovery", "plugin-management", "plugin-status", "activation", "deactivation"],
  complexity: "intermediate",
  frequency: "low",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Operation to perform",
        enum: ["list", "check", "activate", "deactivate", "repair", "progress"],
      },
      plugin_id: {
        type: "string",
        description: '[check/activate/deactivate/repair] Plugin identifier (e.g. "com.snc.incident") or sys_id',
      },
      verify_table: {
        type: "string",
        description: '[check] Optional table name the plugin should have created (e.g. "wm_order" for FSM). When provided, the tool also queries sys_db_object — handles the known case where v_plugin reports inactive but the plugin\'s tables exist (post-activation v_plugin lag).',
      },
      search: {
        type: "string",
        description: '[list] Filter by plugin name or ID (e.g. "incident", "com.snc")',
      },
      active_only: {
        type: "boolean",
        description: "[list] Only show active plugins",
        default: false,
      },
      limit: {
        type: "number",
        description: "[list] Max results to return (default 50)",
        default: 50,
      },
      progress_id: {
        type: "string",
        description: "[progress] CICD progress record sys_id, returned by a prior activate/repair call",
      },
      wait: {
        type: "boolean",
        description: "[activate/repair] Block until the install reaches a final state (Successful/Failed/Cancelled) or timeout_ms elapses. Default false — return progress_id immediately for async polling via the progress action.",
        default: false,
      },
      timeout_ms: {
        type: "number",
        description: "[activate/repair when wait=true] Max time to wait in milliseconds. Default 600000 (10 min).",
        default: 600000,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { action } = args
  try {
    switch (action) {
      case "list":
        return await executeList(args, context)
      case "check":
        return await executeCheck(args, context)
      case "activate":
        return await executeActivate(args, context)
      case "deactivate":
        return await executeDeactivate(args, context)
      case "repair":
        return await executeRepair(args, context)
      case "progress":
        return await executeProgress(args, context)
      default:
        return createErrorResult(
          "Unknown action: " + action + ". Valid actions: list, check, activate, deactivate, repair, progress",
        )
    }
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

// ==================== LIST ====================
async function executeList(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { search, active_only = false, limit = 50 } = args
  const client = await getAuthenticatedClient(context)

  const queryParts: string[] = []
  if (search) {
    queryParts.push("nameLIKE" + search + "^ORidLIKE" + search)
  }
  if (active_only) {
    queryParts.push("active=true")
  }

  const response = await client.get("/api/now/table/v_plugin", {
    params: {
      sysparm_query: queryParts.join("^"),
      sysparm_fields: "sys_id,id,name,active,version,description",
      sysparm_limit: limit,
      sysparm_display_value: "true",
    },
  })

  const plugins = response.data.result || []
  const activeCount = plugins.filter((p: any) => p.active === "true" || p.active === true).length
  const inactiveCount = plugins.length - activeCount

  const summary =
    "Found " +
    plugins.length +
    " plugin(s)" +
    (search ? ' matching "' + search + '"' : "") +
    ". Active: " +
    activeCount +
    ", Inactive: " +
    inactiveCount +
    "."

  return createSuccessResult(
    { action: "list", plugins, count: plugins.length },
    { active_count: activeCount, inactive_count: inactiveCount },
    summary,
  )
}

// ==================== CHECK ====================
async function executeCheck(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { plugin_id, verify_table } = args
  if (!plugin_id) return createErrorResult("plugin_id is required for check action")

  const client = await getAuthenticatedClient(context)

  const response = await client.get("/api/now/table/v_plugin", {
    params: {
      sysparm_query: "id=" + plugin_id + "^ORsys_id=" + plugin_id,
      sysparm_fields: "sys_id,id,name,active,version,description,parent,optional,licensable",
      sysparm_limit: 1,
      sysparm_display_value: "true",
    },
  })

  const results = response.data.result || []
  if (results.length === 0) {
    return createErrorResult("Plugin not found: " + plugin_id)
  }

  const plugin = results[0]
  const v_plugin_active = plugin.active === "true" || plugin.active === true

  // Optional second signal — does the plugin's expected table exist?
  // Covers the known case where v_plugin reports inactive after a CICD
  // activation that did finish (the view is stale until the next refresh).
  let table_check: { table: string; exists: boolean } | null = null
  if (verify_table) {
    try {
      const tableResp = await client.get("/api/now/table/sys_db_object", {
        params: {
          sysparm_query: "name=" + verify_table,
          sysparm_fields: "name,label",
          sysparm_limit: 1,
        },
      })
      const tableRows = tableResp.data.result || []
      table_check = { table: verify_table, exists: tableRows.length > 0 }
    } catch {
      table_check = { table: verify_table, exists: false }
    }
  }

  // Reconcile both signals.
  let status: "active" | "inactive" | "installed_v_plugin_stale" | "anomalous_table_missing"
  let summary: string
  if (v_plugin_active && (table_check === null || table_check.exists)) {
    status = "active"
    summary =
      'Plugin "' + plugin.name + '" (' + plugin.id + ") is ACTIVE. Version: " + (plugin.version || "unknown") + "."
  } else if (!v_plugin_active && table_check && table_check.exists) {
    status = "installed_v_plugin_stale"
    summary =
      'Plugin "' +
      plugin.name +
      '" (' +
      plugin.id +
      ") is INSTALLED — table " +
      verify_table +
      " exists despite v_plugin reporting inactive (known v_plugin staleness after CICD activation). Treat as active."
  } else if (v_plugin_active && table_check && !table_check.exists) {
    status = "anomalous_table_missing"
    summary =
      'Plugin "' +
      plugin.name +
      '" (' +
      plugin.id +
      ") shows ACTIVE in v_plugin but expected table " +
      verify_table +
      " does not exist. Possible partial install or wrong verify_table value."
  } else {
    status = "inactive"
    summary =
      'Plugin "' +
      plugin.name +
      '" (' +
      plugin.id +
      ") is INACTIVE." +
      (table_check ? " Expected table " + verify_table + " also not present." : "")
  }

  return createSuccessResult(
    { action: "check", plugin, v_plugin_active, table_check, status },
    { status },
    summary,
  )
}

// ==================== ACTIVATE ====================
async function executeActivate(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { plugin_id } = args
  if (!plugin_id) return createErrorResult("plugin_id is required for activate action")

  const client = await getAuthenticatedClient(context)
  const plugin = await lookupPlugin(client, plugin_id)
  if (!plugin) return createErrorResult("Plugin not found: " + plugin_id)

  if (plugin.active === "true" || plugin.active === true) {
    return createSuccessResult(
      { action: "activate", plugin, activated: false, already_active: true },
      {},
      'Plugin "' + plugin.name + '" (' + plugin.id + ") is already active.",
    )
  }

  const { wait = false, timeout_ms = 600000 } = args
  const { success, method, progress_id, status_label, error } = await togglePlugin(client, plugin, "activate")
  if (!success) return createErrorResult(error!)

  // Sync mode: block until the CICD progress record reaches a final state.
  if (wait && progress_id) {
    const { result: progress, timed_out } = await waitForProgress(client, progress_id, timeout_ms)
    const verified = await verifyPluginState(client, plugin.sys_id, true)
    const finalStatus = progress.status_label || "?"
    const summary = timed_out
      ? 'Activation of "' + plugin.name + '" timed out after ' + timeout_ms + "ms (last status: " + finalStatus + ")."
      : 'Plugin "' + plugin.name + '" (' + plugin.id + ") finished activation: " + finalStatus + "."
    return createSuccessResult(
      { action: "activate", plugin, activated: true, verified, method, progress_id, progress, timed_out },
      {},
      summary,
    )
  }

  // Async mode (default): return immediately, caller polls via `progress`.
  const verified = await verifyPluginState(client, plugin.sys_id, true)
  const summary = verified
    ? 'Plugin "' + plugin.name + '" (' + plugin.id + ") activated successfully via " + method + "."
    : 'Activation request sent for "' +
      plugin.name +
      '" via ' +
      method +
      (progress_id ? " — progress_id " + progress_id + " (poll with action=progress)." : ".")

  return createSuccessResult(
    { action: "activate", plugin, activated: true, verified, method, progress_id, status_label },
    {},
    summary,
  )
}

// ==================== DEACTIVATE ====================
async function executeDeactivate(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { plugin_id } = args
  if (!plugin_id) return createErrorResult("plugin_id is required for deactivate action")

  const client = await getAuthenticatedClient(context)
  const plugin = await lookupPlugin(client, plugin_id)
  if (!plugin) return createErrorResult("Plugin not found: " + plugin_id)

  if (plugin.active !== "true" && plugin.active !== true) {
    return createSuccessResult(
      { action: "deactivate", plugin, deactivated: false, already_inactive: true },
      {},
      'Plugin "' + plugin.name + '" (' + plugin.id + ") is already inactive.",
    )
  }

  const { success, method, error } = await togglePlugin(client, plugin, "deactivate")
  if (!success) return createErrorResult(error!)

  const verified = await verifyPluginState(client, plugin.sys_id, false)
  const summary = verified
    ? 'Plugin "' + plugin.name + '" (' + plugin.id + ") deactivated successfully via " + method + "."
    : 'Deactivation request sent for "' + plugin.name + '" via ' + method + ". May take a moment to fully deactivate."

  return createSuccessResult({ action: "deactivate", plugin, deactivated: true, verified, method }, {}, summary)
}

// ==================== HELPERS ====================

async function lookupPlugin(client: any, pluginId: string): Promise<any | null> {
  const response = await client.get("/api/now/table/v_plugin", {
    params: {
      sysparm_query: "id=" + pluginId + "^ORsys_id=" + pluginId,
      sysparm_fields: "sys_id,id,name,active",
      sysparm_limit: 1,
    },
  })
  const results = response.data.result || []
  return results.length > 0 ? results[0] : null
}

async function togglePlugin(
  client: any,
  plugin: any,
  operation: "activate" | "deactivate" | "rollback",
): Promise<{ success: boolean; method: string; progress_id?: string; status_label?: string; error?: string }> {
  // Try CICD Plugin API first. Successful CICD POSTs return a progress
  // record sys_id we surface for async polling via the `progress` action.
  try {
    const response = await client.post(
      "/api/sn_cicd/plugin/" + encodeURIComponent(plugin.id) + "/" + operation,
    )
    const result = response?.data?.result || {}
    const progress_id = result?.links?.progress?.id || undefined
    return {
      success: true,
      method: "cicd_api",
      progress_id,
      status_label: result.status_label,
    }
  } catch (cicdError: any) {
    const status = cicdError.response ? cicdError.response.status : 0
    if (status === 404 || status === 400) {
      // Fallback to sys_plugins PATCH (no progress tracking available here).
      try {
        const activeValue = operation === "activate" ? "true" : "false"
        await client.patch("/api/now/table/sys_plugins/" + plugin.sys_id, { active: activeValue })
        return { success: true, method: "table_api" }
      } catch (patchError: any) {
        return {
          success: false,
          method: "",
          error:
            "Failed to " +
            operation +
            " plugin via both CICD API and Table API. CICD: " +
            (cicdError.message || "unknown") +
            ". Table API: " +
            (patchError.message || "unknown"),
        }
      }
    }
    return { success: false, method: "", error: "CICD Plugin API error: " + (cicdError.message || "unknown") }
  }
}

// Map CICD progress.status numeric/string values to a human label.
// 0=Pending, 1=Running, 2=Successful, 3=Failed, 4=Cancelled.
function isFinalStatus(status: any): boolean {
  const s = String(status)
  return s === "2" || s === "3" || s === "4"
}

async function fetchProgress(client: any, progressId: string): Promise<any> {
  const response = await client.get("/api/sn_cicd/progress/" + encodeURIComponent(progressId))
  return response?.data?.result || {}
}

// Block until the CICD progress record reaches a final state, or the
// timeout elapses. Polls every 10 seconds. Returns the last fetched
// result so callers can surface percent / message / error_message.
async function waitForProgress(
  client: any,
  progressId: string,
  timeoutMs: number,
): Promise<{ result: any; timed_out: boolean }> {
  const start = Date.now()
  let result: any = {}
  while (Date.now() - start < timeoutMs) {
    result = await fetchProgress(client, progressId)
    if (isFinalStatus(result.status)) return { result, timed_out: false }
    await new Promise((resolve) => setTimeout(resolve, 10000))
  }
  return { result, timed_out: true }
}

async function verifyPluginState(client: any, sysId: string, expectActive: boolean): Promise<boolean> {
  try {
    const response = await client.get("/api/now/table/v_plugin", {
      params: {
        sysparm_query: "sys_id=" + sysId,
        sysparm_fields: "active",
        sysparm_limit: 1,
      },
    })
    const results = response.data.result || []
    if (results.length === 0) return false
    const isActive = results[0].active === "true" || results[0].active === true
    return expectActive ? isActive : !isActive
  } catch {
    return false
  }
}

// ==================== REPAIR ====================
// Repair = rollback then activate (clean reinstall). Useful when a plugin
// got into a partial / corrupted state. Two CICD calls back-to-back; the
// activate phase is the long one (often 5-15 min for big plugins).
async function executeRepair(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { plugin_id, wait = false, timeout_ms = 600000 } = args
  if (!plugin_id) return createErrorResult("plugin_id is required for repair action")

  const client = await getAuthenticatedClient(context)
  const plugin = await lookupPlugin(client, plugin_id)
  if (!plugin) return createErrorResult("Plugin not found: " + plugin_id)

  // Phase 1: rollback. Skip if already inactive — there's nothing to roll back.
  let rollback_progress_id: string | undefined
  let rollback_method: string | undefined
  if (plugin.active === "true" || plugin.active === true) {
    const rb = await togglePlugin(client, plugin, "rollback")
    if (!rb.success) {
      return createErrorResult("Repair phase 1 (rollback) failed: " + (rb.error || "unknown"))
    }
    rollback_progress_id = rb.progress_id
    rollback_method = rb.method
    if (wait && rb.progress_id) {
      const { timed_out } = await waitForProgress(client, rb.progress_id, timeout_ms)
      if (timed_out) {
        return createErrorResult(
          "Repair phase 1 (rollback) timed out after " + timeout_ms + "ms (progress_id: " + rb.progress_id + ")",
        )
      }
    }
  }

  // Phase 2: activate. The interesting one — this is where the install runs.
  const act = await togglePlugin(client, plugin, "activate")
  if (!act.success) {
    return createErrorResult(
      "Repair phase 2 (activate) failed: " +
        (act.error || "unknown") +
        ". Phase 1 (rollback) did succeed — plugin is now inactive.",
    )
  }

  if (wait && act.progress_id) {
    const { result: progress, timed_out } = await waitForProgress(client, act.progress_id, timeout_ms)
    const verified = await verifyPluginState(client, plugin.sys_id, true)
    const finalStatus = progress.status_label || "?"
    const summary = timed_out
      ? 'Repair of "' + plugin.name + '" timed out in activate phase after ' + timeout_ms + "ms (last: " + finalStatus + ")."
      : 'Plugin "' + plugin.name + '" (' + plugin.id + ") repaired (rollback + reactivate): " + finalStatus + "."
    return createSuccessResult(
      {
        action: "repair",
        plugin,
        rollback_progress_id,
        rollback_method,
        activate_progress_id: act.progress_id,
        activate_method: act.method,
        progress,
        verified,
        timed_out,
      },
      {},
      summary,
    )
  }

  return createSuccessResult(
    {
      action: "repair",
      plugin,
      rollback_progress_id,
      rollback_method,
      activate_progress_id: act.progress_id,
      activate_method: act.method,
      status_label: act.status_label,
    },
    {},
    'Repair started for "' +
      plugin.name +
      '" (' +
      plugin.id +
      ")" +
      (act.progress_id ? " — activate progress_id " + act.progress_id + " (poll with action=progress)." : "."),
  )
}

// ==================== PROGRESS ====================
async function executeProgress(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { progress_id } = args
  if (!progress_id) return createErrorResult("progress_id is required for progress action")

  const client = await getAuthenticatedClient(context)
  const result = await fetchProgress(client, progress_id)
  if (!result || Object.keys(result).length === 0) {
    return createErrorResult("Progress record not found: " + progress_id)
  }

  const status_label = result.status_label || "?"
  const percent = result.percent_complete != null ? Number(result.percent_complete) : null
  const summary =
    "Progress " +
    progress_id +
    ": " +
    status_label +
    (percent != null ? " (" + percent + "%)" : "") +
    (isFinalStatus(result.status) ? " — final" : " — still running")

  return createSuccessResult(
    {
      action: "progress",
      progress_id,
      status: result.status,
      status_label,
      percent_complete: percent,
      message: result.status_message || result.message,
      error_message: result.error_message,
      final: isFinalStatus(result.status),
      raw: result,
    },
    {},
    summary,
  )
}

export const version = "1.1.1"
export const author = "Serac"
