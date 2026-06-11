/**
 * snow_fluent_build - Compile a ServiceNow Fluent project locally
 *
 * Runs `now-sdk build` in a local Fluent (ServiceNow SDK) project. This is
 * the agent's type-check/compile loop: Fluent compile errors surface here
 * before anything touches the instance. No instance auth needed.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { resolveSdk, runSdk, assertDirectory, readProjectConfig } from "./sdk.js"
import * as fs from "fs/promises"
import * as path from "path"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_fluent_build",
  description:
    "Build a local ServiceNow Fluent (SDK) project with now-sdk build. Compiles .now.ts Fluent sources + metadata XML " +
    "into an installable package under dist/. Use after every Fluent source change to catch compile errors before deploying. " +
    "Local-only: requires no instance connection.",
  category: "development",
  subcategory: "fluent",
  use_cases: ["fluent-development", "pro-code", "build-validation", "ci-cd"],
  complexity: "beginner",
  frequency: "high",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  transports: ["stdio"],
  inputSchema: {
    type: "object",
    properties: {
      directory: {
        type: "string",
        description: "Absolute path to the Fluent project root (contains now.config.json and package.json)",
      },
      frozen_keys: {
        type: "boolean",
        description:
          "Pass --frozenKeys: fail the build when src/fluent/generated/keys.ts would change. Use in CI/PR checks to catch an uncommitted keys file (uncommitted keys cause duplicate records on install).",
      },
      error_on_conflict: {
        type: "boolean",
        description:
          "Pass --errorOnConflict: treat records that exist both as Fluent code and as XML in metadata/ as build errors instead of silently preferring the XML version.",
      },
      skip_clean: {
        type: "boolean",
        description: "Pass --skipClean: keep the previous dist/ output instead of cleaning first.",
      },
    },
    required: ["directory"],
  },
}

export async function execute(args: Record<string, unknown>, _context: ServiceNowContext): Promise<ToolResult> {
  try {
    const directory = await assertDirectory(args.directory)

    // now-sdk build exits 0 when package.json is missing — validate up front
    // so the failure mode is explicit instead of a silent no-op.
    const hasPackageJson = await fs
      .access(path.join(directory, "package.json"))
      .then(() => true)
      .catch(() => false)
    if (!hasPackageJson) {
      throw new SnowFlowError(
        ErrorType.VALIDATION_ERROR,
        `No package.json in ${directory} — not a Fluent project root. Scaffold one with snow_fluent_init first.`,
      )
    }
    const config = await readProjectConfig(directory)
    if (!config) {
      throw new SnowFlowError(
        ErrorType.VALIDATION_ERROR,
        `No now.config.json in ${directory} — not a Fluent project root. Scaffold one with snow_fluent_init first.`,
      )
    }

    const sdk = await resolveSdk(directory)
    const cliArgs = ["build"]
    if (args.frozen_keys) cliArgs.push("--frozenKeys")
    if (args.error_on_conflict) cliArgs.push("--errorOnConflict")
    if (args.skip_clean) cliArgs.push("--skipClean")

    const run = await runSdk(sdk, cliArgs, { cwd: directory })

    const distDir = path.join(directory, "dist")
    const distExists = await fs
      .access(distDir)
      .then(() => true)
      .catch(() => false)
    const failed = run.exitCode !== 0 || run.errors.length > 0

    if (failed) {
      return createErrorResult(
        new SnowFlowError(ErrorType.VALIDATION_ERROR, `Fluent build failed (exit ${run.exitCode})`, {
          details: { errors: run.errors, output: run.output, command: run.command },
        }),
      )
    }

    return createSuccessResult(
      {
        scope: config.scope,
        dist: distExists ? distDir : null,
        output: run.output,
      },
      { executionTime: run.durationMs, command: run.command, sdkSource: sdk.source },
      `✓ Fluent build succeeded for ${config.scope ?? directory}\n  dist: ${distExists ? distDir : "(no dist output found)"}`,
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
