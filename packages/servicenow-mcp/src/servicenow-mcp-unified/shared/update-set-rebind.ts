/**
 * Re-bind the instance's current update set to a chat's update set.
 *
 * Separate from update-set-guard.ts (which stays pure / hermetically testable):
 * this needs the authenticated ServiceNow client. Mirrors exactly what
 * snow_ensure_active_update_set does for `sync_with_user` — flag the set as
 * current and point the user's preference at it — so a config write lands in
 * the chat's set even after another chat moved the per-user current set away.
 */

import type { ServiceNowContext } from "./types.js"
import { getAuthenticatedClient } from "./auth.js"

export async function setCurrentUpdateSet(context: ServiceNowContext, sysId: string): Promise<void> {
  const client = await getAuthenticatedClient(context)
  await client.put(`/api/now/table/sys_update_set/${sysId}`, { is_current: true })

  // Upsert the user's sys.update_set preference rather than POSTing a new row
  // every time — the drift re-bind can fire on each chat switch, and a blind
  // POST would accumulate duplicate preference rows for the same user.
  const existing = await client
    .get("/api/now/table/sys_user_preference", {
      params: {
        sysparm_query: "name=sys.update_set^user=javascript:gs.getUserID()",
        sysparm_fields: "sys_id",
        sysparm_limit: "1",
      },
    })
    .catch(() => null)
  const prefSysId = existing?.data?.result?.[0]?.sys_id as string | undefined
  if (prefSysId) {
    await client.put(`/api/now/table/sys_user_preference/${prefSysId}`, { value: sysId })
  } else {
    await client.post("/api/now/table/sys_user_preference", {
      name: "sys.update_set",
      value: sysId,
      user: "current",
    })
  }
}
