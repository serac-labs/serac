/**
 * snow_install_application — retired in place, kept only as a signpost.
 *
 * What this tool used to do: POST { sys_id, version } to
 * /api/now/table/sys_store_app and return
 * createSuccessResult({ installed: true, application: <the row the Table API
 * echoed back> }). Inserting a row into sys_store_app does not install an
 * application; it creates a record. So every "installed: true" this tool ever
 * returned was fabricated, and each call left a junk row on the instance.
 *
 * ServiceNow's documented way to install an application from the Application
 * Repository is the CI/CD API — POST /api/sn_cicd/app_repo/install, which is
 * asynchronous and reports through a progress record:
 * https://www.servicenow.com/docs/bundle/yokohama-api-reference/page/integrate/inbound-rest/concept/cicd-api.html
 * snow_app_repo_manage speaks it. Answering here with a different API's
 * semantics under this tool's name would repeat the original mistake, so this
 * executor makes no request at all and says where to go instead.
 *
 * The name is kept rather than deleted so callers that already reference it get
 * the redirect instead of "unknown tool", and so its sn-roles.manifest.json
 * entry does not go stale (that manifest is produced by a live-instance probe
 * and cannot be regenerated in CI).
 */

import { type MCPToolDefinition, type ToolResult } from "../../shared/types.js"
import { createErrorResult } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_install_application",
  description:
    '[DEPRECATED - use snow_app_repo_manage] Performs no operation and returns an error. It used to insert a row into sys_store_app and report that as an install; a row insert installs nothing. Install through the documented CI/CD Application Repository API instead: snow_app_repo_manage({ action: "install", scope: "x_acme_myapp", version: "1.2.0" }).',
  // Metadata for tool discovery (not sent to LLM)
  category: "development",
  subcategory: "applications",
  // Deliberately not "app-install" / "deployment" any more: discovery by use
  // case must land on the tool that actually installs, not on this signpost.
  use_cases: ["deprecated"],
  complexity: "beginner",
  frequency: "low",

  // Permission enforcement
  // Classification: READ — this executor issues no request to the instance and
  // cannot change anything. Left as "write" it would sit behind the prod-write
  // and update-set guards (shared/update-set-guard.ts), so a caller would be
  // told to open an update set before they could be told the tool is retired.
  permission: "read",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      app_id: {
        type: "string",
        description: "Ignored. Pass it as app_sys_id to snow_app_repo_manage instead.",
      },
      version: {
        type: "string",
        description: "Ignored. Pass it as version to snow_app_repo_manage instead.",
      },
    },
    required: [],
  },
}

export async function execute(args: Record<string, unknown>): Promise<ToolResult> {
  const identifier = typeof args?.app_id === "string" && args.app_id.length > 0 ? args.app_id : "<app sys_id>"
  const wanted = typeof args?.version === "string" && args.version.length > 0 ? args.version : undefined
  return createErrorResult(
    `snow_install_application is retired and did not install anything. It wrote a row to sys_store_app and called that an install, which it is not. ` +
      `Use the CI/CD Application Repository API instead: snow_app_repo_manage({ action: "install", app_sys_id: "${identifier}"${wanted ? `, version: "${wanted}"` : ""} }) — ` +
      `or pass scope instead of app_sys_id. That endpoint installs onto the instance you are authenticated to, and the application must already be published to the Application Repository (snow_app_repo_manage action "publish", run against the instance that owns the app).`,
  )
}

export const version = "2.0.0"
export const author = "Serac"
