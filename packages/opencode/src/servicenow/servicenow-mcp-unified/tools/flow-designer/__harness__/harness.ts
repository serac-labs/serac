/**
 * Flow Designer live test harness.
 *
 * Drives the real snow_manage_flow tool against a live ServiceNow instance so
 * flow-authoring changes can be verified end-to-end (build → publish → confirm
 * the server actually compiled a snapshot) instead of guessed. Intended for
 * interactive/iterative development of the Flow Designer tooling.
 *
 * Credentials come from env (never hardcode):
 *   SN_INSTANCE       e.g. https://dev123456.service-now.com
 *   SN_CLIENT_ID      OAuth client id (client_credentials grant)
 *   SN_CLIENT_SECRET  OAuth client secret
 *
 * The resolved OAuth user needs Flow Designer admin rights on the instance.
 * Use a throwaway PDI — this creates and publishes real flow records.
 */
import { getAuthenticatedClient } from "../../../shared/auth.js"
import { execute } from "../snow_manage_flow.js"
import type { ServiceNowContext } from "../../../shared/types.js"

export function pdiContext(): ServiceNowContext {
  const instance = process.env.SN_INSTANCE
  const clientId = process.env.SN_CLIENT_ID
  const clientSecret = process.env.SN_CLIENT_SECRET
  if (!instance || !clientId || !clientSecret) {
    throw new Error("Set SN_INSTANCE, SN_CLIENT_ID and SN_CLIENT_SECRET in the environment")
  }
  return {
    instanceUrl: instance.replace(/\/$/, ""),
    clientId,
    clientSecret,
    tenantId: "stdio",
    transport: "stdio",
  } as ServiceNowContext
}

/** Run one tool action and return its parsed ToolResult. */
export async function run(action: string, args: Record<string, any> = {}): Promise<any> {
  return execute({ action, ...args }, pdiContext())
}

/** Pull the primary JSON payload out of a ToolResult's content. */
export function payload(result: any): any {
  const text = result?.content?.[0]?.text
  if (!text) return result
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text }
  }
}

/** Delete every flow whose name starts with the given prefix. Returns count removed. */
export async function cleanup(prefix: string): Promise<number> {
  const client = await getAuthenticatedClient(pdiContext())
  const resp = await client.get("/api/now/table/sys_hub_flow", {
    params: { sysparm_query: "nameSTARTSWITH" + prefix, sysparm_fields: "sys_id,name", sysparm_limit: 200 },
  })
  const rows = resp.data?.result || []
  for (const row of rows) {
    await run("delete", { flow_id: row.sys_id }).catch(() => {})
  }
  return rows.length
}
