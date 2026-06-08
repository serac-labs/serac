import type { ExtendedAxiosInstance } from "./auth.js"

const BASE = "/api/sn_uibtk_api/buildertoolkit"

export function btk(path: string): string {
  return `${BASE}${path}`
}

/**
 * Resolve the `uib_app_shell` macroponent sys_id on the current instance.
 *
 * Previously this lookup was memoized at module scope, which would hand out
 * tenant A's sys_id to tenant B in an HTTP multi-tenant server — sys_ids
 * are per-instance. The cache is now removed; each call performs a fresh
 * lookup. In practice this runs at most a handful of times per workspace
 * creation, so the overhead is negligible.
 */
export async function getAppShellUI(client: ExtendedAxiosInstance): Promise<string> {
  const response = await client.get("/api/now/table/sys_ux_macroponent", {
    params: {
      sysparm_query: "name=uib_app_shell^category=app_shell",
      sysparm_fields: "sys_id",
      sysparm_limit: 1,
    },
  })

  const id = response.data.result?.[0]?.sys_id
  if (id) return id

  const fallback = await client.get("/api/now/table/sys_ux_macroponent", {
    params: {
      sysparm_query: "name=x_snc_app_shell_uib_app_shell^category=app_shell",
      sysparm_fields: "sys_id",
      sysparm_limit: 1,
    },
  })
  const fallbackId = fallback.data.result?.[0]?.sys_id
  if (!fallbackId) throw new Error("Could not find appShellUI macroponent (uib_app_shell) on this instance")
  return fallbackId
}
