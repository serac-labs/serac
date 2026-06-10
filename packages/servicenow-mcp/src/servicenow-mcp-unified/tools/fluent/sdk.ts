/**
 * Shared runner for the ServiceNow SDK CLI (`now-sdk`) used by the fluent/* tools.
 *
 * Not a tool itself — exports no toolDefinition, so the registry and the
 * tools.json generator skip it.
 *
 * Auth: the SDK's interactive `now-sdk auth` flow is bypassed entirely. The
 * SDK documents a headless CI mode (env vars, see `now-sdk explain
 * ci-integration`) that takes precedence over its keychain; we derive those
 * vars from the ServiceNowContext the MCP server already holds, so the
 * user's existing Serac instance auth powers the SDK with zero extra setup.
 */

import { spawn } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import { ServiceNowContext } from "../../shared/types.js"
import { SnowFlowError, ErrorType } from "../../shared/error-handler.js"

export interface SdkInvocation {
  command: string
  prefixArgs: string[]
  source: "project" | "path" | "npx"
}

export interface SdkRunResult {
  exitCode: number
  output: string
  errors: string[]
  command: string
  durationMs: number
}

const ANSI_PATTERN = /\x1B\[[0-9;?]*[a-zA-Z]/g

async function exists(candidate: string): Promise<boolean> {
  return fs
    .access(candidate)
    .then(() => true)
    .catch(() => false)
}

/**
 * Locate the `now-sdk` binary. Preference order:
 * 1. The Fluent project's own dependency (node_modules/.bin/now-sdk) — pins
 *    the SDK version the project was scaffolded with.
 * 2. A globally installed `now-sdk` on PATH.
 * 3. `npx --package=@servicenow/sdk now-sdk` as a zero-install fallback
 *    (slow on first use; downloads the SDK).
 */
export async function resolveSdk(directory?: string): Promise<SdkInvocation> {
  if (directory) {
    const local = path.join(directory, "node_modules", ".bin", "now-sdk")
    if (await exists(local)) return { command: local, prefixArgs: [], source: "project" }
  }
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean)
  for (const dir of pathDirs) {
    if (await exists(path.join(dir, "now-sdk"))) {
      return { command: "now-sdk", prefixArgs: [], source: "path" }
    }
  }
  return { command: "npx", prefixArgs: ["-y", "--package=@servicenow/sdk", "now-sdk"], source: "npx" }
}

/**
 * Build the SDK's documented CI env vars from the live instance context.
 * Basic auth wins when a username/password pair is present; otherwise OAuth
 * client_credentials. The client_credentials grant requires instance-side
 * enablement (sys_property glide.oauth.inbound.client.credential.grant_type.enabled
 * plus an OAuth API endpoint registry entry with a mapped Human user) — the
 * error hint mentions this because it is the most common failure mode.
 */
export function sdkAuthEnv(context: ServiceNowContext): Record<string, string> {
  if (!context.instanceUrl) {
    throw new SnowFlowError(
      ErrorType.UNAUTHORIZED,
      "No ServiceNow instance configured. Run the Serac auth flow first — the fluent tools reuse that instance context.",
    )
  }
  const base: Record<string, string> = {
    SN_SDK_NODE_ENV: "SN_SDK_CI_INSTALL",
    SN_SDK_INSTANCE_URL: context.instanceUrl,
  }
  if (context.username && context.password) {
    return { ...base, SN_SDK_AUTH_TYPE: "basic", SN_SDK_USER: context.username, SN_SDK_USER_PWD: context.password }
  }
  if (context.clientId && context.clientSecret) {
    return {
      ...base,
      SN_SDK_AUTH_TYPE: "oauth",
      SN_SDK_OAUTH_CLIENT_ID: context.clientId,
      SN_SDK_OAUTH_CLIENT_SECRET: context.clientSecret,
    }
  }
  throw new SnowFlowError(
    ErrorType.UNAUTHORIZED,
    "Instance auth lacks credentials the ServiceNow SDK can use headlessly. Provide username/password (basic) or an OAuth client id/secret. " +
      "Note: the OAuth path uses the client_credentials grant, which must be enabled on the instance " +
      "(glide.oauth.inbound.client.credential.grant_type.enabled=true and a mapped application user with Identity Type = Human).",
  )
}

export interface RunSdkOptions {
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
}

/**
 * Run a now-sdk subcommand, capture combined output with ANSI codes stripped,
 * and surface the SDK's `[now-sdk] ERROR ...` lines separately. Callers must
 * not trust exit codes alone: `now-sdk build` exits 0 on some failure modes
 * (e.g. missing package.json), so tools also inspect `errors` and artifacts.
 */
export async function runSdk(invocation: SdkInvocation, args: string[], options: RunSdkOptions): Promise<SdkRunResult> {
  const started = Date.now()
  const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ["ignore", "pipe", "pipe"],
  })

  const chunks: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk))

  const timeoutMs = options.timeoutMs ?? 300_000
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(
        new SnowFlowError(ErrorType.TIMEOUT_ERROR, `now-sdk ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`),
      )
    }, timeoutMs)
    child.on("error", (error: Error) => {
      clearTimeout(timer)
      reject(new SnowFlowError(ErrorType.UNKNOWN_ERROR, `Failed to start ${invocation.command}: ${error.message}`))
    })
    child.on("close", (code: number | null) => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })

  const output = Buffer.concat(chunks).toString("utf-8").replace(ANSI_PATTERN, "")
  const errors = output.split("\n").filter((line) => /\bERROR\b/.test(line))
  return {
    exitCode,
    output: output.length > 40_000 ? output.slice(0, 20_000) + "\n... [output truncated] ...\n" + output.slice(-20_000) : output,
    errors,
    command: [invocation.command, ...invocation.prefixArgs, ...args].join(" "),
    durationMs: Date.now() - started,
  }
}

/**
 * Read and parse a Fluent project's now.config.json. Returns null when the
 * directory is not a Fluent project (no config file).
 */
export async function readProjectConfig(
  directory: string,
): Promise<{ scope?: string; scopeId?: string; name?: string } | null> {
  const raw = await fs.readFile(path.join(directory, "now.config.json"), "utf-8").catch(() => null)
  if (raw === null) return null
  return JSON.parse(raw)
}

export async function assertDirectory(directory: unknown): Promise<string> {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "`directory` is required (absolute path to the Fluent project)")
  }
  const stat = await fs.stat(directory).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, `Directory not found: ${directory}`)
  }
  return directory
}
