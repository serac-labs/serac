/**
 * snow_fluent_dependencies - Sync instance dependencies and type definitions
 *
 * Wraps `now-sdk dependencies`. Downloads the dependency metadata and
 * TypeScript type definitions (glide.*.d.ts and table schemas) a Fluent
 * project needs to compile against the connected instance, and can register
 * additional tables from the instance as project dependencies.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { resolveSdk, runSdk, sdkAuthEnv, assertDirectory, readProjectConfig } from "./sdk.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_fluent_dependencies",
  description:
    "Download a Fluent (SDK) project's instance dependencies and TypeScript type definitions with now-sdk dependencies. " +
    "Run when builds fail on unknown tables/fields, after instance-side schema changes, or to add an existing instance table " +
    "as a dependency (add_table + scope). type_defs_only refreshes just the glide type definitions.",
  category: "development",
  subcategory: "fluent",
  use_cases: ["fluent-development", "type-definitions", "build-validation"],
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
        description: "Absolute path to the Fluent project root",
      },
      sys_ids: {
        type: "array",
        items: { type: "string" },
        description: "Optional specific dependency sys_ids to download",
      },
      type_defs_only: {
        type: "boolean",
        description: "Only download TypeScript type definitions (glide.*.d.ts)",
      },
      fluent_only: {
        type: "boolean",
        description: "Only download Fluent-relevant dependencies",
      },
      add_table: {
        type: "string",
        description: "Register an existing instance table as a project dependency (requires `scope`)",
      },
      scope: {
        type: "string",
        description: "Scope of the table passed in add_table (required with add_table)",
      },
    },
    required: ["directory"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  try {
    const directory = await assertDirectory(args.directory)
    const config = await readProjectConfig(directory)
    if (!config) {
      throw new SnowFlowError(ErrorType.VALIDATION_ERROR, `No now.config.json in ${directory} — not a Fluent project root`)
    }
    if (args.add_table && !args.scope) {
      throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "`scope` is required when using add_table")
    }

    const cliArgs = ["dependencies"]
    const sysIds = args.sys_ids as string[] | undefined
    if (sysIds && sysIds.length > 0) cliArgs.push(...sysIds)
    cliArgs.push("--directory", directory)
    if (args.type_defs_only) cliArgs.push("--type-defs-only")
    if (args.fluent_only) cliArgs.push("--fluent-only")
    if (args.add_table) cliArgs.push("--add", String(args.add_table), "--scope", String(args.scope))

    const sdk = await resolveSdk(directory)
    const run = await runSdk(sdk, cliArgs, { cwd: directory, env: sdkAuthEnv(context), timeoutMs: 600_000 })
    if (run.exitCode !== 0 || run.errors.length > 0) {
      return createErrorResult(
        new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `now-sdk dependencies failed (exit ${run.exitCode})`, {
          details: { errors: run.errors, output: run.output, command: run.command },
        }),
      )
    }

    return createSuccessResult(
      {
        scope: config.scope,
        instance: context.instanceUrl,
        output: run.output,
      },
      { executionTime: run.durationMs, command: run.command, sdkSource: sdk.source },
      `✓ Dependencies synced for ${config.scope} from ${context.instanceUrl}`,
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
