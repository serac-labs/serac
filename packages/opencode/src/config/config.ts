import { Log } from "../util/log"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { ModelsDev } from "../provider/models"
import { mergeDeep, pipe, unique } from "remeda"
import { Global } from "../global"
import fs from "fs/promises"
import { readFileSync } from "fs"
import { lazy } from "../util/lazy"
import { NamedError } from "@opencode-ai/util/error"
import { Flag } from "../flag/flag"
import { Auth } from "../auth"
import {
  type ParseError as JsoncParseError,
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
} from "jsonc-parser"
import { Instance } from "../project/instance"
import { LSPServer } from "../lsp/server"
import { BunProc } from "@/bun"
import { Installation } from "@/installation"
import { ConfigMarkdown } from "./markdown"
import { existsSync } from "fs"
import { execSync } from "child_process"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Event } from "../server/event"
import { getCurrentSessionId } from "../session/current-session"

export namespace Config {
  const log = Log.create({ service: "config" })

  // Custom merge function that concatenates array fields instead of replacing them
  function mergeConfigConcatArrays(target: Info, source: Info): Info {
    const merged = mergeDeep(target, source)
    if (target.plugin && source.plugin) {
      merged.plugin = Array.from(new Set([...target.plugin, ...source.plugin]))
    }
    if (target.instructions && source.instructions) {
      merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
    }
    return merged
  }

  export const state = Instance.state(async () => {
    const auth = await Auth.all()

    // Load remote/well-known config first as the base layer (lowest precedence)
    // This allows organizations to provide default configs that users can override
    let result: Info = {}
    for (const [key, value] of Object.entries(auth)) {
      if (value.type === "wellknown") {
        process.env[value.key] = value.token
        log.debug("fetching remote config", { url: `${key}/.well-known/snow-code` })
        const response = await fetch(`${key}/.well-known/snow-code`)
        if (!response.ok) {
          throw new Error(`failed to fetch remote config from ${key}: ${response.status}`)
        }
        const wellknown = (await response.json()) as any
        const remoteConfig = wellknown.config ?? {}
        // Add $schema to prevent load() from trying to write back to a non-existent file
        if (!remoteConfig.$schema) remoteConfig.$schema = "https://serac.build/config.json"
        result = mergeConfigConcatArrays(
          result,
          await load(JSON.stringify(remoteConfig), `${key}/.well-known/snow-code`),
        )
        log.debug("loaded remote config from well-known", { url: key })
      }
    }

    // Global user config overrides remote config
    result = mergeConfigConcatArrays(result, await global())

    // Custom config path overrides global
    if (Flag.OPENCODE_CONFIG) {
      result = mergeConfigConcatArrays(result, await loadFile(Flag.OPENCODE_CONFIG))
      log.debug("loaded custom config", { path: Flag.OPENCODE_CONFIG })
    }

    // Project config has highest precedence (overrides global and remote)
    if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
      for (const file of ["snow-code.jsonc", "snow-code.json"]) {
        const found = await Filesystem.findUp(file, Instance.directory, Instance.worktree)
        for (const resolved of found.toReversed()) {
          result = mergeConfigConcatArrays(result, await loadFile(resolved))
        }
      }
    }

    // Inline config content has highest precedence
    if (Flag.OPENCODE_CONFIG_CONTENT) {
      result = mergeConfigConcatArrays(result, JSON.parse(Flag.OPENCODE_CONFIG_CONTENT))
      log.debug("loaded custom config from OPENCODE_CONFIG_CONTENT")
    }

    result.agent = result.agent || {}
    result.mode = result.mode || {}
    result.plugin = result.plugin || []

    const directories = [
      Global.Path.config,
      // Only scan project .snow-code/ directories when project discovery is enabled
      ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
        ? await Array.fromAsync(
            Filesystem.up({
              targets: [".snow-code"],
              start: Instance.directory,
              stop: Instance.worktree,
            }),
          )
        : []),
      // Always scan ~/.snow-code/ (user home directory)
      ...(await Array.fromAsync(
        Filesystem.up({
          targets: [".snow-code"],
          start: Global.Path.home,
          stop: Global.Path.home,
        }),
      )),
    ]

    if (Flag.OPENCODE_CONFIG_DIR) {
      directories.push(Flag.OPENCODE_CONFIG_DIR)
      log.debug("loading config from OPENCODE_CONFIG_DIR", { path: Flag.OPENCODE_CONFIG_DIR })
    }

    for (const dir of unique(directories)) {
      if (dir.endsWith(".snow-code") || dir === Flag.SNOW_CODE_CONFIG_DIR) {
        for (const file of ["snow-code.jsonc", "snow-code.json"]) {
          log.debug(`loading config from ${path.join(dir, file)}`)
          result = mergeConfigConcatArrays(result, await loadFile(path.join(dir, file)))
          // to satisfy the type checker
          result.agent ??= {}
          result.mode ??= {}
          result.plugin ??= []
        }
      }

      const exists = existsSync(path.join(dir, "node_modules"))
      const installing = installDependencies(dir)
      if (!exists) await installing

      result.command = mergeDeep(result.command ?? {}, await loadCommand(dir))
      result.agent = mergeDeep(result.agent, await loadAgent(dir))
      result.agent = mergeDeep(result.agent, await loadMode(dir))
      result.plugin.push(...(await loadPlugin(dir)))
    }

    // Migrate deprecated mode field to agent field
    for (const [name, mode] of Object.entries(result.mode)) {
      result.agent = mergeDeep(result.agent ?? {}, {
        [name]: {
          ...mode,
          mode: "primary" as const,
        },
      })
    }

