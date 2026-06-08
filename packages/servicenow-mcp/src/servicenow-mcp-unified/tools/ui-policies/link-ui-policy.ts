/**
 * Shared helper to link a sys_ui_policy_action record to its parent UI policy.
 *
 * ServiceNow's REST Table API POST silently ignores the "ui_policy" reference
 * field on sys_ui_policy_action during creation. This module provides a
 * cascading fallback (PATCH → PUT → GlideRecord) to set the reference after
 * the record has been created.
 */

import type { AxiosInstance } from "axios"

/**
 * Verify that the ui_policy reference field is set on a sys_ui_policy_action record.
 */
export async function verifyUiPolicyLink(
  client: AxiosInstance,
  actionSysId: string,
  expectedSysId: string,
): Promise<boolean> {
  try {
    const res = await client.get(
      "/api/now/table/sys_ui_policy_action/" + actionSysId + "?sysparm_fields=ui_policy",
    )
    const ref = res.data.result?.ui_policy
    const val = typeof ref === "object" && ref !== null ? ref.value : ref
    return !!val && val !== "" && val === expectedSysId
  } catch {
    return false
  }
}

/**
 * Attempt to link a sys_ui_policy_action record to its parent UI policy using
 * a cascading fallback chain:
 *   Tier 1 — PATCH (standard Table API update)
 *   Tier 2 — PUT   (full record update)
 *   Tier 3 — GlideRecord via Scripted REST endpoint (last resort)
 *
 * Returns true if the link was successfully set and verified.
 */
export async function linkUiPolicyReference(
  client: AxiosInstance,
  actionSysId: string,
  uiPolicySysId: string,
): Promise<boolean> {
  const url = "/api/now/table/sys_ui_policy_action/" + actionSysId
  const body = { ui_policy: uiPolicySysId }

  // Tier 1: PATCH
  try {
    await client.patch(url, body)
    if (await verifyUiPolicyLink(client, actionSysId, uiPolicySysId)) return true
  } catch {
    // fall through
  }

  // Tier 2: PUT
  try {
    await client.put(url, body)
    if (await verifyUiPolicyLink(client, actionSysId, uiPolicySysId)) return true
  } catch {
    // fall through
  }

  // Tier 3: GlideRecord via Scripted REST endpoint
  try {
    const script =
      "var gr = new GlideRecord('sys_ui_policy_action');\n" +
      "gr.get('" + actionSysId + "');\n" +
      "gr.setValue('ui_policy', '" + uiPolicySysId + "');\n" +
      "gr.update();\n" +
      "gs.print(gr.getValue('ui_policy'));"

    await client.post("/api/snow_flow_exec/execute", {
      script,
      execution_id: "link_ui_policy_" + actionSysId,
    })
    if (await verifyUiPolicyLink(client, actionSysId, uiPolicySysId)) return true
  } catch {
    // all tiers exhausted
  }

  return false
}
