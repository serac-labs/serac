/**
 * MCP `CallTool` request handler.
 *
 * Dispatches a tool invocation:
 *   - meta-tools (tool_search, tool_execute) short-circuit
 *   - deferred tools require session enablement
 *   - regular tools go through permission check + retryable execution
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import { toolRegistry } from "../shared/tool-registry.js"
import { executeWithErrorHandling, SnowFlowError, classifyError } from "../shared/error-handler.js"
import { validatePermission, validateJWTExpiry } from "../shared/permission-validator.js"
import { tool_search_exec, tool_execute_exec } from "../tools/meta/index.js"
import { ToolSearch } from "../shared/tool-search.js"
import { resolveTenantScope, STDIO_TENANT } from "../shared/tenant-scope.js"
import { mcpDebug } from "../../shared/mcp-debug.js"
import { formatArgsForLogging, isRetryableOperation } from "../shared/handler-helpers.js"
import { reportArtifactToInstanceMap, isWriteTool } from "../shared/instance-map-hook.js"
import {
  guardKey,
  observeUpdateSetTool,
  recordUpdateSetSkip,
  requiresUpdateSet,
  updateSetActive,
  confirmationFlag,
  prodWriteBlockMessage,
  updateSetBlockMessage,
  getActiveUpdateSet,
  driftScope,
  needsCurrentReassert,
  markCurrentAsserted,
} from "../shared/update-set-guard.js"
import { setCurrentUpdateSet } from "../shared/update-set-rebind.js"
import { type HandlerDeps } from "./types.js"

export const callTool = (deps: HandlerDeps) => async (request: any, extra?: any) => {
  const { name, arguments: args } = request.params

  // Enhanced logging: show tool name AND key parameters
  const logArgs = formatArgsForLogging(args)
  mcpDebug(`[Server] Executing tool: ${name}`)
  if (logArgs) {
    mcpDebug(`[Server]   Parameters: ${logArgs}`)
  }

  const ctx = await deps.resolveContext(request, extra)
  // Fail fast if an HTTP resolver forgets to set tenantId — see list-tools.ts.
  if (ctx.origin === "http" && !ctx.serviceNow.tenantId) {
    throw new Error(
      "HTTP transport resolver must populate serviceNow.tenantId — refusing to execute the tool to avoid cross-tenant leaks.",
    )
  }
  const sessionId = ctx.sessionId
  const context = ctx.serviceNow

  try {
    // 🆕 Handle meta-tools (tool_search, tool_execute) for lazy loading mode
    if (name === "tool_search") {
      mcpDebug("[Server] Executing meta-tool: tool_search")
      // Pass sessionId to enable session-based tool enabling, and origin so
      // the meta path can filter stdio-only tools out of HTTP discovery.
      const contextWithSession = { ...context, sessionId, origin: ctx.origin }
      const result = await tool_search_exec(args as any, contextWithSession)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    }

    if (name === "tool_execute") {
      mcpDebug("[Server] Executing meta-tool: tool_execute")
      // Pass sessionId for potential future use, and origin so tool_execute
      // enforces the same transport allowlist as the direct dispatch below —
      // without it the meta path would bypass the stdio-only guard.
      const contextWithSession = { ...context, sessionId, origin: ctx.origin }
      const result = await tool_execute_exec(args as any, contextWithSession)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    }

    // Get tool from registry
    const tool = toolRegistry.getTool(name)
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`)
    }

    // Transport-level allowlist: tools that touch the machine-local filesystem
    // are marked `transports: ["stdio"]` so the HTTP transport refuses them.
    // Tools with no declared transports are considered available everywhere.
    const allowed = tool.definition.transports
    if (allowed && !allowed.includes(ctx.origin)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Tool "${name}" is not available over the ${ctx.origin} transport ` +
          `(allowed transports: ${allowed.join(", ")}).`,
      )
    }

    // Per-arg HTTP-safety check. Tools that are mostly HTTP-safe but
    // accept a few caller-supplied filesystem paths (snow_artifact_manage's
    // `*_file` / `export_path` / `artifact_directory`, snow_pull_artifact's
    // `output_dir`) declare those args in `httpForbiddenArgs`. The rest of
    // the tool surface stays available on HTTP — only the unsafe args reject.
    const forbidden = tool.definition.httpForbiddenArgs
    if (ctx.origin === "http" && forbidden && args && typeof args === "object") {
      for (const arg of forbidden) {
        if ((args as Record<string, unknown>)[arg] !== undefined) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Tool "${name}" cannot accept the "${arg}" argument over HTTP transport ` +
              `(it would touch the shared filesystem). Use the inline-content ` +
              `equivalent (e.g. \`script\`, \`template\`, \`server_script\`, \`client_script\`, ` +
              `\`css\`, \`option_schema\`, or \`data\`) instead, and write outputs to the ` +
              `portal sandbox via the native \`write\` tool.`,
          )
        }
      }
    }

    // Check if tool is deferred and needs to be enabled first.
    // Pass tenantId so the ToolSessionStore scopes its lookup correctly
    // (stdio uses "stdio"; HTTP uses the tenant's customerId).
    //
    // HTTP callers (the portal chat) manage their own tool-enablement
    // state on the client side — they decide which tools to expose to
    // the LLM and trust the LLM's choice. The server-side deferred
    // check is a token-optimization for stdio (smaller catalog = fewer
    // tokens per request) and would otherwise require the caller to
    // duplicate enablement state over HTTP, which they currently don't.
    // So we skip the check on HTTP and let permission/feature gates
    // below do the real access control.
    //
    // Scope resolution goes through the same helper tools/meta/index.ts writes
    // with — see list-tools.ts. This branch only runs on stdio, where the
    // scope is always the "stdio" sentinel, but computing it a second way here
    // is how writer and reader drift apart.
    const tenantScope = resolveTenantScope({ tenantId: context.tenantId, origin: ctx.origin })
    if (ctx.origin !== "http") {
      const canExecute = await ToolSearch.canExecuteTool(sessionId, name, tenantScope ?? STDIO_TENANT)
      if (!canExecute) {
        const toolStatus = await ToolSearch.getToolStatus(sessionId, name, tenantScope ?? STDIO_TENANT)
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Tool "${name}" is ${toolStatus} and must be enabled first. ` +
            `Use tool_search({query: "${name.replace("snow_", "")}"}) to enable it.`,
        )
      }
    }

    // Phase 2: Permission validation before execution
    validateJWTExpiry(ctx.jwtPayload)
    validatePermission(tool.definition, ctx.jwtPayload)

    // Prod-write safety: a write tool against a PRODUCTION-classified instance is
    // blocked by default, so the agent can't silently change a client's prod.
    // Reads — and writes to dev/test/uat — are never gated. The caller re-issues
    // with `__confirmProd: true` only after the user approves the specific change;
    // the flag is stripped below so the executor never sees it.
    const prodWrite = context.environmentType === "production" && isWriteTool(tool.definition)
    if (prodWrite && !confirmationFlag(args?.__confirmProd)) {
      throw new McpError(ErrorCode.InvalidRequest, prodWriteBlockMessage(name))
    }

    // Update-set safety: a configuration write with no active update set for
    // this session is blocked, so changes can't silently land in the Default
    // update set. The agent lifts the guard once per session by ensuring/
    // creating/switching an update set; `__skipUpdateSet: true` records an
    // explicit user decline and is remembered for the rest of the session.
    const usKey = guardKey(context.tenantId, sessionId, context.instanceUrl)
    if (confirmationFlag(args?.__skipUpdateSet)) {
      recordUpdateSetSkip(usKey)
    }
    if (requiresUpdateSet(tool.definition, args)) {
      if (!updateSetActive(usKey)) {
        throw new McpError(ErrorCode.InvalidRequest, updateSetBlockMessage(name))
      }
      // Guard satisfied. If this chat is bound to an update set and another
      // chat has since moved the instance's (per-user) current set away from
      // it, re-bind it before the write so the change lands in THIS chat's
      // set. Cheap: only fires on detected drift (chat switch), not per write.
      // Best-effort — a failed re-bind logs and proceeds rather than blocking.
      const bound = getActiveUpdateSet(usKey)
      if (bound?.sysId) {
        const scope = driftScope(context.tenantId, context.instanceUrl)
        if (needsCurrentReassert(scope, bound.sysId)) {
          try {
            await setCurrentUpdateSet(context, bound.sysId)
            markCurrentAsserted(scope, bound.sysId)
          } catch (rebindError: any) {
            mcpDebug(`[Server] update-set re-bind failed for ${name}: ${rebindError?.message ?? rebindError}`)
          }
        }
      }
    }

    const execArgs =
      args && typeof args === "object" && ("__confirmProd" in args || "__skipUpdateSet" in args)
        ? Object.fromEntries(Object.entries(args).filter(([k]) => k !== "__confirmProd" && k !== "__skipUpdateSet"))
        : args

    // Execute tool with error handling (permission check passed!).
    // Spread `origin` onto the context so tools that branch on transport
    // (snow_pull_artifact: write-to-disk on stdio, return-inline on http)
    // can read it without us threading another parameter everywhere.
    const contextWithOrigin = { ...context, origin: ctx.origin }
    const result = await executeWithErrorHandling(
      name,
      async () => {
        return await tool.executor(execArgs, contextWithOrigin)
      },
      {
        retry: isRetryableOperation(name),
        context: {
          args,
          instanceUrl: context.instanceUrl,
        },
      },
    )

    // Post-hook: keep the update-set guard in sync with what the update-set
    // tools actually did (ensure/create/switch lift it, complete re-arms it).
    observeUpdateSetTool(name, args, result, usKey)

    // Post-hook: report created/updated artifacts to the enterprise portal's
    // instance-map so the per-tenant graph stays in sync without relying on
    // the agent prompt. Fire-and-forget; never blocks the response.
    reportArtifactToInstanceMap(name, args, result, context, tool.definition, {
      customerId: ctx.customerId,
      organizationId: ctx.organizationId,
    })

    // Return result in MCP format
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    }
  } catch (error: any) {
    mcpDebug(`[Server] Tool execution failed: ${name}`, error.message)

    // Ensure error is properly classified as SnowFlowError before calling toToolResult()
    const snowFlowError = error instanceof SnowFlowError ? error : classifyError(error)

    throw new McpError(ErrorCode.InternalError, snowFlowError.message, snowFlowError.toToolResult())
  }
}
