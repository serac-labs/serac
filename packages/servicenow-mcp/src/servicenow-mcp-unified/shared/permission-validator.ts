/**
 * Permission Validation for Stakeholder Read-Only Enforcement
 *
 * Validates that users have permission to execute tools based on their role.
 *
 * Multi-tenant safety note (PR-6a):
 *   - `extractJWTPayload` reads process env vars and the stdio-local
 *     auth.json. It is SAFE TO CALL ONLY from stdio transport context.
 *     HTTP transport callers MUST populate `RequestContext.jwtPayload`
 *     via their own signed-JWT verifier (PR-6b) and NEVER call this helper.
 *   - The earlier module-level `cachedAuthRole` (60s TTL) has been removed
 *     because it could leak a role value across stdio sessions of different
 *     users (audit finding 1.3). Every call now reads `auth.json` fresh.
 */

import { type MCPToolDefinition, type JWTPayload, type UserRole, type ToolPermission } from "./types.js"
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { mcpDebug } from "../../shared/mcp-debug.js"

/**
 * STDIO-ONLY: Load user role from auth.json enterprise section.
 * Reads disk on every call (no memoization) because any role caching at
 * process scope is a cross-session leak in multi-tenant contexts.
 */
function loadRoleFromAuthJson(): UserRole | null {
  const authPaths = [
    path.join(os.homedir(), ".local", "share", "snow-code", "auth.json"),
    path.join(os.homedir(), ".serac", "auth.json"),
    path.join(os.homedir(), ".snow-flow", "auth.json"),
  ]

  for (const authPath of authPaths) {
    try {
      if (!fs.existsSync(authPath)) continue

      const authData = JSON.parse(fs.readFileSync(authPath, "utf-8"))

      // Check enterprise section for role
      if (authData.enterprise?.role) {
        const role = authData.enterprise.role
        if (["developer", "stakeholder", "admin"].includes(role)) {
          mcpDebug(`[Permission] 🔑 Loaded role '${role}' from ${authPath}`)
          return role as UserRole
        }
      }
    } catch (error) {
      // Ignore errors, try next path
    }
  }

  return null
}

/**
 * STDIO-ONLY: Extract a JWT payload from machine-local sources.
 * Priority: 1. `SERAC_USER_ROLE` (or legacy `SNOW_FLOW_USER_ROLE`) env var, 2. auth.json enterprise role,
 * 3. Default "developer".
 *
 * Never call this from an HTTP request handler — the env var and auth.json
 * are machine-wide state and would leak across tenants.
 *
 * The pre-PR-6a `x-snow-flow-auth` base64 header path was removed: it parsed
 * an unverified JSON payload and was a spoof vector if it ever reached the
 * HTTP code path. HTTP callers MUST populate `RequestContext.jwtPayload`
 * via a real signed-JWT verifier (PR-6b `shared/context-resolver.ts`).
 *
 * The `headers` parameter is retained as a reserved slot for a future
 * signed-token parser but is currently ignored.
 */
export function extractJWTPayload(_headers?: Record<string, string>): JWTPayload | null {
  // Priority 1: Check environment variable (explicit override)
  const devRole = (process.env.SERAC_USER_ROLE || process.env.SNOW_FLOW_USER_ROLE) as UserRole | undefined

  if (devRole && ["developer", "stakeholder", "admin"].includes(devRole)) {
    mcpDebug(`[Permission] Using role from env: ${devRole}`)
    return {
      customerId: 0,
      tier: "community",
      features: [],
      role: devRole,
      sessionId: "env-session",
      iat: Date.now(),
      exp: Date.now() + 86400000,
    }
  }

  // Priority 2: Load from auth.json (snow-code stored role)
  const authJsonRole = loadRoleFromAuthJson()
  if (authJsonRole) {
    return {
      customerId: 0,
      tier: "enterprise",
      features: [],
      role: authJsonRole,
      sessionId: "auth-json-session",
      iat: Date.now(),
      exp: Date.now() + 86400000,
    }
  }

  // Priority 3: Default to developer for backward compatibility
  mcpDebug("[Permission] No role found, defaulting to developer")
  return {
    customerId: 0,
    tier: "community",
    features: [],
    role: "developer",
    sessionId: "anonymous",
    iat: Date.now(),
    exp: Date.now() + 86400000,
  }
}

