/**
 * snow_source_control - Bridge to the ServiceNow Studio Source Control plugin
 *
 * Wraps the platform's git-style Source Control operations so agents can
 * manage branches, status, commits, and stashes against a ServiceNow
 * application's linked repository from inside an MCP session.
 *
 * The Source Control REST surface (`/api/sn_source_control/...`) is not
 * uniformly documented across releases — every action below is built from
 * the documented Studio UI semantics and marked with a TODO where the
 * exact endpoint or response shape needs verification against a live
 * instance with the Source Control plugin enabled.
 *
 * Companion to snow_artifact_manage (which writes artifacts) and the
 * update-set tooling (which is the platform-native alternative to source
 * control for change tracking).
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_source_control",
  description: `Unified tool for the ServiceNow Studio Source Control plugin. Bridges git-style operations against an application's linked repository (status, push, pull, branch, commit, diff, stash) through the platform's Source Control REST endpoints under /api/sn_source_control.

Actions:
- status — show working-copy status (changed/added/deleted records) for an application
- push — push local commits to the remote tracking branch
- pull — pull and apply remote changes onto the working copy
- branch — list, create, switch, or delete branches on the application's repository
- commit — commit the working copy with a message
- diff — show the diff for a specific record or for the whole working copy
- stash — list, create, apply, or drop stashes against the working copy

Use when: the agent needs to interact with a scoped application that is linked to a git repository (Studio Source Control) and the user wants git-equivalent operations from within the platform. Prefer update sets for environments that do not use source control.

Returns: action-specific result envelopes. For status/diff: per-record change rows. For push/pull/commit: operation summary. For branch/stash: the resulting branch or stash record. All paths are best-effort against published Source Control plugin docs and require live-instance verification before relying on them in production.`,
  category: "devops",
  subcategory: "devops",
  use_cases: ["devops", "source-control", "git", "branching", "studio"],
  complexity: "advanced",
  frequency: "low",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Source-control action to perform",
        enum: ["status", "push", "pull", "branch", "commit", "diff", "stash"],
      },
      app_sys_id: {
        type: "string",
        description: "sys_id of the scoped application (sys_app) whose repository is targeted",
      },
      app_scope: {
        type: "string",
        description: "Alternative to app_sys_id: scope name (e.g. x_company_module). The tool will resolve it to a sys_app sys_id.",
      },
      // BRANCH parameters
      branch_action: {
        type: "string",
        description: "[branch] Sub-action",
        enum: ["list", "create", "switch", "delete"],
      },
      branch_name: {
        type: "string",
        description: "[branch] Branch name (required for create/switch/delete)",
      },
      from_branch: {
        type: "string",
        description: "[branch action=create] Source branch to branch off (defaults to current)",
      },
      // COMMIT parameters
      commit_message: {
        type: "string",
        description: "[commit] Commit message",
      },
      // PUSH / PULL parameters
      remote_branch: {
        type: "string",
        description: "[push/pull] Remote branch to push to / pull from (defaults to tracking branch)",
      },
      // DIFF parameters
      record_sys_id: {
        type: "string",
        description: "[diff] Specific record sys_id to diff (omit for working-copy-wide diff)",
      },
      // STASH parameters
      stash_action: {
        type: "string",
        description: "[stash] Sub-action",
        enum: ["list", "create", "apply", "drop"],
      },
      stash_name: {
        type: "string",
        description: "[stash] Stash name (required for create/apply/drop)",
      },
      stash_message: {
        type: "string",
        description: "[stash action=create] Optional stash description",
      },
      // Common
      credentials_alias: {
        type: "string",
        description: "Alias for stored repository credentials (sys_repo_credential), if remote auth is required",
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "status":
        return await executeStatus(args, context)
      case "push":
        return await executePush(args, context)
      case "pull":
        return await executePull(args, context)
      case "branch":
        return await executeBranch(args, context)
      case "commit":
        return await executeCommit(args, context)
      case "diff":
        return await executeDiff(args, context)
      case "stash":
        return await executeStash(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: status, push, pull, branch, commit, diff, stash`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `Source control ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

async function resolveAppSysId(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  args: Record<string, unknown>,
): Promise<string> {
  const app_sys_id = args.app_sys_id as string | undefined
  if (app_sys_id) return app_sys_id

  const app_scope = args.app_scope as string | undefined
  if (!app_scope) {
    throw new SnowFlowError(
      ErrorType.VALIDATION_ERROR,
      "app_sys_id or app_scope is required to identify the target application",
    )
  }

  const response = await client.get("/api/now/table/sys_app", {
    params: {
      sysparm_query: `scope=${app_scope}^ORname=${app_scope}`,
      sysparm_limit: 1,
      sysparm_fields: "sys_id,name,scope",
    },
  })

  const results = (response.data.result || []) as Array<Record<string, unknown>>
  if (results.length === 0) {
    throw new SnowFlowError(ErrorType.NOT_FOUND, `Application with scope/name '${app_scope}' not found`)
  }
  return results[0].sys_id as string
}

// ==================== STATUS ====================

async function executeStatus(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const client = await getAuthenticatedClient(context)
  const appSysId = await resolveAppSysId(client, args)

  // TODO: verify against live instance — best-effort from docs.
  // The Studio UI invokes a scripted endpoint like /api/sn_source_control/status?app=<sys_id>.
  // We try that path first; on 404 we fall back to the documented sys_repo_status table
  // (some releases expose status as records on sys_repo_status rather than via REST).
  let working: unknown
  try {
    const response = await client.get(`/api/sn_source_control/status`, {
      params: { app: appSysId },
    })
    working = response.data.result ?? response.data
  } catch (e: unknown) {
    // TODO: verify sys_repo_status table name on a live instance
    const fallback = await client.get("/api/now/table/sys_repo_status", {
      params: { sysparm_query: `app=${appSysId}`, sysparm_limit: 500 },
    })
    working = fallback.data.result
  }

  return createSuccessResult({
    action: "status",
    app_sys_id: appSysId,
    working_copy: working,
    note: "Source Control plugin must be installed and the application must be linked to a repository.",
  })
}

// ==================== PUSH ====================

async function executePush(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const remote_branch = args.remote_branch as string | undefined
  const credentials_alias = args.credentials_alias as string | undefined

  const client = await getAuthenticatedClient(context)
  const appSysId = await resolveAppSysId(client, args)

  // TODO: verify against live instance — best-effort from docs.
  const payload: Record<string, unknown> = { app: appSysId }
  if (remote_branch) payload.remote_branch = remote_branch
  if (credentials_alias) payload.credentials = credentials_alias

  const response = await client.post(`/api/sn_source_control/push`, payload)

  return createSuccessResult({
    action: "push",
    app_sys_id: appSysId,
    remote_branch: remote_branch || "(tracking branch)",
    result: response.data.result ?? response.data,
  })
}

// ==================== PULL ====================

async function executePull(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const remote_branch = args.remote_branch as string | undefined
  const credentials_alias = args.credentials_alias as string | undefined

  const client = await getAuthenticatedClient(context)
  const appSysId = await resolveAppSysId(client, args)

  // TODO: verify against live instance — best-effort from docs.
  const payload: Record<string, unknown> = { app: appSysId }
  if (remote_branch) payload.remote_branch = remote_branch
  if (credentials_alias) payload.credentials = credentials_alias

  const response = await client.post(`/api/sn_source_control/pull`, payload)

  return createSuccessResult({
    action: "pull",
    app_sys_id: appSysId,
    remote_branch: remote_branch || "(tracking branch)",
    result: response.data.result ?? response.data,
  })
}

// ==================== BRANCH ====================

async function executeBranch(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const branch_action = (args.branch_action as string) || "list"
  const branch_name = args.branch_name as string | undefined
  const from_branch = args.from_branch as string | undefined

  const client = await getAuthenticatedClient(context)
  const appSysId = await resolveAppSysId(client, args)

  if (branch_action !== "list" && !branch_name) {
    return createErrorResult(`branch_name is required for branch_action='${branch_action}'`)
  }

  switch (branch_action) {
    case "list": {
      // TODO: verify against live instance — best-effort from docs.
      // The platform exposes branches either through a REST helper or the sys_repo_branch table.
      try {
        const response = await client.get(`/api/sn_source_control/branches`, { params: { app: appSysId } })
        return createSuccessResult({
          action: "branch",
          branch_action,
          app_sys_id: appSysId,
          branches: response.data.result ?? response.data,
        })
      } catch {
        // TODO: verify sys_repo_branch table name on a live instance
        const fallback = await client.get("/api/now/table/sys_repo_branch", {
          params: { sysparm_query: `app=${appSysId}`, sysparm_limit: 200 },
        })
        return createSuccessResult({
          action: "branch",
          branch_action,
          app_sys_id: appSysId,
          branches: fallback.data.result,
        })
      }
    }
    case "create": {
      const payload: Record<string, unknown> = { app: appSysId, name: branch_name }
      if (from_branch) payload.from = from_branch
      const response = await client.post(`/api/sn_source_control/branch`, payload)
      return createSuccessResult({
        action: "branch",
        branch_action,
        app_sys_id: appSysId,
        branch: response.data.result ?? response.data,
      })
    }
    case "switch": {
      const response = await client.post(`/api/sn_source_control/checkout`, {
        app: appSysId,
        branch: branch_name,
      })
      return createSuccessResult({
        action: "branch",
        branch_action,
        app_sys_id: appSysId,
        current_branch: branch_name,
        result: response.data.result ?? response.data,
      })
    }
    case "delete": {
      const response = await client.post(`/api/sn_source_control/branch/delete`, {
        app: appSysId,
        branch: branch_name,
      })
      return createSuccessResult({
        action: "branch",
        branch_action,
        app_sys_id: appSysId,
        deleted_branch: branch_name,
        result: response.data.result ?? response.data,
      })
    }
    default:
      return createErrorResult(`Unknown branch_action: ${branch_action}`)
  }
}

// ==================== COMMIT ====================

async function executeCommit(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const commit_message = args.commit_message as string | undefined

  if (!commit_message) {
    return createErrorResult("commit_message is required for commit action")
  }

  const client = await getAuthenticatedClient(context)
  const appSysId = await resolveAppSysId(client, args)

  // TODO: verify against live instance — best-effort from docs.
  const response = await client.post(`/api/sn_source_control/commit`, {
    app: appSysId,
    message: commit_message,
  })

  return createSuccessResult({
    action: "commit",
    app_sys_id: appSysId,
    message: commit_message,
    result: response.data.result ?? response.data,
  })
}

// ==================== DIFF ====================

async function executeDiff(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const record_sys_id = args.record_sys_id as string | undefined

  const client = await getAuthenticatedClient(context)
  const appSysId = await resolveAppSysId(client, args)

  // TODO: verify against live instance — best-effort from docs.
  const params: Record<string, unknown> = { app: appSysId }
  if (record_sys_id) params.record = record_sys_id

  const response = await client.get(`/api/sn_source_control/diff`, { params })

  return createSuccessResult({
    action: "diff",
    app_sys_id: appSysId,
    record_sys_id: record_sys_id || null,
    diff: response.data.result ?? response.data,
  })
}

// ==================== STASH ====================

async function executeStash(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const stash_action = (args.stash_action as string) || "list"
  const stash_name = args.stash_name as string | undefined
  const stash_message = args.stash_message as string | undefined

  const client = await getAuthenticatedClient(context)
  const appSysId = await resolveAppSysId(client, args)

  if (stash_action !== "list" && !stash_name) {
    return createErrorResult(`stash_name is required for stash_action='${stash_action}'`)
  }

  switch (stash_action) {
    case "list": {
      // TODO: verify against live instance — best-effort from docs.
      try {
        const response = await client.get(`/api/sn_source_control/stashes`, { params: { app: appSysId } })
        return createSuccessResult({
          action: "stash",
          stash_action,
          app_sys_id: appSysId,
          stashes: response.data.result ?? response.data,
        })
      } catch {
        // TODO: verify sys_repo_stash table name on a live instance
        const fallback = await client.get("/api/now/table/sys_repo_stash", {
          params: { sysparm_query: `app=${appSysId}`, sysparm_limit: 200 },
        })
        return createSuccessResult({
          action: "stash",
          stash_action,
          app_sys_id: appSysId,
          stashes: fallback.data.result,
        })
      }
    }
    case "create": {
      const payload: Record<string, unknown> = { app: appSysId, name: stash_name }
      if (stash_message) payload.message = stash_message
      const response = await client.post(`/api/sn_source_control/stash`, payload)
      return createSuccessResult({
        action: "stash",
        stash_action,
        app_sys_id: appSysId,
        stash: response.data.result ?? response.data,
      })
    }
    case "apply": {
      const response = await client.post(`/api/sn_source_control/stash/apply`, {
        app: appSysId,
        name: stash_name,
      })
      return createSuccessResult({
        action: "stash",
        stash_action,
        app_sys_id: appSysId,
        applied_stash: stash_name,
        result: response.data.result ?? response.data,
      })
    }
    case "drop": {
      const response = await client.post(`/api/sn_source_control/stash/drop`, {
        app: appSysId,
        name: stash_name,
      })
      return createSuccessResult({
        action: "stash",
        stash_action,
        app_sys_id: appSysId,
        dropped_stash: stash_name,
        result: response.data.result ?? response.data,
      })
    }
    default:
      return createErrorResult(`Unknown stash_action: ${stash_action}`)
  }
}

export const version = "1.0.0"
export const author = "groeimetai"
