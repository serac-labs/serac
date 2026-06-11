/**
 * snow_fluent_status - Inspect a local Fluent project's state
 *
 * Pure local read: no CLI invocation against the instance. Gives the agent
 * grounding before any Fluent operation — project identity (now.config.json),
 * SDK availability and version pin, keys.ts discipline, how much metadata is
 * still XML vs already Fluent, and build output presence.
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { resolveSdk, assertDirectory, readProjectConfig } from "./sdk.js"
import * as fs from "fs/promises"
import * as path from "path"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_fluent_status",
  description:
    "Inspect a local ServiceNow Fluent (SDK) project: scope/app identity, SDK version pin and availability, keys.ts presence " +
    "(must be committed to git — uncommitted keys cause duplicate records on install), count of metadata still in XML vs Fluent " +
    "sources, and dist/ build output. Call this first when working in a Fluent project.",
  category: "development",
  subcategory: "fluent",
  use_cases: ["fluent-development", "project-inspection", "brownfield-migration"],
  complexity: "beginner",
  frequency: "high",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  transports: ["stdio"],
  inputSchema: {
    type: "object",
    properties: {
      directory: {
        type: "string",
        description: "Absolute path to the Fluent project root",
      },
    },
    required: ["directory"],
  },
}

async function countFiles(dir: string, suffix: string): Promise<number> {
  const walk = async (current: string): Promise<number> => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    const counts = await Promise.all(
      entries.map((entry) => {
        if (entry.isDirectory()) return walk(path.join(current, entry.name))
        return Promise.resolve(entry.name.endsWith(suffix) ? 1 : 0)
      }),
    )
    return counts.reduce((sum, n) => sum + n, 0)
  }
  return walk(dir)
}

export async function execute(args: Record<string, unknown>, _context: ServiceNowContext): Promise<ToolResult> {
  try {
    const directory = await assertDirectory(args.directory)
    const config = await readProjectConfig(directory)
    if (!config) {
      return createSuccessResult(
        { isFluentProject: false, directory },
        {},
        `✗ ${directory} is not a Fluent project (no now.config.json). Use snow_fluent_init to create one.`,
      )
    }

    const packageJson = await fs
      .readFile(path.join(directory, "package.json"), "utf-8")
      .then((raw) => JSON.parse(raw))
      .catch(() => null)
    const sdkPin = packageJson?.devDependencies?.["@servicenow/sdk"] ?? packageJson?.dependencies?.["@servicenow/sdk"] ?? null

    const sdk = await resolveSdk(directory)
    const keysPath = path.join(directory, "src", "fluent", "generated", "keys.ts")
    const hasKeys = await fs
      .access(keysPath)
      .then(() => true)
      .catch(() => false)
    const hasGit = await fs
      .access(path.join(directory, ".git"))
      .then(() => true)
      .catch(() => false)
    const hasDist = await fs
      .access(path.join(directory, "dist"))
      .then(() => true)
      .catch(() => false)
    const hasNodeModules = await fs
      .access(path.join(directory, "node_modules"))
      .then(() => true)
      .catch(() => false)

    const metadataDir = path.join(directory, "metadata")
    const hasMetadataDir = await fs
      .access(metadataDir)
      .then(() => true)
      .catch(() => false)
    const xmlCount = hasMetadataDir ? await countFiles(metadataDir, ".xml") : 0
    const srcDir = path.join(directory, "src")
    const hasSrc = await fs
      .access(srcDir)
      .then(() => true)
      .catch(() => false)
    const fluentCount = hasSrc ? await countFiles(srcDir, ".now.ts") : 0

    const hints: string[] = []
    if (!hasNodeModules) hints.push("Dependencies not installed — run npm install (or snow_fluent_init does this for new projects).")
    if (!hasGit) hints.push("Not a git repository — Fluent projects should be source-controlled (git init).")
    if (hasKeys && !hasGit) hints.push("keys.ts exists but there is no git repo to commit it to; uncommitted keys cause duplicate records on install.")
    if (xmlCount > 0) hints.push(`${xmlCount} metadata record(s) still in XML — convert incrementally with snow_fluent_transform (XML wins over a Fluent twin on build).`)
    if (sdk.source === "npx") hints.push("No project-local or global now-sdk found; commands fall back to npx (slow first run).")

    return createSuccessResult(
      {
        isFluentProject: true,
        directory,
        scope: config.scope,
        scopeId: config.scopeId,
        name: config.name,
        sdkVersionPin: sdkPin,
        sdkBinary: sdk.source,
        keysFile: hasKeys ? keysPath : null,
        gitRepository: hasGit,
        dependenciesInstalled: hasNodeModules,
        buildOutput: hasDist,
        metadataXmlFiles: xmlCount,
        fluentSourceFiles: fluentCount,
        hints,
      },
      {},
      `✓ Fluent project ${config.scope} (${config.name ?? "unnamed"})\n  SDK: ${sdkPin ?? "not pinned"} via ${sdk.source}\n  Fluent sources: ${fluentCount}, XML metadata: ${xmlCount}` +
        (hints.length > 0 ? `\n  Hints:\n${hints.map((hint) => `  - ${hint}`).join("\n")}` : ""),
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
