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
 *
 * Every tool in this domain is stdio-only (enforced via `transports` +
 * the transport-parity test): these helpers run on the user's own machine,
 * with the same trust level as the user's shell. Child processes therefore
 * inherit the full environment, like any terminal invocation would.
 */

import { spawn } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import { ServiceNowContext } from "../../shared/types.js"
import { SnowFlowError, ErrorType } from "../../shared/error-handler.js"

/**
 * Version used by the npx fallback when no project-local or global SDK is
 * found. Pinned deliberately (supply-chain + reproducibility) — bump it
 * together with the skills/docs when validating a newer SDK.
 */
const FALLBACK_SDK_VERSION = "4.7.2"

const WINDOWS = process.platform === "win32"

export interface SdkInvocation {
  command: string
  prefixArgs: string[]
  source: "project" | "path" | "npx"
  /** Required for .cmd shims on Windows (Node refuses them without a shell). */
  shell?: boolean
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
 * Resolve the project-local SDK to its real JS bin entry and run it via the
 * current Node/Bun executable. This sidesteps .bin shims entirely, which is
 * the only spawn strategy that works identically on POSIX and Windows.
 */
async function resolveProjectSdk(directory: string): Promise<SdkInvocation | null> {
  const pkgPath = path.join(directory, "node_modules", "@servicenow", "sdk", "package.json")
  const raw = await fs.readFile(pkgPath, "utf-8").catch(() => null)
  if (raw === null) return null
  const parsed = JSON.parse(raw) as { bin?: Record<string, string> | string }
  const binRel = typeof parsed.bin === "string" ? parsed.bin : parsed.bin?.["now-sdk"]
  if (!binRel) return null
  const entry = path.join(path.dirname(pkgPath), binRel)
  if (!(await exists(entry))) return null
  return { command: process.execPath, prefixArgs: [entry], source: "project" }
}

/**
 * Locate the `now-sdk` binary. Preference order:
 * 1. The Fluent project's own dependency (resolved to its JS entry) — pins
 *    the SDK version the project was scaffolded with.
 * 2. A globally installed `now-sdk` on PATH.
 * 3. `npx --package=@servicenow/sdk@<pinned> now-sdk` as a zero-install
 *    fallback (slow on first use; downloads the SDK).
 */
export async function resolveSdk(directory?: string): Promise<SdkInvocation> {
  if (directory) {
    const project = await resolveProjectSdk(directory)
    if (project) return project
  }
  const binName = WINDOWS ? "now-sdk.cmd" : "now-sdk"
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean)
  for (const dir of pathDirs) {
    if (await exists(path.join(dir, binName))) {
      return { command: binName, prefixArgs: [], source: "path", shell: WINDOWS }
    }
  }
  return {
    command: WINDOWS ? "npx.cmd" : "npx",
    prefixArgs: ["-y", `--package=@servicenow/sdk@${FALLBACK_SDK_VERSION}`, "now-sdk"],
    source: "npx",
    shell: WINDOWS,
  }
}

/** Invocation for plain npm (used by snow_fluent_init's dependency install). */
export function npmInvocation(): SdkInvocation {
  return { command: WINDOWS ? "npm.cmd" : "npm", prefixArgs: [], source: "path", shell: WINDOWS }
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

function killTree(child: ReturnType<typeof spawn>): void {
  // The child is spawned detached (POSIX) so it leads its own process group;
  // killing the group also reaps grandchildren (npx → now-sdk → node, npm
  // lifecycle scripts). A bare child.kill() would orphan those and the
  // operation could silently continue after we reported a timeout.
  if (!WINDOWS && child.pid) {
    const group = -child.pid
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(group, sig)
      } catch {
        // ESRCH — group already gone.
      }
    }
    signal("SIGTERM")
    setTimeout(() => signal("SIGKILL"), 5000).unref()
    return
  }
  child.kill("SIGKILL")
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
    detached: !WINDOWS,
    shell: invocation.shell === true,
  })

  const chunks: Buffer[] = []
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk))

  const timeoutMs = options.timeoutMs ?? 300_000
  const commandLine = [invocation.command, ...invocation.prefixArgs, ...args].join(" ")
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      killTree(child)
      reject(
        new SnowFlowError(
          ErrorType.TIMEOUT_ERROR,
          `\`${commandLine}\` timed out after ${Math.round(timeoutMs / 1000)}s. ` +
            "The operation may have partially executed (locally or against the instance) — " +
            "verify with snow_fluent_status / snow_fluent_install info=true before retrying.",
        ),
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
    command: commandLine,
    durationMs: Date.now() - started,
  }
}

/**
 * Read and parse a Fluent project's now.config.json.
 * Returns null only when the file is absent (not a Fluent project). A file
 * that exists but does not parse to a plain object is a project-corruption
 * error and throws, so callers like snow_fluent_status report it instead of
 * crashing with an opaque SyntaxError.
 */
export async function readProjectConfig(
  directory: string,
): Promise<{ scope?: string; scopeId?: string; name?: string } | null> {
  const file = path.join(directory, "now.config.json")
  const raw = await fs.readFile(file, "utf-8").catch(() => null)
  if (raw === null) return null
  const parsed = (() => {
    try {
      return JSON.parse(raw) as unknown
    } catch (error) {
      throw new SnowFlowError(
        ErrorType.VALIDATION_ERROR,
        `${file} exists but is not valid JSON: ${(error as Error).message}. Fix or remove the file.`,
      )
    }
  })()
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, `${file} exists but does not contain a JSON object.`)
  }
  return parsed as { scope?: string; scopeId?: string; name?: string }
}

export async function assertDirectory(directory: unknown): Promise<string> {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, "`directory` is required (absolute path to the Fluent project)")
  }
  if (!path.isAbsolute(directory)) {
    throw new SnowFlowError(
      ErrorType.VALIDATION_ERROR,
      `\`directory\` must be an absolute path (got "${directory}") — relative paths resolve against the MCP server's cwd, not the user's project.`,
    )
  }
  const stat = await fs.stat(directory).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, `Directory not found: ${directory}`)
  }
  return directory
}

/**
 * Guard for values forwarded to the CLI as positional args or flag values:
 * a leading dash would be parsed as a now-sdk flag, not a value.
 */
export function assertNoFlag(value: string, argName: string): string {
  if (value.startsWith("-")) {
    throw new SnowFlowError(ErrorType.VALIDATION_ERROR, `Invalid ${argName}: "${value}" must not start with "-".`)
  }
  return value
}

export const SYS_ID_PATTERN = /^[0-9a-fA-F]{32}$/
