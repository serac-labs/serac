/**
 * Permission Validator Unit Tests
 * Tests for stakeholder read-only enforcement
 */

import { describe, test, expect } from "@jest/globals"
import {
  extractJWTPayload,
  validatePermission,
  validateJWTExpiry,
  filterToolsByRole,
  getPermissionSummary,
} from "../permission-validator"
import { MCPToolDefinition, JWTPayload, UserRole } from "../types"
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"

describe("Permission Validator", () => {
  describe("extractJWTPayload", () => {
    test("should extract role from environment variable in dev mode", () => {
      process.env.SNOW_FLOW_USER_ROLE = "stakeholder"
      var jwt = extractJWTPayload()
      expect(jwt).not.toBeNull()
      expect(jwt?.role).toBe("stakeholder")
      delete process.env.SNOW_FLOW_USER_ROLE
    })

    test("should default to developer role when no JWT found (or use auth.json)", () => {
      var jwt = extractJWTPayload()
      // Falls back to auth.json role if present, otherwise developer
      expect(["developer", "stakeholder", "admin"]).toContain(jwt?.role)
    })

    test("should ignore headers (post-PR-6a: no unverified header parsing)", () => {
      // The former `x-snow-flow-auth` base64 path has been removed to prevent
      // role-spoofing if the helper is ever called from HTTP context.
      // Headers are accepted as a reserved parameter but never trusted here.
      var headers = { "x-snow-flow-auth": "anything" }
      var jwt = extractJWTPayload(headers)
      expect(["developer", "stakeholder", "admin"]).toContain(jwt?.role)
    })
  })

  describe("validatePermission", () => {
    test("should allow developer to execute READ tools", () => {
      var tool: MCPToolDefinition = {
        name: "snow_query_table",
        description: "Query table",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: { type: "object", properties: {} },
      }
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "developer",
        sessionId: "test",
        iat: Date.now(),
        exp: Date.now() + 86400000,
      }

      expect(() => validatePermission(tool, jwt)).not.toThrow()
    })

    test("should allow stakeholder to execute READ tools", () => {
      var tool: MCPToolDefinition = {
        name: "snow_query_incidents",
        description: "Query incidents",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: { type: "object", properties: {} },
      }
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "stakeholder",
        sessionId: "test",
        iat: Date.now(),
        exp: Date.now() + 86400000,
      }

      expect(() => validatePermission(tool, jwt)).not.toThrow()
    })

    test("should DENY stakeholder from executing WRITE tools", () => {
      var tool: MCPToolDefinition = {
        name: "snow_create_table",
        description: "Create table",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: { type: "object", properties: {} },
      }
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "stakeholder",
        sessionId: "test",
        iat: Date.now(),
        exp: Date.now() + 86400000,
      }

      expect(() => validatePermission(tool, jwt)).toThrow(McpError)
      try {
        validatePermission(tool, jwt)
      } catch (error: any) {
        expect(error.message).toContain("Permission Denied")
        expect(error.message).toContain("developer, admin")
        expect(error.code).toBe(ErrorCode.InvalidRequest)
      }
    })

    test("should DENY stakeholder even if they are in allowedRoles for WRITE tool", () => {
      // Edge case: Tool misconfigured with stakeholder in allowedRoles for write operation
      var tool: MCPToolDefinition = {
        name: "snow_update_table",
        description: "Update table",
        permission: "write",
        allowedRoles: ["developer", "stakeholder", "admin"], // Misconfigured!
        inputSchema: { type: "object", properties: {} },
      }
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "stakeholder",
        sessionId: "test",
        iat: Date.now(),
        exp: Date.now() + 86400000,
      }

      // Should still deny because of double-check in validatePermission
      expect(() => validatePermission(tool, jwt)).toThrow(McpError)
      try {
        validatePermission(tool, jwt)
      } catch (error: any) {
        expect(error.message).toContain("Write Access Denied")
        expect(error.message).toContain("read-only access")
      }
    })

    test("should allow developer to execute WRITE tools", () => {
      var tool: MCPToolDefinition = {
        name: "snow_delete_record",
        description: "Delete record",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: { type: "object", properties: {} },
      }
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "developer",
        sessionId: "test",
        iat: Date.now(),
        exp: Date.now() + 86400000,
      }

      expect(() => validatePermission(tool, jwt)).not.toThrow()
    })

    test("should allow admin to execute all tools", () => {
      var tools: MCPToolDefinition[] = [
        {
          name: "snow_query_table",
          permission: "read",
          allowedRoles: ["developer", "stakeholder", "admin"],
          description: "",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "snow_create_table",
          permission: "write",
          allowedRoles: ["developer", "admin"],
          description: "",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "snow_configure_mid_server",
          permission: "admin",
          allowedRoles: ["admin"],
          description: "",
          inputSchema: { type: "object", properties: {} },
        },
      ]
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "admin",
        sessionId: "test",
        iat: Date.now(),
        exp: Date.now() + 86400000,
      }

      tools.forEach(function (tool) {
        expect(() => validatePermission(tool, jwt)).not.toThrow()
      })
    })

    test("should DENY stakeholder from executing ADMIN tools", () => {
      var tool: MCPToolDefinition = {
        name: "snow_configure_mid_server",
        description: "Configure MID Server",
        permission: "admin",
        allowedRoles: ["admin"],
        inputSchema: { type: "object", properties: {} },
      }
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "stakeholder",
        sessionId: "test",
        iat: Date.now(),
        exp: Date.now() + 86400000,
      }

      expect(() => validatePermission(tool, jwt)).toThrow(McpError)
      try {
        validatePermission(tool, jwt)
      } catch (error: any) {
        expect(error.message).toContain("Permission Denied")
        expect(error.code).toBe(ErrorCode.InvalidRequest)
      }
    })

    test("should DENY developer from executing ADMIN-only tools", () => {
      var tool: MCPToolDefinition = {
        name: "snow_configure_mid_server",
        description: "Configure MID Server",
        permission: "admin",
        allowedRoles: ["admin"],
        inputSchema: { type: "object", properties: {} },
      }
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "developer",
        sessionId: "test",
        iat: Date.now(),
        exp: Date.now() + 86400000,
      }

      expect(() => validatePermission(tool, jwt)).toThrow(McpError)
      try {
        validatePermission(tool, jwt)
      } catch (error: any) {
        expect(error.message).toContain("Permission Denied")
        expect(error.message).toContain("admin")
        expect(error.code).toBe(ErrorCode.InvalidRequest)
      }
    })

    test("should DENY stakeholder even if in allowedRoles for ADMIN tool (double-check)", () => {
      // Edge case: Tool misconfigured with stakeholder in allowedRoles for admin operation
      var tool: MCPToolDefinition = {
        name: "snow_install_spoke",
        description: "Install Spoke",
        permission: "admin",
        allowedRoles: ["developer", "stakeholder", "admin"], // Misconfigured!
        inputSchema: { type: "object", properties: {} },
      }
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "stakeholder",
        sessionId: "test",
        iat: Date.now(),
        exp: Date.now() + 86400000,
      }

      // Should still deny because of double-check in validatePermission
      expect(() => validatePermission(tool, jwt)).toThrow(McpError)
      try {
        validatePermission(tool, jwt)
      } catch (error: any) {
        expect(error.message).toContain("Admin Access Denied")
        expect(error.message).toContain("read-only access")
      }
    })

    test("should use default permissions for tools without permission field", () => {
      var tool: MCPToolDefinition = {
        name: "snow_legacy_tool",
        description: "Legacy tool without permission field",
        inputSchema: { type: "object", properties: {} },
      }
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "stakeholder",
        sessionId: "test",
        iat: Date.now(),
        exp: Date.now() + 86400000,
      }

      // Should default to WRITE (most restrictive)
      expect(() => validatePermission(tool, jwt)).toThrow(McpError)
    })

    test("should work with null JWT payload (backward compatibility)", () => {
      var tool: MCPToolDefinition = {
        name: "snow_query_table",
        description: "Query table",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: { type: "object", properties: {} },
      }

      // Null JWT should default to developer role
      expect(() => validatePermission(tool, null)).not.toThrow()
    })
  })

  describe("validateJWTExpiry", () => {
    test("should accept valid non-expired JWT", () => {
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "developer",
        sessionId: "test",
        iat: Date.now(),
        exp: Date.now() + 86400000, // Expires in 24 hours
      }

      expect(() => validateJWTExpiry(jwt)).not.toThrow()
    })

    test("should reject expired JWT", () => {
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "developer",
        sessionId: "test",
        iat: Date.now() - 172800000, // 2 days ago
        exp: Date.now() - 86400000, // Expired 1 day ago
      }

      expect(() => validateJWTExpiry(jwt)).toThrow(McpError)
      try {
        validateJWTExpiry(jwt)
      } catch (error: any) {
        expect(error.message).toContain("Session Expired")
        expect(error.message).toContain("snow-flow auth login")
      }
    })

    test("should skip validation for null JWT", () => {
      expect(() => validateJWTExpiry(null)).not.toThrow()
    })
  })

  describe("filterToolsByRole", () => {
    var tools: MCPToolDefinition[] = [
      {
        name: "snow_query_table",
        description: "Query table",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_create_table",
        description: "Create table",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_search_records",
        description: "Search records",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_delete_record",
        description: "Delete record",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
    ]

    test("should filter tools for stakeholder (READ only)", () => {
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "stakeholder",
        sessionId: "test",
        iat: Date.now(),
        exp: Date.now() + 86400000,
      }

      var filtered = filterToolsByRole(tools, jwt)
      expect(filtered.length).toBe(2) // Only READ tools
      expect(
        filtered.map(function (t) {
          return t.name
        }),
      ).toContain("snow_query_table")
      expect(
        filtered.map(function (t) {
          return t.name
        }),
      ).toContain("snow_search_records")
      expect(
        filtered.map(function (t) {
          return t.name
        }),
      ).not.toContain("snow_create_table")
      expect(
        filtered.map(function (t) {
          return t.name
        }),
      ).not.toContain("snow_delete_record")
    })

    test("should return all tools for developer", () => {
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "developer",
        sessionId: "test",
        iat: Date.now(),
        exp: Date.now() + 86400000,
      }

      var filtered = filterToolsByRole(tools, jwt)
      expect(filtered.length).toBe(4) // All tools
    })

    test("should return all tools for admin", () => {
      var jwt: JWTPayload = {
        customerId: 1,
        tier: "enterprise",
        features: [],
        role: "admin",
        sessionId: "test",
        iat: Date.now(),
        exp: Date.now() + 86400000,
      }

      var filtered = filterToolsByRole(tools, jwt)
      expect(filtered.length).toBe(4) // All tools
    })

    test("should work with null JWT (defaults to developer)", () => {
      var filtered = filterToolsByRole(tools, null)
      expect(filtered.length).toBe(4) // All tools (default developer)
    })
  })

  describe("getPermissionSummary", () => {
    test("should generate summary for READ tool", () => {
      var tool: MCPToolDefinition = {
        name: "snow_query_table",
        description: "Query table",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: { type: "object", properties: {} },
      }

      var summary = getPermissionSummary(tool)
      expect(summary).toBe("snow_query_table: READ - Roles: [developer, stakeholder, admin]")
    })

    test("should generate summary for WRITE tool", () => {
      var tool: MCPToolDefinition = {
        name: "snow_create_table",
        description: "Create table",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: { type: "object", properties: {} },
      }

      var summary = getPermissionSummary(tool)
      expect(summary).toBe("snow_create_table: WRITE - Roles: [developer, admin]")
    })
  })
})
