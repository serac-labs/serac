/**
 * snow_fluent_download - Pull app metadata from the instance into the project
 *
 * Wraps `now-sdk download`. Refreshes the local project with the application
 * metadata currently on the instance (e.g. changes a colleague made in
 * Studio). Downloaded records land as XML in metadata/; convert them with
 * snow_fluent_transform when you want them as Fluent code.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { resolveSdk, runSdk, sdkAuthEnv, assertDirectory, readProjectConfig } from "./sdk.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_fluent_download",
  description:
    "Download the application's metadata from the connected instance into a local Fluent (SDK) project with now-sdk download. " +
    "Use to sync instance-side changes (made in Studio or by others) into the local project before continuing development. " +
    "Downloads land as XML in metadata/; use snow_fluent_transform to convert them to Fluent code.",
  category: "development",
  subcategory: "fluent",
  use_cases: ["fluent-development", "sync", "brownfield-migration"],
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
        description: "Absolute path to the Fluent project root (metadata is downloaded into this project)",
      },
      incremental: {
        type: "boolean",
        description: "Only download records changed since the last download instead of the full application",
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

    const cliArgs = ["download", directory]
    if (args.incremental) cliArgs.push("--incremental")

    const sdk = await resolveSdk(directory)
    const run = await runSdk(sdk, cliArgs, { cwd: directory, env: sdkAuthEnv(context), timeoutMs: 600_000 })
    if (run.exitCode !== 0 || run.errors.length > 0) {
      return createErrorResult(
        new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `now-sdk download failed (exit ${run.exitCode})`, {
          details: { errors: run.errors, output: run.output, command: run.command },
        }),
      )
    }

    return createSuccessResult(
      {
        scope: config.scope,
        instance: context.instanceUrl,
        incremental: Boolean(args.incremental),
        output: run.output,
      },
      { executionTime: run.durationMs, command: run.command, sdkSource: sdk.source },
      `✓ Downloaded metadata for ${config.scope} from ${context.instanceUrl}\n  New/changed records are XML under metadata/ — transform what you want as Fluent code.`,
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
