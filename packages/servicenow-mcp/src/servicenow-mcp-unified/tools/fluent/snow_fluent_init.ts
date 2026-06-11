/**
 * snow_fluent_init - Scaffold or convert a ServiceNow Fluent project
 *
 * Wraps `now-sdk init`. Two modes:
 * - Greenfield: scaffold a new Fluent app from a template (offline, no auth).
 * - Brownfield: `from` = sys_id of an existing scoped app on the instance —
 *   downloads the app and converts it into an SDK project (metadata stays as
 *   XML until snow_fluent_transform converts it to Fluent code).
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { resolveSdk, runSdk, sdkAuthEnv, readProjectConfig, npmInvocation, assertNoFlag, SYS_ID_PATTERN } from "./sdk.js"
import * as fs from "fs/promises"
import * as path from "path"

const TEMPLATES = ["base", "javascript.basic", "javascript.react", "typescript.basic", "typescript.react", "typescript.vue"]

export const toolDefinition: MCPToolDefinition = {
  name: "snow_fluent_init",
  description:
    "Initialize a ServiceNow Fluent (SDK) project in a local directory with now-sdk init. Scaffold a new scoped app from a " +
    "template, or convert an existing app from the instance by passing its sys_app sys_id as `from` (brownfield migration: " +
    "metadata lands as XML; convert it to Fluent code afterwards with snow_fluent_transform). Runs npm install afterwards by default.",
  category: "development",
  subcategory: "fluent",
  use_cases: ["fluent-development", "pro-code", "scaffolding", "brownfield-migration"],
  complexity: "intermediate",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  transports: ["stdio"],
  inputSchema: {
    type: "object",
    properties: {
      directory: {
        type: "string",
        description: "Absolute path where the project is created (now-sdk init writes into this directory; created if missing)",
      },
      app_name: {
        type: "string",
        description: "Display name of the application (required for a new app; with `from` it is forwarded when provided)",
      },
      package_name: {
        type: "string",
        description: "npm package name for the project, e.g. my-fluent-app (npm naming rules apply)",
      },
      scope_name: {
        type: "string",
        description:
          "Application scope, format x_<company_code>_<app_name>, max 18 chars (required for a new app; with `from` the existing app's scope is reused)",
      },
      template: {
        type: "string",
        enum: TEMPLATES,
        description: "Project template (default typescript.basic for new apps)",
      },
      from: {
        type: "string",
        description:
          "Brownfield source: sys_id of an existing scoped app on the connected instance, or a local path to a legacy app directory",
      },
      install_dependencies: {
        type: "boolean",
        description: "Run npm install after init so the project-local SDK is available for builds (default true)",
      },
    },
    required: ["directory"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const directory = args.directory as string
    if (!directory) {
      throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "`directory` is required")
    }
    if (!path.isAbsolute(directory)) {
      throw new SnowFlowError(
        ErrorType.VALIDATION_ERROR,
        `\`directory\` must be an absolute path (got "${directory}") — relative paths resolve against the MCP server's cwd, not the user's project.`,
      )
    }
    const from = args.from as string | undefined
    if (!from) {
      if (!args.app_name || !args.package_name || !args.scope_name) {
        throw new SnowFlowError(
          ErrorType.VALIDATION_ERROR,
          "For a new app, app_name, package_name and scope_name are all required (now-sdk init prompts interactively otherwise, which is not possible here)",
        )
      }
      const scope = String(args.scope_name)
      if (!/^x_[a-z0-9_]+$/.test(scope) || scope.length > 18) {
        throw new SnowFlowError(
          ErrorType.VALIDATION_ERROR,
          `Invalid scope_name "${scope}": must match x_<company_code>_<app_name> (lowercase, underscores) and be at most 18 characters`,
        )
      }
    }

    await fs.mkdir(directory, { recursive: true })
    const existing = await readProjectConfig(directory)
    if (existing) {
      throw new SnowFlowError(
        ErrorType.VALIDATION_ERROR,
        `${directory} already contains a Fluent project (scope ${existing.scope}). Pick an empty directory.`,
      )
    }

    const cliArgs = ["init"]
    if (from) cliArgs.push("--from", assertNoFlag(from, "from"))
    if (args.app_name) cliArgs.push("--appName", String(args.app_name))
    if (args.package_name) cliArgs.push("--packageName", String(args.package_name))
    if (args.scope_name) cliArgs.push("--scopeName", String(args.scope_name))
    if (!from) cliArgs.push("--template", String(args.template ?? "typescript.basic"))

    // Pulling an app from the instance needs auth; a fresh scaffold is offline.
    const needsAuth = Boolean(from && SYS_ID_PATTERN.test(from))
    const env = needsAuth ? sdkAuthEnv(context) : {}

    const sdk = await resolveSdk()
    const run = await runSdk(sdk, cliArgs, { cwd: directory, env, timeoutMs: 600_000 })
    if (run.exitCode !== 0 || run.errors.length > 0) {
      return createErrorResult(
        new SnowFlowError(ErrorType.VALIDATION_ERROR, `now-sdk init failed (exit ${run.exitCode})`, {
          details: { errors: run.errors, output: run.output, command: run.command },
        }),
      )
    }

    const config = await readProjectConfig(directory)

    // The dependency install is a convenience step — its failure must never
    // be reported as an init failure: the project is already scaffolded, and
    // a retried init would hit the already-a-project guard above (dead end).
    const installDeps = args.install_dependencies !== false
    const npm = installDeps
      ? await runSdk(npmInvocation(), ["install", "--no-fund", "--no-audit", "--loglevel=error"], {
          cwd: directory,
          timeoutMs: 600_000,
        }).catch((error: Error) => ({ failed: error.message }) as const)
      : null
    const npmFailed = npm === null ? null : "failed" in npm ? npm.failed : npm.exitCode !== 0 ? npm.output.slice(-2000) : null

    return createSuccessResult(
      {
        directory,
        scope: config?.scope,
        scopeId: config?.scopeId,
        name: config?.name,
        dependenciesInstalled: npm !== null && !npmFailed,
        ...(npmFailed ? { dependencyInstallError: npmFailed } : {}),
        output: run.output,
      },
      { executionTime: run.durationMs, command: run.command, sdkSource: sdk.source },
      `✓ Fluent project initialized in ${directory}\n  scope: ${config?.scope ?? "(unknown)"}\n  ` +
        (from ? "Converted from existing app — metadata is XML; use snow_fluent_transform to convert records to Fluent code." : "New app scaffolded.") +
        (npmFailed ? `\n  ⚠ Dependency install failed — run npm install in ${directory} before building. Reason: ${npmFailed.slice(0, 300)}` : ""),
    )
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError ? err : new SnowFlowError(ErrorType.UNKNOWN_ERROR, err.message, { originalError: err }),
    )
  }
}

export const version = "1.0.0"
export const author = "serac-labs"
