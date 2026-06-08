/**
 * Tool session store — persistence abstraction for per-(tenant, session)
 * enabled-tool sets used by the lazy-loading tool_search flow.
 *
 * Stdio transport uses `FileToolSessionStore`, which writes one JSON file
 * per session under the machine-local XDG data directory — same behavior
 * as the pre-refactor `tool-search.ts` code path, but now namespaced by
 * tenant so a future stdio deployment with multiple users doesn't collide.
 *
 * HTTP transport uses `MemoryToolSessionStore`, which keeps all sessions
 * in a single process-wide `TenantScopedCache`. Sessions don't survive
 * restarts (tokens will be re-enabled on the next request chain), which
 * is the correct behavior for a multi-tenant web server where local fs
 * writes would be an information leak.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { mcpDebug } from "../../shared/mcp-debug.js"
import { TenantScopedCache } from "./tenant-scoped-cache.js"

export interface ToolSessionStore {
  /** Return the set of tool IDs enabled for a tenant+session, or empty set. */
  getEnabled(tenantId: string, sessionId: string): Promise<Set<string>>

  /** Replace the set of enabled tools for a tenant+session. */
  setEnabled(tenantId: string, sessionId: string, tools: Set<string>): Promise<void>

  /** Remove all enablement state for a tenant+session. */
  clear(tenantId: string, sessionId: string): Promise<void>
}

/**
 * Resolve the base directory where stdio persists enabled-tool state.
 * Matches the XDG convention used elsewhere in snow-code.
 */
const getStdioDataDir = (): string => {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "snow-code")
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "snow-code")
  }
  return path.join(os.homedir(), ".local", "share", "snow-code")
}

/**
 * Sanitize an identifier to be filesystem-safe.
 * Same character class as the legacy code so existing files remain readable.
 */
const sanitize = (id: string): string => id.replace(/[^a-zA-Z0-9-_]/g, "_")

/**
 * File-backed store used by the stdio transport.
 *
 * Layout: `{dataDir}/enabled-tools/{sanitize(tenantId)}/{sanitize(sessionId)}.json`
 *
 * The tenant directory is included even for stdio (where tenantId is the
 * sentinel `"stdio"`) so that a future multi-user stdio deployment — or
 * dev-switching between stdio contexts — never crosses streams.
 */
export class FileToolSessionStore implements ToolSessionStore {
  private readonly baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(getStdioDataDir(), "enabled-tools")
  }

  private fileFor(tenantId: string, sessionId: string): string {
    return path.join(this.baseDir, sanitize(tenantId), `${sanitize(sessionId)}.json`)
  }

  async getEnabled(tenantId: string, sessionId: string): Promise<Set<string>> {
    const filePath = this.fileFor(tenantId, sessionId)
    try {
      if (!fs.existsSync(filePath)) {
        return new Set()
      }
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"))
      if (data.tools && Array.isArray(data.tools)) {
        return new Set<string>(data.tools)
      }
      return new Set()
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        mcpDebug(`[ToolSessionStore] Failed to restore enabled tools: ${e.message}`)
      }
      return new Set()
    }
  }

  async setEnabled(tenantId: string, sessionId: string, tools: Set<string>): Promise<void> {
    const filePath = this.fileFor(tenantId, sessionId)
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const data = JSON.stringify(
        {
          tenantId,
          sessionId,
          tools: Array.from(tools),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )
      fs.writeFileSync(filePath, data, "utf-8")
      mcpDebug(`[ToolSessionStore] Persisted ${tools.size} enabled tools for ${tenantId}/${sessionId}`)
    } catch (e: any) {
      mcpDebug(`[ToolSessionStore] Failed to persist enabled tools: ${e.message}`)
    }
  }

  async clear(tenantId: string, sessionId: string): Promise<void> {
    const filePath = this.fileFor(tenantId, sessionId)
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
        mcpDebug(`[ToolSessionStore] Cleared ${tenantId}/${sessionId}`)
      }
    } catch (e: any) {
      mcpDebug(`[ToolSessionStore] Failed to clear session: ${e.message}`)
    }
  }
}

/**
 * In-memory store used by the HTTP transport.
 *
 * Backed by `TenantScopedCache<Set<string>>` so that two tenants who
 * happen to use the same session ID can never see each other's enabled tools.
 * State is lost on process restart — which is correct: a restart implies
 * fresh server state, and the next request chain will re-enable tools.
 */
export class MemoryToolSessionStore implements ToolSessionStore {
  private readonly cache = new TenantScopedCache<Set<string>>()

  async getEnabled(tenantId: string, sessionId: string): Promise<Set<string>> {
    return this.cache.get(tenantId, sessionId) ?? new Set()
  }

  async setEnabled(tenantId: string, sessionId: string, tools: Set<string>): Promise<void> {
    // Store a copy so external mutation of the passed set doesn't affect cache state.
    this.cache.set(tenantId, sessionId, new Set(tools))
  }

  async clear(tenantId: string, sessionId: string): Promise<void> {
    this.cache.delete(tenantId, sessionId)
  }
}
