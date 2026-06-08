/**
 * Stakeholder Write Protection Tests (v2.0.0)
 * Tests end-to-end write protection for stakeholder role across MCP tools
 */

import { describe, test, expect, beforeEach } from "@jest/globals"
import { validatePermission, filterToolsByRole } from "../permission-validator"
import { MCPToolDefinition, JWTPayload, UserRole } from "../types"
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"

describe("Stakeholder Write Protection - End-to-End", () => {
  var stakeholderJWT: JWTPayload
  var developerJWT: JWTPayload
  var adminJWT: JWTPayload

  beforeEach(() => {
    stakeholderJWT = {
      customerId: 1,
      tier: "enterprise",
      features: [],
      role: "stakeholder",
      sessionId: "test-session-stakeholder",
      iat: Date.now(),
      exp: Date.now() + 86400000,
    }

    developerJWT = {
      customerId: 1,
      tier: "enterprise",
      features: [],
      role: "developer",
      sessionId: "test-session-developer",
      iat: Date.now(),
      exp: Date.now() + 86400000,
    }

    adminJWT = {
      customerId: 1,
      tier: "enterprise",
      features: [],
      role: "admin",
      sessionId: "test-session-admin",
      iat: Date.now(),
      exp: Date.now() + 86400000,
    }
  })

  describe("READ Operations - Stakeholder Allowed", () => {
    var readTools: MCPToolDefinition[] = [
      {
        name: "snow_query_table",
        description: "Query any ServiceNow table",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_query_incidents",
        description: "Query incidents with filters",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_cmdb_search",
        description: "Search CMDB for configuration items",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_user_lookup",
        description: "Look up user information",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_knowledge_search",
        description: "Search knowledge base articles",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
    ]

    test("should allow stakeholder to execute all READ tools", () => {
      for (var i = 0; i < readTools.length; i++) {
        expect(() => validatePermission(readTools[i], stakeholderJWT)).not.toThrow()
      }
    })

    test("should include READ tools in stakeholder tool list", () => {
      var filtered = filterToolsByRole(readTools, stakeholderJWT)
      expect(filtered.length).toBe(readTools.length)

      var names = filtered.map(function (t) {
        return t.name
      })
      expect(names).toContain("snow_query_table")
      expect(names).toContain("snow_query_incidents")
      expect(names).toContain("snow_cmdb_search")
    })
  })

  describe("WRITE Operations - Stakeholder Denied", () => {
    var writeTools: MCPToolDefinition[] = [
      {
        name: "snow_create_artifact",
        description: "Create ServiceNow artifacts",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_update",
        description: "Update existing artifacts",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_execute_background_script",
        description: "Execute background scripts",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_create_ui_page",
        description: "Create UI pages",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_create_business_rule",
        description: "Create business rules",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_update_set_manage",
        description: "Manage update sets",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
    ]

    test("should DENY stakeholder from executing all WRITE tools", () => {
      for (var i = 0; i < writeTools.length; i++) {
        expect(() => validatePermission(writeTools[i], stakeholderJWT)).toThrow(McpError)
      }
    })

    test("should throw McpError with correct error code for WRITE tools", () => {
      for (var i = 0; i < writeTools.length; i++) {
        expect(() => {
          validatePermission(writeTools[i], stakeholderJWT)
        }).toThrow(McpError)

        try {
          validatePermission(writeTools[i], stakeholderJWT)
        } catch (error: any) {
          expect(error).toBeInstanceOf(McpError)
          expect(error.code).toBe(ErrorCode.InvalidRequest)
          expect(error.message).toContain("Permission Denied")
        }
      }
    })

    test("should provide clear error messages for stakeholder WRITE attempts", () => {
      for (var i = 0; i < writeTools.length; i++) {
        try {
          validatePermission(writeTools[i], stakeholderJWT)
        } catch (error: any) {
          expect(error.message).toContain(writeTools[i].name)
          expect(error.message).toContain("developer, admin")
          expect(error.message).toContain("stakeholder")
        }
      }
    })

    test("should exclude WRITE tools from stakeholder tool list", () => {
      var filtered = filterToolsByRole(writeTools, stakeholderJWT)
      expect(filtered.length).toBe(0) // No write tools should be included
    })

    test("should allow developer to execute all WRITE tools", () => {
      for (var i = 0; i < writeTools.length; i++) {
        expect(() => validatePermission(writeTools[i], developerJWT)).not.toThrow()
      }
    })

    test("should allow admin to execute all WRITE tools", () => {
      for (var i = 0; i < writeTools.length; i++) {
        expect(() => validatePermission(writeTools[i], adminJWT)).not.toThrow()
      }
    })
  })

  describe("Mixed Tool List Filtering", () => {
    var mixedTools: MCPToolDefinition[] = [
      {
        name: "snow_query_table",
        description: "Query table",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_create_artifact",
        description: "Create artifacts",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_cmdb_search",
        description: "Search CMDB",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_create_business_rule",
        description: "Create business rule",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "snow_knowledge_search",
        description: "Search knowledge",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: { type: "object", properties: {} },
      },
    ]

    test("should filter mixed tools correctly for stakeholder", () => {
      var filtered = filterToolsByRole(mixedTools, stakeholderJWT)

      // Should only have READ tools (3 out of 5)
      expect(filtered.length).toBe(3)

      var names = filtered.map(function (t) {
        return t.name
      })
      expect(names).toContain("snow_query_table")
      expect(names).toContain("snow_cmdb_search")
      expect(names).toContain("snow_knowledge_search")
      expect(names).not.toContain("snow_create_artifact")
      expect(names).not.toContain("snow_create_business_rule")
    })

    test("should return all tools for developer", () => {
      var filtered = filterToolsByRole(mixedTools, developerJWT)
      expect(filtered.length).toBe(mixedTools.length)
    })

    test("should return all tools for admin", () => {
      var filtered = filterToolsByRole(mixedTools, adminJWT)
      expect(filtered.length).toBe(mixedTools.length)
    })
  })

  describe("Edge Cases - Misconfigured Tools", () => {
    test("should DENY stakeholder even if tool has stakeholder in allowedRoles for WRITE", () => {
      // Misconfigured tool: WRITE permission but includes stakeholder in allowedRoles
      var misconfiguredTool: MCPToolDefinition = {
        name: "snow_update_record",
        description: "Update record",
        permission: "write",
        allowedRoles: ["developer", "stakeholder", "admin"], // WRONG!
        inputSchema: { type: "object", properties: {} },
      }

      // Should still be denied (double-check in validatePermission)
      expect(() => validatePermission(misconfiguredTool, stakeholderJWT)).toThrow(McpError)

      try {
        validatePermission(misconfiguredTool, stakeholderJWT)
      } catch (error: any) {
        expect(error.message).toContain("Write Access Denied")
        expect(error.message).toContain("read-only access")
      }
    })

    test("should default to WRITE (deny) for tools without permission field", () => {
      var toolWithoutPermission: MCPToolDefinition = {
        name: "snow_legacy_tool",
        description: "Legacy tool without permission field",
        inputSchema: { type: "object", properties: {} },
      }

      // Should default to WRITE and deny stakeholder
      expect(() => validatePermission(toolWithoutPermission, stakeholderJWT)).toThrow(McpError)
    })

    test("should allow tools without permission field for developer", () => {
      var toolWithoutPermission: MCPToolDefinition = {
        name: "snow_legacy_tool",
        description: "Legacy tool",
        inputSchema: { type: "object", properties: {} },
      }

      // Developer should be allowed (defaults to WRITE)
      expect(() => validatePermission(toolWithoutPermission, developerJWT)).not.toThrow()
    })
  })

  describe("Category-Based Protection", () => {
    test("should protect all deployment tools from stakeholder", () => {
      var deploymentTools: MCPToolDefinition[] = [
        {
          name: "snow_create_artifact",
          description: "Create artifacts",
          permission: "write",
          allowedRoles: ["developer", "admin"],
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "snow_validate_deployment",
          description: "Validate deployment",
          permission: "write",
          allowedRoles: ["developer", "admin"],
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "snow_rollback_deployment",
          description: "Rollback deployment",
          permission: "write",
          allowedRoles: ["developer", "admin"],
          inputSchema: { type: "object", properties: {} },
        },
      ]

      for (var i = 0; i < deploymentTools.length; i++) {
        expect(() => validatePermission(deploymentTools[i], stakeholderJWT)).toThrow(McpError)
      }
    })

    test("should protect all script execution tools from stakeholder", () => {
      var scriptTools: MCPToolDefinition[] = [
        {
          name: "snow_execute_background_script",
          description: "Execute background script",
          permission: "write",
          allowedRoles: ["developer", "admin"],
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "snow_execute_script_with_output",
          description: "Execute script with output",
          permission: "write",
          allowedRoles: ["developer", "admin"],
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "snow_execute_script_sync",
          description: "Execute script synchronously",
          permission: "write",
          allowedRoles: ["developer", "admin"],
          inputSchema: { type: "object", properties: {} },
        },
      ]

      for (var i = 0; i < scriptTools.length; i++) {
        expect(() => validatePermission(scriptTools[i], stakeholderJWT)).toThrow(McpError)
      }
    })

    test("should protect all artifact creation tools from stakeholder", () => {
      var creationTools: MCPToolDefinition[] = [
        {
          name: "snow_create_ui_page",
          description: "Create UI page",
          permission: "write",
          allowedRoles: ["developer", "admin"],
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "snow_create_business_rule",
          description: "Create business rule",
          permission: "write",
          allowedRoles: ["developer", "admin"],
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "snow_create_client_script",
          description: "Create client script",
          permission: "write",
          allowedRoles: ["developer", "admin"],
          inputSchema: { type: "object", properties: {} },
        },
      ]

      for (var i = 0; i < creationTools.length; i++) {
        expect(() => validatePermission(creationTools[i], stakeholderJWT)).toThrow(McpError)
      }
    })

    test("should allow all query tools for stakeholder", () => {
      var queryTools: MCPToolDefinition[] = [
        {
          name: "snow_query_table",
          description: "Query table",
          permission: "read",
          allowedRoles: ["developer", "stakeholder", "admin"],
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "snow_query_incidents",
          description: "Query incidents",
          permission: "read",
          allowedRoles: ["developer", "stakeholder", "admin"],
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "snow_query_changes",
          description: "Query changes",
          permission: "read",
          allowedRoles: ["developer", "stakeholder", "admin"],
          inputSchema: { type: "object", properties: {} },
        },
      ]

      for (var i = 0; i < queryTools.length; i++) {
        expect(() => validatePermission(queryTools[i], stakeholderJWT)).not.toThrow()
      }
    })
  })

  describe("Multi-Role Scenarios", () => {
    test("should enforce different permissions for different roles on same tool", () => {
      var tool: MCPToolDefinition = {
        name: "snow_create_artifact",
        description: "Create artifacts",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: { type: "object", properties: {} },
      }

      // Stakeholder denied
      expect(() => validatePermission(tool, stakeholderJWT)).toThrow(McpError)

      // Developer allowed
      expect(() => validatePermission(tool, developerJWT)).not.toThrow()

      // Admin allowed
      expect(() => validatePermission(tool, adminJWT)).not.toThrow()
    })

    test("should maintain role isolation across multiple tool executions", () => {
      var tools: MCPToolDefinition[] = [
        {
          name: "snow_query_table",
          permission: "read",
          allowedRoles: ["developer", "stakeholder", "admin"],
          description: "",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "snow_create_artifact",
          permission: "write",
          allowedRoles: ["developer", "admin"],
          description: "",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "snow_cmdb_search",
          permission: "read",
          allowedRoles: ["developer", "stakeholder", "admin"],
          description: "",
          inputSchema: { type: "object", properties: {} },
        },
      ]

      var stakeholderResults = []
      for (var i = 0; i < tools.length; i++) {
        try {
          validatePermission(tools[i], stakeholderJWT)
          stakeholderResults.push({ name: tools[i].name, allowed: true })
        } catch (e) {
          stakeholderResults.push({ name: tools[i].name, allowed: false })
        }
      }

      // Stakeholder should succeed on READ, fail on WRITE
      expect(stakeholderResults[0].allowed).toBe(true) // snow_query_table (READ)
      expect(stakeholderResults[1].allowed).toBe(false) // snow_create_artifact (WRITE)
      expect(stakeholderResults[2].allowed).toBe(true) // snow_cmdb_search (READ)
    })
  })

  describe("Real-World Scenarios", () => {
    test("Scenario: Stakeholder viewing incidents (should work)", () => {
      var tool: MCPToolDefinition = {
        name: "snow_query_incidents",
        description: "Query incidents with filters",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: {
          type: "object",
          properties: {
            filters: { type: "object" },
            limit: { type: "number" },
          },
        },
      }

      expect(() => validatePermission(tool, stakeholderJWT)).not.toThrow()
    })

    test("Scenario: Stakeholder trying to create incident (should fail)", () => {
      var tool: MCPToolDefinition = {
        name: "snow_create_incident",
        description: "Create new incident",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: {
          type: "object",
          properties: {
            short_description: { type: "string" },
            description: { type: "string" },
          },
        },
      }

      expect(() => validatePermission(tool, stakeholderJWT)).toThrow(McpError)

      try {
        validatePermission(tool, stakeholderJWT)
      } catch (error: any) {
        expect(error.message).toContain("Permission Denied")
        expect(error.message).toContain("snow_create_incident")
      }
    })

    test("Scenario: Stakeholder searching knowledge base (should work)", () => {
      var tool: MCPToolDefinition = {
        name: "snow_knowledge_search",
        description: "Search knowledge articles",
        permission: "read",
        allowedRoles: ["developer", "stakeholder", "admin"],
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            category: { type: "string" },
          },
        },
      }

      expect(() => validatePermission(tool, stakeholderJWT)).not.toThrow()
    })

    test("Scenario: Stakeholder trying to create artifact (should fail)", () => {
      var tool: MCPToolDefinition = {
        name: "snow_create_artifact",
        description: "Create Service Portal widget",
        permission: "write",
        allowedRoles: ["developer", "admin"],
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string" },
            config: { type: "object" },
          },
        },
      }

      expect(() => validatePermission(tool, stakeholderJWT)).toThrow(McpError)

      try {
        validatePermission(tool, stakeholderJWT)
      } catch (error: any) {
        expect(error.message).toContain("Write Access Denied")
        expect(error.message).toContain("read-only")
      }
    })
  })
})