/**
 * Get default permission values for tools without classification
 * (Defaults to most restrictive: write-only for developers)
 */
function getDefaultPermission(tool: MCPToolDefinition): {
  permission: ToolPermission
  allowedRoles: UserRole[]
} {
  // If tool doesn't have permission fields, default to WRITE (most restrictive)
  return {
    permission: tool.permission || "write",
    allowedRoles: tool.allowedRoles || ["developer", "admin"],
  }
}

/**
 * Validate that user has permission to execute a tool
 *
 * @throws McpError if user doesn't have permission
 */
export function validatePermission(tool: MCPToolDefinition, jwtPayload: JWTPayload | null | undefined): void {
  // Extract user role
  const userRole = jwtPayload?.role || "developer" // Default to developer for backward compatibility

  // Get tool permission configuration
  const { permission, allowedRoles } = getDefaultPermission(tool)

  // Check 1: Role-based access control
  if (!allowedRoles.includes(userRole)) {
    const errorMessage =
      `🚫 Permission Denied: Tool '${tool.name}' requires one of these roles: ${allowedRoles.join(", ")}.\n` +
      `Your current role: ${userRole}.\n\n` +
      (userRole === "stakeholder"
        ? `💡 Stakeholders have read-only access. This tool requires ${permission} permissions.\n` +
          `   To execute write operations, please contact a developer or admin.`
        : `💡 Contact your administrator to upgrade your permissions.`)

    throw new McpError(ErrorCode.InvalidRequest, errorMessage)
  }

  // Check 2: Double-check for stakeholder write/admin protection
  // Even if stakeholder is in allowedRoles (shouldn't happen), never allow write or admin operations
  if (userRole === "stakeholder" && (permission === "write" || permission === "admin")) {
    const permissionType = permission === "admin" ? "admin" : "write"
    const errorMessage =
      `🚫 ${permissionType === "admin" ? "Admin" : "Write"} Access Denied: Tool '${tool.name}' requires ${permissionType} permissions.\n\n` +
      `💡 Stakeholders have read-only access to Serac tools.\n` +
      `   You can query data, view analytics, and generate reports,\n` +
      `   but cannot create, update, or delete records.\n\n` +
      `   If you need to modify data, please contact a developer or admin.`

    throw new McpError(ErrorCode.InvalidRequest, errorMessage)
  }

  // Permission granted!
  mcpDebug(`[Permission] ✅ User '${userRole}' authorized to execute '${tool.name}' (${permission})`)
}

/**
 * Filter tools based on user role (for ListTools handler)
 */
export function filterToolsByRole(tools: MCPToolDefinition[], jwtPayload: JWTPayload | null | undefined): MCPToolDefinition[] {
  const userRole = jwtPayload?.role || "developer"

  return tools.filter((tool) => {
    const { allowedRoles } = getDefaultPermission(tool)
    return allowedRoles.includes(userRole)
  })
}

/**
 * Get permission summary for a tool (for debugging/logging)
 */
export function getPermissionSummary(tool: MCPToolDefinition): string {
  const { permission, allowedRoles } = getDefaultPermission(tool)
  return `${tool.name}: ${permission.toUpperCase()} - Roles: [${allowedRoles.join(", ")}]`
}

/**
 * Validate JWT is not expired.
 *
 * `jwtPayload.exp` may arrive in either unit depending on the producer:
 *   - Standard `jsonwebtoken.sign({ expiresIn })` stores exp in **seconds** (JWT RFC).
 *   - `extractJWTPayload()` above synthesizes exp as `Date.now() + 86_400_000` (**ms**).
 * Anything above ~1e12 is ms (year 33658+ in seconds), anything below is seconds.
 * Normalize to ms before comparing so HTTP-signed tokens don't read as "always expired".
 */
export function validateJWTExpiry(jwtPayload: JWTPayload | null | undefined): void {
  if (!jwtPayload) return // Skip validation if no JWT
  if (!jwtPayload.exp) return

  const expMs = jwtPayload.exp < 1e12 ? jwtPayload.exp * 1000 : jwtPayload.exp
  if (expMs < Date.now()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "🚫 Session Expired: Your authentication token has expired. Please re-authenticate.\n\n" +
        "💡 Run: serac auth login",
    )
  }
}
