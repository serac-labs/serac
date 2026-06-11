/**
 * snow_fluent_install - Deploy a built Fluent project to the instance
 *
 * Wraps `now-sdk install` (the SDK's deploy). Installs the built application
 * package onto the connected instance. Note the SDK's own guidance: installs
 * bypass update sets and create no rollback context — production promotion
 * should go through the Application Repository, not this tool.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { resolveSdk, runSdk, sdkAuthEnv, assertDirectory, readProjectConfig, assertNoFlag } from "./sdk.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_fluent_install",
  description:
    "Deploy a built ServiceNow Fluent (SDK) project to the connected instance with now-sdk install. Build first with " +
    "snow_fluent_build. Installs bypass update sets and have no rollback context — use against dev/test instances; promote " +
    "to production via the Application Repository. Set info=true to only query the last install state without deploying.",
  category: "development",
  subcategory: "fluent",
  use_cases: ["fluent-development", "deployment", "pro-code"],
  complexity: "intermediate",
  frequency: "high",
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
      info: {
        type: "boolean",
        description: "Only query the instance for the application's last install info; performs no deploy",
      },
      reinstall: {
        type: "boolean",
        description:
          "DESTRUCTIVE: uninstall the app from the instance and install fresh. Deletes instance-side data tied to the app. Only use when the user explicitly asked for it.",
      },
      demo_data: {
        type: "boolean",
        description: "Include the project's demo data in the install (default false here, unlike the raw CLI which defaults to true)",
      },
      skip_flow_activation: {
        type: "boolean",
        description: "Do not auto-publish flows after install (flows auto-publish since SDK 4.5)",
      },
      source: {
        type: "string",
        description: "Optional path to a specific build output to install instead of the project's own dist/",
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

    const cliArgs = ["install"]
    if (args.info) cliArgs.push("--info")
    if (args.reinstall) cliArgs.push("--reinstall")
    if (args.source) cliArgs.push("--source", assertNoFlag(String(args.source), "source"))
    if (!args.info) {
      cliArgs.push(`--demoData=${args.demo_data === true}`)
      if (args.skip_flow_activation) cliArgs.push("--skip-flow-activation")
    }

    const sdk = await resolveSdk(directory)
    const run = await runSdk(sdk, cliArgs, { cwd: directory, env: sdkAuthEnv(context), timeoutMs: 900_000 })

    // The SDK has known soft-failure modes where install reports success on a
    // non-zero condition; treat any ERROR line as failure regardless of exit code.
    if (run.exitCode !== 0 || run.errors.length > 0) {
      return createErrorResult(
        new SnowFlowError(ErrorType.DEPLOYMENT_FAILED, `now-sdk install failed (exit ${run.exitCode})`, {
          details: { errors: run.errors, output: run.output, command: run.command },
        }),
      )
    }

    return createSuccessResult(
      {
        scope: config.scope,
        instance: context.instanceUrl,
        action: args.info ? "info" : args.reinstall ? "reinstall" : "install",
        output: run.output,
      },
      { executionTime: run.durationMs, command: run.command, sdkSource: sdk.source },
      args.info
        ? `✓ Install info for ${config.scope} on ${context.instanceUrl}`
        : `✓ Installed ${config.scope} on ${context.instanceUrl}\n  Verify in the instance; installs have no update set or rollback context.`,
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