    if (Flag.OPENCODE_PERMISSION) {
      result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.OPENCODE_PERMISSION))
    }

    // Backwards compatibility: legacy top-level `tools` config
    if (result.tools) {
      const perms: Record<string, Config.PermissionAction> = {}
      for (const [tool, enabled] of Object.entries(result.tools)) {
        const action: Config.PermissionAction = enabled ? "allow" : "deny"
        if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
          perms.edit = action
          continue
        }
        perms[tool] = action
      }
      result.permission = mergeDeep(perms, result.permission ?? {})
    }

    if (!result.username) result.username = os.userInfo().username

    // Handle migration from autoshare to share field
    if (result.autoshare === true && !result.share) {
      result.share = "auto"
    }

    if (!result.keybinds) result.keybinds = Info.shape.keybinds.parse({})

    // Apply flag overrides for compaction settings
    if (Flag.OPENCODE_DISABLE_AUTOCOMPACT) {
      result.compaction = { ...result.compaction, auto: false }
    }
    if (Flag.OPENCODE_DISABLE_PRUNE) {
      result.compaction = { ...result.compaction, prune: false }
    }

    result.plugin = deduplicatePlugins(result.plugin ?? [])

    // Auto-inject ServiceNow MCP servers when credentials are available
    result.mcp = result.mcp ?? {}
    result.mcp = await injectServiceNowMcpServers(result.mcp, auth, log)

    return {
      config: result,
      directories,
    }
  })

  /**
   * Detect the best available JS runtime command.
   * Prefers bun if available, falls back to node.
   */
  function getRuntime(): string {
    try {
      execSync("bun --version", { stdio: "ignore" })
      return "bun"
    } catch {
      return "node"
    }
  }

  let _cachedRuntime: string | undefined

  function runtime(): string {
    if (_cachedRuntime === undefined) _cachedRuntime = getRuntime()
    return _cachedRuntime
  }

  /**
   * Get the MCP server command based on whether we're running bundled or in development
   */
  export function getMcpServerCommand(serverName: "servicenow-unified" | "enterprise-proxy"): string[] {
    // STEP 1: Find the package root by walking up from __dirname looking for package.json
    // This works reliably in both npm packages and development
    const findPackageRoot = (): string | undefined => {
      let current = __dirname

      for (let i = 0; i < 10; i++) {
        // Max 10 levels up
        const pkgPath = path.join(current, "package.json")
        if (existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
            if (["serac", "@serac-labs/core", "snow-flow-test", "snow-code", "snow-flow"].includes(pkg.name)) {
              return current
            }
          } catch {
            /* continue */
          }
        }
        const parent = path.dirname(current)
        if (parent === current) break // Reached root
        current = parent
      }
      return undefined
    }

    const packageRoot = findPackageRoot()

    // STEP 2: Check bundled MCP candidates
    const bundledCandidates = [
      // 1. Relative to found package root (most reliable)
      packageRoot ? path.join(packageRoot, "mcp", `${serverName}.js`) : null,

      // 2. Relative to __dirname - for bin/ directory in npm package
      // When __dirname is bin/, the mcp/ folder is at ../mcp/
      path.join(__dirname, "..", "mcp", `${serverName}.js`),

      // 3. Relative to process.execPath (for standalone binaries)
      path.join(path.dirname(process.execPath), "..", "mcp", `${serverName}.js`),

      // 4. In cwd/node_modules (for when running from another package)
      path.join(process.cwd(), "node_modules", "serac", "mcp", `${serverName}.js`),
      path.join(process.cwd(), "node_modules", "@serac-labs", "core", "mcp", `${serverName}.js`),
      path.join(process.cwd(), "node_modules", "snow-flow-test", "mcp", `${serverName}.js`),
      path.join(process.cwd(), "node_modules", "snow-flow", "mcp", `${serverName}.js`),
      path.join(process.cwd(), "node_modules", "snow-code", "mcp", `${serverName}.js`),
    ].filter(Boolean) as string[]

    log.info("getMcpServerCommand searching for bundled MCP", {
      serverName,
      __dirname,
      execPath: process.execPath,
      packageRoot: packageRoot || "not found",
      candidates: bundledCandidates,
    })

    for (const bundledPath of bundledCandidates) {
      const exists = existsSync(bundledPath)
      log.info("checking bundled path", { bundledPath, exists })
      if (exists) {
        log.info("found bundled MCP server", { serverName, path: bundledPath })
        const rt = runtime()
        log.info("using runtime for MCP server", { runtime: rt })
        return rt === "bun" ? [rt, "run", bundledPath] : [rt, bundledPath]
      }
    }

    // STEP 3: Fallback to TypeScript source (development mode)
    const devRoot = packageRoot || path.resolve(__dirname, "../..")

    const devPaths: Record<string, string> = {
      "servicenow-unified": path.join(devRoot, "..", "servicenow-mcp/src/servicenow-mcp-unified/index.ts"),
      "enterprise-proxy": path.join(devRoot, "..", "servicenow-mcp/src/enterprise-proxy/server.ts"),
    }

    const serverPath = devPaths[serverName]

    // Verify the path exists before returning
    if (!existsSync(serverPath)) {
      log.error("MCP server file not found", {
        serverName,
        path: serverPath,
        packageRoot: packageRoot || "not found",
        __dirname,
      })
    }

    const rt = runtime()
    return rt === "bun" ? [rt, "run", serverPath] : [rt, serverPath]
  }

  /**
   * Inject ServiceNow MCP servers into the config when credentials are available
   */
  async function injectServiceNowMcpServers(
    mcp: NonNullable<Info["mcp"]>,
    auth: Record<string, any>,
    log: ReturnType<typeof Log.create>,
  ): Promise<NonNullable<Info["mcp"]>> {
    const result = { ...mcp }

    // Check for ServiceNow OAuth credentials
    // Always update environment when auth store has fresh credentials, even if a
    // servicenow-unified entry already exists from a config file (which may be stale).
    const snAuth = auth["servicenow"]
    if (snAuth?.type === "servicenow-oauth" && snAuth.instance && snAuth.clientId) {
      const sessionId = getCurrentSessionId()
      const freshEnv = {
        SERVICENOW_INSTANCE_URL: snAuth.instance,
        SERVICENOW_CLIENT_ID: snAuth.clientId,
        SERVICENOW_CLIENT_SECRET: snAuth.clientSecret ?? "",
        SNOW_LAZY_TOOLS: "true",
        ...(sessionId && { SNOW_SESSION_ID: sessionId }),
        ...(snAuth.accessToken && { SERVICENOW_ACCESS_TOKEN: snAuth.accessToken }),
        ...(snAuth.refreshToken && { SERVICENOW_REFRESH_TOKEN: snAuth.refreshToken }),
      }
      const existing = result["servicenow-unified"]
      if (existing && "environment" in existing) {
        existing.environment = { ...existing.environment, ...freshEnv }
        log.info("updated servicenow-unified MCP environment from auth store (OAuth)", {
          instance: snAuth.instance,
        })
      } else {
        log.info("auto-configuring servicenow-unified MCP server from auth store", {
          SNOW_LAZY_TOOLS: "true",
          SNOW_SESSION_ID: sessionId || "none",
        })
        result["servicenow-unified"] = {
          type: "local",
          command: getMcpServerCommand("servicenow-unified"),
          environment: freshEnv,
          enabled: true,
        }
      }
    }

    // Check for ServiceNow Basic Auth credentials
    if (snAuth?.type === "servicenow-basic" && snAuth.instance && snAuth.username) {
      const sessionId = getCurrentSessionId()
      const freshEnv = {
        SERVICENOW_INSTANCE_URL: snAuth.instance,
        SERVICENOW_USERNAME: snAuth.username,
        SERVICENOW_PASSWORD: snAuth.password ?? "",
        SNOW_LAZY_TOOLS: "true",
        ...(sessionId && { SNOW_SESSION_ID: sessionId }),
      }
      const existing = result["servicenow-unified"]
      if (existing && "environment" in existing) {
        existing.environment = { ...existing.environment, ...freshEnv }
        log.info("updated servicenow-unified MCP environment from auth store (Basic)", {
          instance: snAuth.instance,
        })
      } else {
        log.info("auto-configuring servicenow-unified MCP server from basic auth")
        result["servicenow-unified"] = {
          type: "local",
          command: getMcpServerCommand("servicenow-unified"),
          environment: freshEnv,
          enabled: true,
        }
      }
    }

    // Check for Enterprise credentials → also inject servicenow-unified
    // The servicenow-unified server fetches ServiceNow credentials from the enterprise portal
    // at runtime using the JWT token, so no local ServiceNow secrets are needed.
    const entAuth = auth["enterprise"]
    if (entAuth?.type === "enterprise" && (entAuth.licenseKey || entAuth.token) && entAuth.enterpriseUrl) {
      const sessionId = getCurrentSessionId()
      const freshEnv = {
        SNOW_LAZY_TOOLS: "true",
        ...(sessionId && { SNOW_SESSION_ID: sessionId }),
      }
      const existing = result["servicenow-unified"]
      if (existing && "environment" in existing) {
        existing.environment = { ...existing.environment, ...freshEnv }
        log.info("updated servicenow-unified MCP environment from enterprise auth")
      } else if (!existing) {
        log.info("auto-configuring servicenow-unified MCP server from enterprise auth (credentials fetched at runtime)")
        result["servicenow-unified"] = {
          type: "local",
          command: getMcpServerCommand("servicenow-unified"),
          environment: freshEnv,
          enabled: true,
        }
      }
      if (!result["serac-enterprise"] && !result["snow-flow-enterprise"]) {
        log.info("auto-configuring serac-enterprise MCP server from auth store")
        // The enterprise proxy server expects:
        // - SNOW_PORTAL_URL: The portal URL (e.g., https://acme.serac.build) for JWT token exchange
        // - SNOW_LICENSE_KEY: The JWT token (confusing name, but it's the auth token)
        // Note: SNOW_ENTERPRISE_URL is NOT passed here so the proxy uses its correct default (https://enterprise.serac.build)
        const jwtToken = entAuth.token || entAuth.licenseKey
        result["serac-enterprise"] = {
          type: "local",
          command: getMcpServerCommand("enterprise-proxy"),
          environment: {
            SNOW_LICENSE_KEY: jwtToken || "",
            SNOW_PORTAL_URL: entAuth.enterpriseUrl || "",
            ...(entAuth.sessionToken && { SNOW_SESSION_TOKEN: entAuth.sessionToken }),
          },
          enabled: true,
        }
      }
    }

    // Fallback: Check for Enterprise credentials from ~/.snow-code/enterprise.json
    // This file is created by device auth flow and should be the primary token source
    if ((!result["serac-enterprise"] && !result["snow-flow-enterprise"]) || !result["servicenow-unified"]) {
      try {
        const enterpriseJsonPath = path.join(os.homedir(), ".snow-code", "enterprise.json")
        if (existsSync(enterpriseJsonPath)) {
          const content = readFileSync(enterpriseJsonPath, "utf-8")
          const enterpriseData = JSON.parse(content)
          if (enterpriseData.token && enterpriseData.subdomain) {
            if (!result["servicenow-unified"]) {
              const sessionId = getCurrentSessionId()
              log.info(
                "auto-configuring servicenow-unified MCP server from enterprise.json (credentials fetched at runtime)",
                {
                  subdomain: enterpriseData.subdomain,
                },
              )
              result["servicenow-unified"] = {
                type: "local",
                command: getMcpServerCommand("servicenow-unified"),
                environment: {
                  SNOW_LAZY_TOOLS: "true",
                  ...(sessionId && { SNOW_SESSION_ID: sessionId }),
                },
                enabled: true,
              }
            }
            if (!result["serac-enterprise"] && !result["snow-flow-enterprise"]) {
              log.info("auto-configuring serac-enterprise MCP server from enterprise.json", {
                subdomain: enterpriseData.subdomain,
              })
              const portalUrl = `https://${enterpriseData.subdomain}.serac.build`
              result["serac-enterprise"] = {
                type: "local",
                command: getMcpServerCommand("enterprise-proxy"),
                environment: {
                  SNOW_LICENSE_KEY: enterpriseData.token,
                  SNOW_PORTAL_URL: portalUrl,
                },
                enabled: true,
              }
            }
          }
        }
      } catch (err) {
        log.debug("failed to read enterprise.json fallback", { error: err })
      }
    }

    return result
  }

  export async function installDependencies(dir: string) {
    const pkg = path.join(dir, "package.json")

    if (!(await Bun.file(pkg).exists())) {
      await Bun.write(pkg, "{}")
    }

    const gitignore = path.join(dir, ".gitignore")
    const hasGitIgnore = await Bun.file(gitignore).exists()
    if (!hasGitIgnore) await Bun.write(gitignore, ["node_modules", "package.json", "bun.lock", ".gitignore"].join("\n"))

    await BunProc.run(
      ["add", "@opencode-ai/plugin@" + (Installation.isLocal() ? "latest" : Installation.VERSION), "--exact"],
      {
        cwd: dir,
      },
    ).catch(() => {})

    // Install any additional dependencies defined in the package.json
    // This allows local plugins and custom tools to use external packages
    await BunProc.run(["install"], { cwd: dir }).catch(() => {})
  }

  function rel(item: string, patterns: string[]) {
    for (const pattern of patterns) {
      const index = item.indexOf(pattern)
      if (index === -1) continue
      return item.slice(index + pattern.length)
    }
  }

  function trim(file: string) {
    const ext = path.extname(file)
    return ext.length ? file.slice(0, -ext.length) : file
  }

  const COMMAND_GLOB = new Bun.Glob("{command,commands}/**/*.md")
  async function loadCommand(dir: string) {
    const result: Record<string, Command> = {}
    for await (const item of COMMAND_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse command ${item}`
        const { Session } = await import("@/session")
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load command", { command: item, err })
        return undefined
      })
      if (!md) continue

      const patterns = ["/.snow-code/command/", "/.snow-code/commands/", "/command/", "/commands/"]
      const file = rel(item, patterns) ?? path.basename(item)
      const name = trim(file)

      const config = {
        name,
        ...md.data,
        template: md.content.trim(),
      }
      const parsed = Command.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }

  const AGENT_GLOB = new Bun.Glob("{agent,agents}/**/*.md")
  async function loadAgent(dir: string) {
    const result: Record<string, Agent> = {}

    for await (const item of AGENT_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse agent ${item}`
        const { Session } = await import("@/session")
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load agent", { agent: item, err })
        return undefined
      })
      if (!md) continue

      const patterns = ["/.snow-code/agent/", "/.snow-code/agents/", "/agent/", "/agents/"]
      const file = rel(item, patterns) ?? path.basename(item)
      const agentName = trim(file)

      const config = {
        name: agentName,
        ...md.data,
        prompt: md.content.trim(),
      }
      const parsed = Agent.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }

  const MODE_GLOB = new Bun.Glob("{mode,modes}/*.md")
  async function loadMode(dir: string) {
    const result: Record<string, Agent> = {}
    for await (const item of MODE_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse mode ${item}`
        const { Session } = await import("@/session")
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load mode", { mode: item, err })
        return undefined
      })
      if (!md) continue

      const config = {
        name: path.basename(item, ".md"),
        ...md.data,
        prompt: md.content.trim(),
      }
      const parsed = Agent.safeParse(config)
      if (parsed.success) {
        result[config.name] = {
          ...parsed.data,
          mode: "primary" as const,
        }
        continue
      }
    }
    return result
  }

  const PLUGIN_GLOB = new Bun.Glob("{plugin,plugins}/*.{ts,js}")
  async function loadPlugin(dir: string) {
    const plugins: string[] = []

    for await (const item of PLUGIN_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      plugins.push(pathToFileURL(item).href)
    }
    return plugins
  }

  /**
   * Extracts a canonical plugin name from a plugin specifier.
   * - For file:// URLs: extracts filename without extension
   * - For npm packages: extracts package name without version
   *
   * @example
   * getPluginName("file:///path/to/plugin/foo.js") // "foo"
   * getPluginName("oh-my-opencode@2.4.3") // "oh-my-opencode"
   * getPluginName("@scope/pkg@1.0.0") // "@scope/pkg"
   */
  export function getPluginName(plugin: string): string {
    if (plugin.startsWith("file://")) {
      return path.parse(new URL(plugin).pathname).name
    }
    const lastAt = plugin.lastIndexOf("@")
    if (lastAt > 0) {
      return plugin.substring(0, lastAt)
    }
    return plugin
  }

  /**
   * Deduplicates plugins by name, with later entries (higher priority) winning.
   * Priority order (highest to lowest):
   * 1. Local plugin/ directory
   * 2. Local snow-code.json
   * 3. Global plugin/ directory
   * 4. Global snow-code.json
   *
   * Since plugins are added in low-to-high priority order,
   * we reverse, deduplicate (keeping first occurrence), then restore order.
   */
  export function deduplicatePlugins(plugins: string[]): string[] {
    // seenNames: canonical plugin names for duplicate detection
    // e.g., "oh-my-opencode", "@scope/pkg"
    const seenNames = new Set<string>()

    // uniqueSpecifiers: full plugin specifiers to return
    // e.g., "oh-my-opencode@2.4.3", "file:///path/to/plugin.js"
    const uniqueSpecifiers: string[] = []

    for (const specifier of plugins.toReversed()) {
      const name = getPluginName(specifier)
      if (!seenNames.has(name)) {
        seenNames.add(name)
        uniqueSpecifiers.push(specifier)
      }
    }

    return uniqueSpecifiers.toReversed()
  }

  export const McpLocal = z
    .object({
      type: z.literal("local").describe("Type of MCP server connection"),
      command: z.string().array().describe("Command and arguments to run the MCP server"),
      environment: z
        .record(z.string(), z.string())
        .optional()
        .describe("Environment variables to set when running the MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    })
    .strict()
    .meta({
      ref: "McpLocalConfig",
    })

  export const McpOAuth = z
    .object({
      clientId: z
        .string()
        .optional()
        .describe("OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted."),
      clientSecret: z.string().optional().describe("OAuth client secret (if required by the authorization server)"),
      scope: z.string().optional().describe("OAuth scopes to request during authorization"),
    })
    .strict()
    .meta({
      ref: "McpOAuthConfig",
    })
  export type McpOAuth = z.infer<typeof McpOAuth>

  export const McpRemote = z
    .object({
      type: z.literal("remote").describe("Type of MCP server connection"),
      url: z.string().describe("URL of the remote MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      headers: z.record(z.string(), z.string()).optional().describe("Headers to send with the request"),
      oauth: z
        .union([McpOAuth, z.literal(false)])
        .optional()
        .describe(
          "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    })
    .strict()
    .meta({
      ref: "McpRemoteConfig",
    })

  export const Mcp = z.discriminatedUnion("type", [McpLocal, McpRemote])
  export type Mcp = z.infer<typeof Mcp>

  export const PermissionAction = z.enum(["ask", "allow", "deny"]).meta({
    ref: "PermissionActionConfig",
  })
  export type PermissionAction = z.infer<typeof PermissionAction>

  export const PermissionObject = z.record(z.string(), PermissionAction).meta({
    ref: "PermissionObjectConfig",
  })
  export type PermissionObject = z.infer<typeof PermissionObject>

  export const PermissionRule = z.union([PermissionAction, PermissionObject]).meta({
    ref: "PermissionRuleConfig",
  })
  export type PermissionRule = z.infer<typeof PermissionRule>

  // Capture original key order before zod reorders, then rebuild in original order
  const permissionPreprocess = (val: unknown) => {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      return { __originalKeys: Object.keys(val), ...val }
    }
    return val
  }

  const permissionTransform = (x: unknown): Record<string, PermissionRule> => {
    if (typeof x === "string") return { "*": x as PermissionAction }
    const obj = x as { __originalKeys?: string[] } & Record<string, unknown>
    const { __originalKeys, ...rest } = obj
    if (!__originalKeys) return rest as Record<string, PermissionRule>
    const result: Record<string, PermissionRule> = {}
    for (const key of __originalKeys) {
      if (key in rest) result[key] = rest[key] as PermissionRule
    }
    return result
  }

  export const Permission = z
    .preprocess(
      permissionPreprocess,
      z
        .object({
          __originalKeys: z.string().array().optional(),
          read: PermissionRule.optional(),
          edit: PermissionRule.optional(),
          glob: PermissionRule.optional(),
          grep: PermissionRule.optional(),
          list: PermissionRule.optional(),
          bash: PermissionRule.optional(),
          task: PermissionRule.optional(),
          external_directory: PermissionRule.optional(),
          todowrite: PermissionAction.optional(),
          todoread: PermissionAction.optional(),
          question: PermissionAction.optional(),
          webfetch: PermissionAction.optional(),
          websearch: PermissionAction.optional(),
          codesearch: PermissionAction.optional(),
          lsp: PermissionRule.optional(),
          doom_loop: PermissionAction.optional(),
        })
        .catchall(PermissionRule)
        .or(PermissionAction),
    )
    .transform(permissionTransform)
    .meta({
      ref: "PermissionConfig",
    })
  export type Permission = z.infer<typeof Permission>

  export const Command = z.object({
    template: z.string(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    subtask: z.boolean().optional(),
  })
  export type Command = z.infer<typeof Command>

  export const Agent = z
    .object({
      model: z.string().optional(),
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      prompt: z.string().optional(),
      tools: z.record(z.string(), z.boolean()).optional().describe("@deprecated Use 'permission' field instead"),
      disable: z.boolean().optional(),
      description: z.string().optional().describe("Description of when to use the agent"),
      mode: z.enum(["subagent", "primary", "all"]).optional(),
      hidden: z
        .boolean()
        .optional()
        .describe("Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)"),
      options: z.record(z.string(), z.any()).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color format")
        .optional()
        .describe("Hex color code for the agent (e.g., #FF5733)"),
      steps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of agentic iterations before forcing text-only response"),
      maxSteps: z.number().int().positive().optional().describe("@deprecated Use 'steps' field instead."),
      permission: Permission.optional(),
    })
    .catchall(z.any())
    .transform((agent, ctx) => {
      const knownKeys = new Set([
        "name",
        "model",
        "prompt",
        "description",
        "temperature",
        "top_p",
        "mode",
        "hidden",
        "color",
        "steps",
        "maxSteps",
        "options",
        "permission",
        "disable",
        "tools",
      ])

      // Extract unknown properties into options
      const options: Record<string, unknown> = { ...agent.options }
      for (const [key, value] of Object.entries(agent)) {
        if (!knownKeys.has(key)) options[key] = value
      }

      // Convert legacy tools config to permissions
      const permission: Permission = {}
      for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
        const action = enabled ? "allow" : "deny"
        // write, edit, patch, multiedit all map to edit permission
        if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
          permission.edit = action
        } else {
          permission[tool] = action
        }
      }
      Object.assign(permission, agent.permission)

      // Convert legacy maxSteps to steps
      const steps = agent.steps ?? agent.maxSteps

      return { ...agent, options, permission, steps } as typeof agent & {
        options?: Record<string, unknown>
        permission?: Permission
        steps?: number
      }
    })
    .meta({
      ref: "AgentConfig",
    })
  export type Agent = z.infer<typeof Agent>

  export const Keybinds = z
    .object({
      leader: z.string().optional().default("ctrl+x").describe("Leader key for keybind combinations"),
      app_exit: z.string().optional().default("ctrl+c,ctrl+d,<leader>q").describe("Exit the application"),
      editor_open: z.string().optional().default("<leader>e").describe("Open external editor"),
      theme_list: z.string().optional().default("<leader>t").describe("List available themes"),
      sidebar_toggle: z.string().optional().default("<leader>b").describe("Toggle sidebar"),
      scrollbar_toggle: z.string().optional().default("none").describe("Toggle session scrollbar"),
      username_toggle: z.string().optional().default("none").describe("Toggle username visibility"),
      status_view: z.string().optional().default("<leader>s").describe("View status"),
      session_export: z.string().optional().default("<leader>x").describe("Export session to editor"),
      session_new: z.string().optional().default("<leader>n").describe("Create a new session"),
      session_list: z.string().optional().default("<leader>l").describe("List all sessions"),
      session_timeline: z.string().optional().default("<leader>g").describe("Show session timeline"),
      session_fork: z.string().optional().default("none").describe("Fork session from message"),
      session_rename: z.string().optional().default("ctrl+r").describe("Rename session"),
      session_delete: z.string().optional().default("ctrl+d").describe("Delete session"),
      stash_delete: z.string().optional().default("ctrl+d").describe("Delete stash entry"),
      model_provider_list: z.string().optional().default("ctrl+a").describe("Open provider list from model dialog"),
      model_favorite_toggle: z.string().optional().default("ctrl+f").describe("Toggle model favorite status"),
      session_share: z.string().optional().default("none").describe("Share current session"),
      session_unshare: z.string().optional().default("none").describe("Unshare current session"),
      session_interrupt: z.string().optional().default("escape").describe("Interrupt current session"),
      session_compact: z.string().optional().default("<leader>c").describe("Compact the session"),
      messages_page_up: z.string().optional().default("pageup,ctrl+alt+b").describe("Scroll messages up by one page"),
      messages_page_down: z
        .string()
        .optional()
        .default("pagedown,ctrl+alt+f")
        .describe("Scroll messages down by one page"),
      messages_line_up: z.string().optional().default("ctrl+alt+y").describe("Scroll messages up by one line"),
      messages_line_down: z.string().optional().default("ctrl+alt+e").describe("Scroll messages down by one line"),
      messages_half_page_up: z.string().optional().default("ctrl+alt+u").describe("Scroll messages up by half page"),
      messages_half_page_down: z
        .string()
        .optional()
        .default("ctrl+alt+d")
        .describe("Scroll messages down by half page"),
      messages_first: z.string().optional().default("ctrl+g,home").describe("Navigate to first message"),
      messages_last: z.string().optional().default("ctrl+alt+g,end").describe("Navigate to last message"),
      messages_next: z.string().optional().default("none").describe("Navigate to next message"),
      messages_previous: z.string().optional().default("none").describe("Navigate to previous message"),
      messages_last_user: z.string().optional().default("none").describe("Navigate to last user message"),
      messages_copy: z.string().optional().default("<leader>y").describe("Copy message"),
      messages_undo: z.string().optional().default("<leader>u").describe("Undo message"),
      messages_redo: z.string().optional().default("<leader>r").describe("Redo message"),
      messages_toggle_conceal: z
        .string()
        .optional()
        .default("<leader>h")
        .describe("Toggle code block concealment in messages"),
      tool_details: z.string().optional().default("none").describe("Toggle tool details visibility"),
      model_list: z.string().optional().default("<leader>m").describe("List available models"),
      model_cycle_recent: z.string().optional().default("f2").describe("Next recently used model"),
      model_cycle_recent_reverse: z.string().optional().default("shift+f2").describe("Previous recently used model"),
      model_cycle_favorite: z.string().optional().default("none").describe("Next favorite model"),
      model_cycle_favorite_reverse: z.string().optional().default("none").describe("Previous favorite model"),
      command_list: z.string().optional().default("ctrl+p").describe("List available commands"),
      agent_list: z.string().optional().default("<leader>a").describe("List agents"),
      agent_cycle: z.string().optional().default("shift+tab").describe("Next agent"),
      agent_cycle_reverse: z.string().optional().default("ctrl+shift+tab").describe("Previous agent"),
      variant_cycle: z.string().optional().default("ctrl+t").describe("Cycle model variants"),
      input_clear: z.string().optional().default("ctrl+c").describe("Clear input field"),
      input_paste: z.string().optional().default("ctrl+v").describe("Paste from clipboard"),
      input_submit: z.string().optional().default("return").describe("Submit input"),
      input_newline: z
        .string()
        .optional()
        .default("shift+return,ctrl+return,alt+return,ctrl+j")
        .describe("Insert newline in input"),
      input_move_left: z.string().optional().default("left,ctrl+b").describe("Move cursor left in input"),
      input_move_right: z.string().optional().default("right,ctrl+f").describe("Move cursor right in input"),
      input_move_up: z.string().optional().default("up").describe("Move cursor up in input"),
      input_move_down: z.string().optional().default("down").describe("Move cursor down in input"),
      input_select_left: z.string().optional().default("shift+left").describe("Select left in input"),
      input_select_right: z.string().optional().default("shift+right").describe("Select right in input"),
      input_select_up: z.string().optional().default("shift+up").describe("Select up in input"),
      input_select_down: z.string().optional().default("shift+down").describe("Select down in input"),
      input_line_home: z.string().optional().default("ctrl+a").describe("Move to start of line in input"),
      input_line_end: z.string().optional().default("ctrl+e").describe("Move to end of line in input"),
      input_select_line_home: z
        .string()
        .optional()
        .default("ctrl+shift+a")
        .describe("Select to start of line in input"),
      input_select_line_end: z.string().optional().default("ctrl+shift+e").describe("Select to end of line in input"),
      input_visual_line_home: z.string().optional().default("alt+a").describe("Move to start of visual line in input"),
      input_visual_line_end: z.string().optional().default("alt+e").describe("Move to end of visual line in input"),
      input_select_visual_line_home: z
        .string()
        .optional()
        .default("alt+shift+a")
        .describe("Select to start of visual line in input"),
      input_select_visual_line_end: z
        .string()
        .optional()
        .default("alt+shift+e")
        .describe("Select to end of visual line in input"),
      input_buffer_home: z.string().optional().default("home").describe("Move to start of buffer in input"),
      input_buffer_end: z.string().optional().default("end").describe("Move to end of buffer in input"),
      input_select_buffer_home: z
        .string()
        .optional()
        .default("shift+home")
        .describe("Select to start of buffer in input"),
      input_select_buffer_end: z.string().optional().default("shift+end").describe("Select to end of buffer in input"),
      input_delete_line: z.string().optional().default("ctrl+shift+d").describe("Delete line in input"),
      input_delete_to_line_end: z.string().optional().default("ctrl+k").describe("Delete to end of line in input"),
      input_delete_to_line_start: z.string().optional().default("ctrl+u").describe("Delete to start of line in input"),
      input_backspace: z.string().optional().default("backspace,shift+backspace").describe("Backspace in input"),
      input_delete: z.string().optional().default("ctrl+d,delete,shift+delete").describe("Delete character in input"),
      input_undo: z.string().optional().default("ctrl+-,super+z").describe("Undo in input"),
      input_redo: z.string().optional().default("ctrl+.,super+shift+z").describe("Redo in input"),
      input_word_forward: z
        .string()
        .optional()
        .default("alt+f,alt+right,ctrl+right")
        .describe("Move word forward in input"),
      input_word_backward: z
        .string()
        .optional()
        .default("alt+b,alt+left,ctrl+left")
        .describe("Move word backward in input"),
      input_select_word_forward: z
        .string()
        .optional()
        .default("alt+shift+f,alt+shift+right")
        .describe("Select word forward in input"),
      input_select_word_backward: z
        .string()
        .optional()
        .default("alt+shift+b,alt+shift+left")
        .describe("Select word backward in input"),
      input_delete_word_forward: z
        .string()
        .optional()
        .default("alt+d,alt+delete,ctrl+delete")
        .describe("Delete word forward in input"),
      input_delete_word_backward: z
        .string()
        .optional()
        .default("ctrl+w,ctrl+backspace,alt+backspace")
        .describe("Delete word backward in input"),
      history_previous: z.string().optional().default("up").describe("Previous history item"),
      history_next: z.string().optional().default("down").describe("Next history item"),
      session_child_cycle: z.string().optional().default("<leader>right").describe("Next child session"),
      session_child_cycle_reverse: z.string().optional().default("<leader>left").describe("Previous child session"),
      session_parent: z.string().optional().default("<leader>up").describe("Go to parent session"),
      terminal_suspend: z.string().optional().default("ctrl+z").describe("Suspend terminal"),
      terminal_title_toggle: z.string().optional().default("none").describe("Toggle terminal title"),
      tips_toggle: z.string().optional().default("<leader>h").describe("Toggle tips on home screen"),
    })
    .strict()
    .meta({
      ref: "KeybindsConfig",
    })

  export const TUI = z.object({
    scroll_speed: z.number().min(0.001).optional().describe("TUI scroll speed"),
    scroll_acceleration: z
      .object({
        enabled: z.boolean().describe("Enable scroll acceleration"),
      })
      .optional()
      .describe("Scroll acceleration settings"),
    diff_style: z
      .enum(["auto", "stacked"])
      .optional()
      .describe("Control diff rendering style: 'auto' adapts to terminal width, 'stacked' always shows single column"),
  })

  export const Server = z
    .object({
      port: z.number().int().positive().optional().describe("Port to listen on"),
      hostname: z.string().optional().describe("Hostname to listen on"),
      mdns: z.boolean().optional().describe("Enable mDNS service discovery"),
      cors: z.array(z.string()).optional().describe("Additional domains to allow for CORS"),
    })
    .strict()
    .meta({
      ref: "ServerConfig",
    })

  export const Layout = z.enum(["auto", "stretch"]).meta({
    ref: "LayoutConfig",
  })
  export type Layout = z.infer<typeof Layout>

  export const Provider = ModelsDev.Provider.partial()
    .extend({
      whitelist: z.array(z.string()).optional(),
      blacklist: z.array(z.string()).optional(),
      models: z
        .record(
          z.string(),
          ModelsDev.Model.partial().extend({
            variants: z
              .record(
                z.string(),
                z
                  .object({
                    disabled: z.boolean().optional().describe("Disable this variant for the model"),
                  })
                  .catchall(z.any()),
              )
              .optional()
              .describe("Variant-specific configuration"),
          }),
        )
        .optional(),
      options: z
        .object({
          apiKey: z.string().optional(),
          baseURL: z.string().optional(),
          enterpriseUrl: z.string().optional().describe("GitHub Enterprise URL for copilot authentication"),
          setCacheKey: z.boolean().optional().describe("Enable promptCacheKey for this provider (default false)"),
          timeout: z
            .union([
              z
                .number()
                .int()
                .positive()
                .describe(
                  "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
                ),
              z.literal(false).describe("Disable timeout for this provider entirely."),
            ])
            .optional()
            .describe(
              "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
            ),
          chunkTimeout: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Timeout in milliseconds between streamed SSE chunks for this provider. If no chunk arrives within this window, the request is aborted.",
            ),
        })
        .catchall(z.any())
        .optional(),
    })
    .strict()
    .meta({
      ref: "ProviderConfig",
    })
  export type Provider = z.infer<typeof Provider>

  export const Info = z
    .object({
      $schema: z.string().optional().describe("JSON schema reference for configuration validation"),
      theme: z.string().optional().describe("Theme name to use for the interface"),
      keybinds: Keybinds.optional().describe("Custom keybind configurations"),
      logLevel: Log.Level.optional().describe("Log level"),
      tui: TUI.optional().describe("TUI specific settings"),
      server: Server.optional().describe("Server configuration for opencode serve and web commands"),
      command: z
        .record(z.string(), Command)
        .optional()
        .describe("Command configuration, see https://serac.build/docs/commands"),
      watcher: z
        .object({
          ignore: z.array(z.string()).optional(),
        })
        .optional(),
      plugin: z.string().array().optional(),
      snapshot: z.boolean().optional(),
      share: z
        .enum(["manual", "auto", "disabled"])
        .optional()
        .describe(
          "Control sharing behavior:'manual' allows manual sharing via commands, 'auto' enables automatic sharing, 'disabled' disables all sharing",
        ),
      autoshare: z
        .boolean()
        .optional()
        .describe("@deprecated Use 'share' field instead. Share newly created sessions automatically"),
      autoupdate: z
        .union([z.boolean(), z.literal("notify")])
        .optional()
        .describe(
          "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
        ),
      disabled_providers: z.array(z.string()).optional().describe("Disable providers that are loaded automatically"),
      enabled_providers: z
        .array(z.string())
        .optional()
        .describe("When set, ONLY these providers will be enabled. All other providers will be ignored"),
      model: z.string().describe("Model to use in the format of provider/model, eg anthropic/claude-2").optional(),
      small_model: z
        .string()
        .describe("Small model to use for tasks like title generation in the format of provider/model")
        .optional(),
      default_agent: z
        .string()
        .optional()
        .describe(
          "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
        ),
      username: z
        .string()
        .optional()
        .describe("Custom username to display in conversations instead of system username"),
      mode: z
        .object({
          build: Agent.optional(),
          plan: Agent.optional(),
        })
        .catchall(Agent)
        .optional()
        .describe("@deprecated Use `agent` field instead."),
      agent: z
        .object({
          // primary
          plan: Agent.optional(),
          build: Agent.optional(),
          // subagent
          general: Agent.optional(),
          explore: Agent.optional(),
          // specialized
          title: Agent.optional(),
          summary: Agent.optional(),
          compaction: Agent.optional(),
        })
        .catchall(Agent)
        .optional()
        .describe("Agent configuration, see https://serac.build/docs/agents"),
      provider: z
        .record(z.string(), Provider)
        .optional()
        .describe("Custom provider configurations and model overrides"),
      mcp: z
        .record(
          z.string(),
          z.union([
            Mcp,
            z
              .object({
                enabled: z.boolean(),
              })
              .strict(),
          ]),
        )
        .optional()
        .describe("MCP (Model Context Protocol) server configurations"),
      formatter: z
        .union([
          z.literal(false),
          z.record(
            z.string(),
            z.object({
              disabled: z.boolean().optional(),
              command: z.array(z.string()).optional(),
              environment: z.record(z.string(), z.string()).optional(),
              extensions: z.array(z.string()).optional(),
            }),
          ),
        ])
        .optional(),
      lsp: z
        .union([
          z.literal(false),
          z.record(
            z.string(),
            z.union([
              z.object({
                disabled: z.literal(true),
              }),
              z.object({
                command: z.array(z.string()),
                extensions: z.array(z.string()).optional(),
                disabled: z.boolean().optional(),
                env: z.record(z.string(), z.string()).optional(),
                initialization: z.record(z.string(), z.any()).optional(),
              }),
            ]),
          ),
        ])
        .optional()
        .refine(
          (data) => {
            if (!data) return true
            if (typeof data === "boolean") return true
            const serverIds = new Set(Object.values(LSPServer).map((s) => s.id))

            return Object.entries(data).every(([id, config]) => {
              if (config.disabled) return true
              if (serverIds.has(id)) return true
              return Boolean(config.extensions)
            })
          },
          {
            error: "For custom LSP servers, 'extensions' array is required.",
          },
        ),
      instructions: z.array(z.string()).optional().describe("Additional instruction files or patterns to include"),
      layout: Layout.optional().describe("@deprecated Always uses stretch layout."),
      permission: Permission.optional(),
      tools: z
        .record(z.string(), z.boolean())
        .optional()
        .describe(
          "Enable/disable specific tools. Web tools (webfetch, websearch, codesearch) are disabled by default.",
        ),
      enterprise: z
        .object({
          url: z.string().optional().describe("Enterprise URL"),
        })
        .optional(),
      telemetry: z
        .boolean()
        .optional()
        .describe("Enable anonymous usage telemetry (default: true). Set to false to disable."),
      compaction: z
        .object({
          auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
          prune: z.boolean().optional().describe("Enable pruning of old tool outputs (default: true)"),
        })
        .optional(),
      contextdb: z
        .object({
          enabled: z
            .boolean()
            .optional()
            .describe("Enable the ContextDB layer for cross-session memory and retrieval (default: true)"),
          persist_summaries: z
            .boolean()
            .optional()
            .describe("Persist compaction summaries to SQLite for future retrieval (default: true)"),
          cross_session_retrieval: z
            .boolean()
            .optional()
            .describe("Retrieve relevant context from prior sessions when assembling prompts (default: true)"),
          max_db_size_mb: z
            .number()
            .optional()
            .describe("Maximum ContextDB size in megabytes before automatic cleanup (default: 500)"),
        })
        .optional(),
      experimental: z
        .object({
          hook: z
            .object({
              file_edited: z
                .record(
                  z.string(),
                  z
                    .object({
                      command: z.string().array(),
                      environment: z.record(z.string(), z.string()).optional(),
                    })
                    .array(),
                )
                .optional(),
              session_completed: z
                .object({
                  command: z.string().array(),
                  environment: z.record(z.string(), z.string()).optional(),
                })
                .array()
                .optional(),
            })
            .optional(),
          chatMaxRetries: z.number().optional().describe("Number of retries for chat completions on failure"),
          disable_paste_summary: z.boolean().optional(),
          batch_tool: z.boolean().optional().describe("Enable the batch tool"),
          openTelemetry: z
            .boolean()
            .optional()
            .describe("Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)"),
          primary_tools: z
            .array(z.string())
            .optional()
            .describe("Tools that should only be available to primary agents."),
          continue_loop_on_deny: z.boolean().optional().describe("Continue the agent loop when a tool call is denied"),
          mcp_timeout: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Timeout in milliseconds for model context protocol (MCP) requests"),
        })
        .optional(),
    })
    .strict()
    .meta({
      ref: "Config",
    })

  export type Info = z.output<typeof Info>

  export const global = lazy(async () => {
    let result: Info = pipe(
      {},
      mergeDeep(await loadFile(path.join(Global.Path.config, "snow-code.json"))),
      mergeDeep(await loadFile(path.join(Global.Path.config, "snow-code.jsonc"))),
    )

    await import(path.join(Global.Path.config, "config"), {
      with: {
        type: "toml",
      },
    })
      .then(async (mod) => {
        const { provider, model, ...rest } = mod.default
        if (provider && model) result.model = `${provider}/${model}`
        result["$schema"] = "https://serac.build/config.json"
        result = mergeDeep(result, rest)
        await Bun.write(path.join(Global.Path.config, "snow-code.json"), JSON.stringify(result, null, 2))
        await fs.unlink(path.join(Global.Path.config, "config"))
      })
      .catch(() => {})

    return result
  })

  async function loadFile(filepath: string): Promise<Info> {
    log.info("loading", { path: filepath })
    let text = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (err.code === "ENOENT") return
        throw new JsonError({ path: filepath }, { cause: err })
      })
    if (!text) return {}
    return load(text, filepath)
  }

  async function load(text: string, configFilepath: string) {
    const original = text
    text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || ""
    })

    const fileMatches = text.match(/\{file:[^}]+\}/g)
    if (fileMatches) {
      const configDir = path.dirname(configFilepath)
      const lines = text.split("\n")

      for (const match of fileMatches) {
        const lineIndex = lines.findIndex((line) => line.includes(match))
        if (lineIndex !== -1 && lines[lineIndex].trim().startsWith("//")) {
          continue // Skip if line is commented
        }
        let filePath = match.replace(/^\{file:/, "").replace(/\}$/, "")
        if (filePath.startsWith("~/")) {
          filePath = path.join(os.homedir(), filePath.slice(2))
        }
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
        const fileContent = (
          await Bun.file(resolvedPath)
            .text()
            .catch((error) => {
              const errMsg = `bad file reference: "${match}"`
              if (error.code === "ENOENT") {
                throw new InvalidError(
                  {
                    path: configFilepath,
                    message: errMsg + ` ${resolvedPath} does not exist`,
                  },
                  { cause: error },
                )
              }
              throw new InvalidError({ path: configFilepath, message: errMsg }, { cause: error })
            })
        ).trim()
        // escape newlines/quotes, strip outer quotes
        text = text.replace(match, JSON.stringify(fileContent).slice(1, -1))
      }
    }

    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const lines = text.split("\n")
      const errorDetails = errors
        .map((e) => {
          const beforeOffset = text.substring(0, e.offset).split("\n")
          const line = beforeOffset.length
          const column = beforeOffset[beforeOffset.length - 1].length + 1
          const problemLine = lines[line - 1]

          const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
          if (!problemLine) return error

          return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
        })
        .join("\n")

      throw new JsonError({
        path: configFilepath,
        message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`,
      })
    }

    const parsed = Info.safeParse(data)
    if (parsed.success) {
      if (!parsed.data.$schema) {
        parsed.data.$schema = "https://serac.build/config.json"
        // Write the $schema to the original text to preserve variables like {env:VAR}
        const updated = original.replace(/^\s*\{/, '{\n  "$schema": "https://serac.build/config.json",')
        await Bun.write(configFilepath, updated).catch(() => {})
      }
      const data = parsed.data
      if (data.plugin) {
        for (let i = 0; i < data.plugin.length; i++) {
          const plugin = data.plugin[i]
          try {
            data.plugin[i] = import.meta.resolve!(plugin, configFilepath)
          } catch (err) {}
        }
      }
      return data
    }

    throw new InvalidError({
      path: configFilepath,
      issues: parsed.error.issues,
    })
  }
  export const JsonError = NamedError.create(
    "ConfigJsonError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
    }),
  )

  export const ConfigDirectoryTypoError = NamedError.create(
    "ConfigDirectoryTypoError",
    z.object({
      path: z.string(),
      dir: z.string(),
      suggestion: z.string(),
    }),
  )

  export const InvalidError = NamedError.create(
    "ConfigInvalidError",
    z.object({
      path: z.string(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
      message: z.string().optional(),
    }),
  )

  export async function get() {
    return state().then((x) => x.config)
  }

  export async function getGlobal() {
    return global()
  }

  export async function update(config: Info) {
    const filepath = path.join(Instance.directory, "snow-code.json")
    const existing = await loadFile(filepath)
    await Bun.write(filepath, JSON.stringify(mergeDeep(existing, config), null, 2))
    await Instance.dispose()
  }

  function globalConfigFile() {
    const candidates = ["snow-code.jsonc", "snow-code.json"].map((file) => path.join(Global.Path.config, file))
    for (const file of candidates) {
      if (existsSync(file)) return file
    }
    return candidates[0]
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }

  function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
    if (!isRecord(patch)) {
      const edits = modify(input, path, patch, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
        },
      })
      return applyEdits(input, edits)
    }

    return Object.entries(patch).reduce((result, [key, value]) => {
      if (value === undefined) return result
      return patchJsonc(result, value, [...path, key])
    }, input)
  }

  function parseConfig(text: string, filepath: string): Info {
    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const lines = text.split("\n")
      const errorDetails = errors
        .map((e) => {
          const beforeOffset = text.substring(0, e.offset).split("\n")
          const line = beforeOffset.length
          const column = beforeOffset[beforeOffset.length - 1].length + 1
          const problemLine = lines[line - 1]

          const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
          if (!problemLine) return error

          return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
        })
        .join("\n")

      throw new JsonError({
        path: filepath,
        message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`,
      })
    }

    const parsed = Info.safeParse(data)
    if (parsed.success) return parsed.data

    throw new InvalidError({
      path: filepath,
      issues: parsed.error.issues,
    })
  }

  export async function updateGlobal(config: Info) {
    const filepath = globalConfigFile()
    const before = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (err.code === "ENOENT") return "{}"
        throw new JsonError({ path: filepath }, { cause: err })
      })

    if (!filepath.endsWith(".jsonc")) {
      const existing = parseConfig(before, filepath)
      await Bun.write(filepath, JSON.stringify(mergeDeep(existing, config), null, 2))
    } else {
      const next = patchJsonc(before, config)
      parseConfig(next, filepath)
      await Bun.write(filepath, next)
    }

    global.reset()
    await Instance.disposeAll()
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Event.Disposed.type,
        properties: {},
      },
    })
  }

  export async function directories() {
    return state().then((x) => x.directories)
  }
}
