/**
 * snow_fluent_explain - Look up the SDK's built-in Fluent documentation
 *
 * Wraps `now-sdk explain`, the SDK's offline documentation system (~100+
 * topics: per-API references, developing-apps-guide, ci-integration,
 * keys-file, ...). No instance connection needed. This is the agent's
 * authoritative, version-matched reference for Fluent DSL syntax.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { resolveSdk, runSdk } from "./sdk.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_fluent_explain",
  description:
    "Read the ServiceNow SDK's built-in offline Fluent documentation with now-sdk explain. Omit `topic` (or set list=true) " +
    "to list all available topics; pass a topic (e.g. business-rule, ci-integration, keys-file, developing-apps-guide) for the " +
    "full reference. Use this before writing Fluent code — it is version-matched to the installed SDK.",
  category: "development",
  subcategory: "fluent",
  use_cases: ["fluent-development", "documentation", "pro-code"],
  complexity: "beginner",
  frequency: "high",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  transports: ["stdio"],
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Documentation topic to explain (from the topic list). Omit to list all topics.",
      },
      list: {
        type: "boolean",
        description: "List all available documentation topics",
      },
      directory: {
        type: "string",
        description: "Optional Fluent project root, used to prefer that project's pinned SDK version for version-accurate docs",
      },
    },
    required: [],
  },
}

export async function execute(args: Record<string, unknown>, _context: ServiceNowContext): Promise<ToolResult> {
  try {
    const sdk = await resolveSdk(typeof args.directory === "string" ? args.directory : undefined)
    const topic = typeof args.topic === "string" && args.topic.length > 0 ? args.topic : null
    const cliArgs = topic && !args.list ? ["explain", topic, "--format", "raw"] : ["explain", "--list"]

    const run = await runSdk(sdk, cliArgs, { cwd: process.cwd(), timeoutMs: 120_000 })
    if (run.exitCode !== 0) {
      return createErrorResult(
        new SnowFlowError(ErrorType.NOT_FOUND_ERROR, `now-sdk explain failed (exit ${run.exitCode})`, {
          details: { errors: run.errors, output: run.output, command: run.command },
        }),
      )
    }

    return createSuccessResult(
      {
        topic: topic ?? "(topic list)",
        documentation: run.output,
      },
      { executionTime: run.durationMs, command: run.command, sdkSource: sdk.source },
      topic ? `✓ Fluent documentation: ${topic}` : "✓ Available Fluent documentation topics",
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
