/**
 * snow_diagnose_setup - Explain why ServiceNow calls fail
 *
 * The model's half of the diagnostic. `servicenow-mcp-stdio --doctor` prints
 * the same report in a terminal, but an MCP server usually runs inside a client
 * that hides its stderr, so the person who has to fix the OAuth entry never
 * sees it. Here the report comes back in the conversation, where they are.
 *
 * Everything it knows lives in shared/setup-doctor.ts.
 *
 * Why this is not snow_test_connection / snow_check_health /
 * snow_validate_live_connection / snow_auth_diagnostics: all four start with
 * `getAuthenticatedClient()`, so when the credentials are the problem they
 * fail with the same opaque error the user already had, before they can report
 * anything. snow_auth_diagnostics is the closest by name, and the one a search
 * for "authentication diagnostics" is most likely to surface — it reports on a
 * connection that already works. This one never goes through the auth manager.
 * It observes the raw
 * responses — status, content-type, body — and classifies them, which is the
 * only way to say "that is a hibernation page, not a parse bug" about a
 * response that arrives as HTTP 200.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult } from "../../shared/error-handler.js"
import { renderReport, runSetupDoctor } from "../../shared/setup-doctor.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_diagnose_setup",
  description:
    "Diagnose the ServiceNow connection: which credential source was used (environment variables, auth.json, enterprise portal), whether the instance URL is well-formed, whether the instance is awake or hibernating, whether the OAuth token exchange succeeds, and which roles the authenticated account holds. Call this when a tool fails with an authentication error, a 401, or a response that will not parse as JSON — a hibernating developer instance answers with an HTML login page, and every tool then looks like it has a parse bug. Returns a report naming the broken link and what to do about it.",
  category: "platform",
  subcategory: "diagnostics",
  use_cases: [
    "setup",
    "authentication",
    "credentials",
    "oauth",
    "connection",
    "hibernating",
    "troubleshooting",
    "roles",
  ],
  complexity: "beginner",
  frequency: "medium",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  // stdio only, and not for the usual filesystem reason: the report names this
  // process's environment variables and auth.json files. On HTTP one process
  // serves every customer, so that report would describe the server's own
  // configuration to whichever tenant asked for it.
  transports: ["stdio"],
  inputSchema: {
    type: "object",
    properties: {},
  },
}

export async function execute(_args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const report = await runSetupDoctor({ context })
  // Always a success envelope: the diagnosis ran. Whether the setup is healthy
  // is `report.ok`, and an error envelope here would read as "the diagnostic
  // failed" and invite a retry.
  return createSuccessResult(report, { ok: report.ok }, renderReport(report))
}

export const version = "1.0.0"
export const author = "Serac"
