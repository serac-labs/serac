/**
 * snow_fluent_transform - Convert app metadata XML to Fluent TypeScript
 *
 * Wraps `now-sdk transform`. In a converted (brownfield) project, records
 * live as XML under metadata/ until transformed; this converts them to
 * Fluent code under the generated directory and removes the XML on success.
 * Records that exist as both Fluent and XML resolve to the XML version on
 * build — transform incrementally and verify with snow_fluent_build.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { resolveSdk, runSdk, sdkAuthEnv, assertDirectory, readProjectConfig } from "./sdk.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_fluent_transform",
  description:
    "Convert ServiceNow app metadata XML into Fluent (SDK) TypeScript code with now-sdk transform. Use after snow_fluent_init " +
    "--from to modernize a brownfield app incrementally: target specific tables with `tables`, or a local XML file/dir with `from`. " +
    "Converted records move from metadata/ XML into generated Fluent sources; always run snow_fluent_build afterwards to verify.",
  category: "development",
  subcategory: "fluent",
  use_cases: ["brownfield-migration", "fluent-development", "modernization"],
  complexity: "advanced",
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
      tables: {
        type: "array",
        items: { type: "string" },
        description:
          "Limit the transform to records of these tables (e.g. [\"sys_script\", \"sys_script_include\"]). Recommended: transform table-by-table and build in between.",
      },
      from: {
        type: "string",
        description: "Transform a specific local XML file or directory instead of the whole metadata folder",
      },
      format: {
        type: "boolean",
        description: "Format the generated Fluent code (CLI default true)",
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

    const cliArgs = ["transform", "--directory", directory]
    if (args.from) cliArgs.push("--from", String(args.from))
    const tables = args.tables as string[] | undefined
    if (tables && tables.length > 0) cliArgs.push("--table", tables.join(","))
    if (args.format === false) cliArgs.push("--format", "false")

    // Transform can resolve metadata against the instance; pass auth when the
    // context has it, stay offline otherwise (local --from transforms work without).
    const env = (() => {
      const offline = Boolean(args.from)
      if (offline) return {}
      return sdkAuthEnv(context)
    })()

    const sdk = await resolveSdk(directory)
    const run = await runSdk(sdk, cliArgs, { cwd: directory, env, timeoutMs: 600_000 })
    if (run.exitCode !== 0 || run.errors.length > 0) {
      return createErrorResult(
        new SnowFlowError(ErrorType.VALIDATION_ERROR, `now-sdk transform failed (exit ${run.exitCode})`, {
          details: { errors: run.errors, output: run.output, command: run.command },
        }),
      )
    }

    return createSuccessResult(
      {
        scope: config.scope,
        tables: tables ?? "all",
        output: run.output,
      },
      { executionTime: run.durationMs, command: run.command, sdkSource: sdk.source },
      `✓ Transform completed for ${config.scope}\n  Run snow_fluent_build next — transformed code can reference instance fields the SDK types don't know yet, which only surfaces as build errors.`,
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
