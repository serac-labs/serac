/**
 * Re-bind the instance's current update set to a chat's update set.
 *
 * Separate from update-set-guard.ts (which stays pure / hermetically testable):
 * this needs the authenticated ServiceNow client. Mirrors exactly what
 * snow_ensure_active_update_set does for `sync_with_user` — flag the set as
 * current and point the user's preference at it — so a config write lands in
 * the chat's set even after another chat moved the per-user current set away.
 */

import { ServiceNowContext } from "./types.js"
import { getAuthenticatedClient } from "./auth.js"

export async function setCurrentUpdateSet(context: ServiceNowContext, sysId: string): Promise<void> {
  const client = await getAuthenticatedClient(context)
  await client.put(`/api/now/table/sys_update_set/${sysId}`, { is_current: true })
  await client.post("/api/now/table/sys_user_preference", {
    name: "sys.update_set",
    value: sysId,
    user: "current",
  })
}
