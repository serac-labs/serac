/**
 * Instance-map post-hook unit tests.
 * Tests the pure payload-shaping logic; the network call is not exercised here.
 */

import { describe, test, expect } from "@jest/globals"
import { buildPayload, isWriteTool, pickHookTransport, SKIP_ACTIONS } from "../instance-map-hook"
import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../types"

const baseContext: ServiceNowContext = {
  instanceUrl: "https://dev12345.service-now.com",
  clientId: "client",
  clientSecret: "secret",
}

const writeDef: MCPToolDefinition = {
  name: "snow_artifact_manage",
  description: "",
  permission: "write",
  inputSchema: { type: "object", properties: {} },
}

const readDef: MCPToolDefinition = {
  name: "snow_query_table",
  description: "",
  permission: "read",
  inputSchema: { type: "object", properties: {} },
}

describe("instance-map-hook", () => {
  describe("isWriteTool", () => {
    test("returns true for permission=write", () => {
      expect(isWriteTool(writeDef)).toBe(true)
    })

    test("returns true for permission=admin", () => {
      expect(isWriteTool({ ...writeDef, permission: "admin" })).toBe(true)
    })

    test("returns false for permission=read", () => {
      expect(isWriteTool(readDef)).toBe(false)
    })

    test("treats missing permission as write (most restrictive default)", () => {
      expect(isWriteTool({ ...writeDef, permission: undefined })).toBe(true)
    })

    test("returns false for undefined definition", () => {
      expect(isWriteTool(undefined)).toBe(false)
    })
  })

  describe("buildPayload", () => {
    const successfulCreate: ToolResult = {
      success: true,
      data: { action: "create", created: true, sys_id: "abc", name: "MyRule", type: "business_rule" },
      artifact: {
        sys_id: "abc",
        name: "MyRule",
        url: "https://dev12345.service-now.com/nav_to.do?uri=sys_script.do?sys_id=abc",
        table: "incident",
      },
    }

    test("returns null when result is not successful", () => {
      const failed: ToolResult = { ...successfulCreate, success: false, error: "boom" }
      expect(buildPayload("snow_artifact_manage", { action: "create", type: "business_rule" }, failed, baseContext)).toBeNull()
    })

    test("returns null when no artifact sys_id is present", () => {
      const noArtifact: ToolResult = { success: true, data: { action: "create" } }
      expect(buildPayload("snow_artifact_manage", { action: "create" }, noArtifact, baseContext)).toBeNull()
    })

    test("propagates a delete action so the portal can remove the node", () => {
      const deleted: ToolResult = {
        success: true,
        data: { action: "delete", deleted: true, sys_id: "abc" },
        artifact: { sys_id: "abc" },
      }
      const payload = buildPayload("snow_artifact_manage", { action: "delete", type: "business_rule" }, deleted, baseContext)
      expect(payload?.action).toBe("delete")
      expect(payload?.artifact.sysId).toBe("abc")
      expect(payload?.artifact.type).toBe("business_rule")
    })

    test("infers delete action from data.deleted when args.action is absent", () => {
      const deleted: ToolResult = {
        success: true,
        data: { deleted: true, sys_id: "abc" },
        artifact: { sys_id: "abc", type: "widget" },
      }
      const payload = buildPayload("some_delete_tool", {}, deleted, baseContext)
      expect(payload?.action).toBe("delete")
    })

    test("prefers args.type over artifact.type for the canonical kind", () => {
      const result: ToolResult = {
        success: true,
        data: { sys_id: "abc" },
        artifact: { sys_id: "abc", type: "sys_script" },
      }
      const payload = buildPayload("snow_artifact_manage", { action: "create", type: "business_rule" }, result, baseContext)
      expect(payload?.artifact.type).toBe("business_rule")
    })

    test("falls back to artifact.type when args.type is absent", () => {
      const result: ToolResult = {
        success: true,
        data: { sys_id: "abc" },
        artifact: { sys_id: "abc", type: "widget" },
      }
      const payload = buildPayload("some_tool", {}, result, baseContext)
      expect(payload?.artifact.type).toBe("widget")
    })

    test("propagates instanceUrl, toolName and action", () => {
      const payload = buildPayload(
        "snow_artifact_manage",
        { action: "create", type: "business_rule" },
        successfulCreate,
        baseContext,
      )
      expect(payload?.instanceUrl).toBe("https://dev12345.service-now.com")
      expect(payload?.toolName).toBe("snow_artifact_manage")
      expect(payload?.action).toBe("create")
    })

    test("extracts updateSet id from metadata when present", () => {
      const withUpdateSet: ToolResult = {
        ...successfulCreate,
        metadata: { updateSetId: "us_sysid_xyz" },
      }
      const payload = buildPayload(
        "snow_artifact_manage",
        { action: "create", type: "business_rule" },
        withUpdateSet,
        baseContext,
      )
      expect(payload?.updateSet?.sysId).toBe("us_sysid_xyz")
    })

    test("returns null when instanceUrl is missing from context", () => {
      const payload = buildPayload(
        "snow_artifact_manage",
        { action: "create", type: "business_rule" },
        successfulCreate,
        { ...baseContext, instanceUrl: "" },
      )
      expect(payload).toBeNull()
    })
  })

  describe("pickHookTransport", () => {
    const fullInternalEnv = {
      MCP_INTERNAL_TOKEN: "secret-tok",
      PORTAL_BACKEND_URL: "http://portal:3000",
    } as NodeJS.ProcessEnv

    test("prefers internal transport when token, portal URL, and organizationId are set", () => {
      const t = pickHookTransport({ organizationId: 42 }, fullInternalEnv)
      expect(t.kind).toBe("internal")
      if (t.kind === "internal") {
        expect(t.tenantType).toBe("organization")
        expect(t.tenantId).toBe(42)
        expect(t.url).toBe("http://portal:3000")
        expect(t.token).toBe("secret-tok")
      }
    })

    test("uses customerId when only customerId is present", () => {
      const t = pickHookTransport({ customerId: 7 }, fullInternalEnv)
      expect(t.kind).toBe("internal")
      if (t.kind === "internal") {
        expect(t.tenantType).toBe("customer")
        expect(t.tenantId).toBe(7)
      }
    })

    test("prefers organizationId over customerId when both are present", () => {
      const t = pickHookTransport({ customerId: 7, organizationId: 42 }, fullInternalEnv)
      expect(t.kind).toBe("internal")
      if (t.kind === "internal") {
        expect(t.tenantType).toBe("organization")
        expect(t.tenantId).toBe(42)
      }
    })

    test("skips internal when MCP_INTERNAL_TOKEN is missing, falls back to bearer-or-none", () => {
      const t = pickHookTransport({ organizationId: 42 }, { PORTAL_BACKEND_URL: "http://portal:3000" })
      expect(["bearer", "none"]).toContain(t.kind)
    })

    test("skips internal when PORTAL_BACKEND_URL is missing", () => {
      const t = pickHookTransport({ organizationId: 42 }, { MCP_INTERNAL_TOKEN: "secret-tok" })
      expect(["bearer", "none"]).toContain(t.kind)
    })

    test("skips internal when tenant hint has no ids", () => {
      const t = pickHookTransport({}, fullInternalEnv)
      expect(["bearer", "none"]).toContain(t.kind)
    })

    test("skips internal when tenant is undefined", () => {
      const t = pickHookTransport(undefined, fullInternalEnv)
      expect(["bearer", "none"]).toContain(t.kind)
    })

    test("rejects non-positive tenant ids", () => {
      const t = pickHookTransport({ organizationId: 0, customerId: -3 }, fullInternalEnv)
      expect(["bearer", "none"]).toContain(t.kind)
    })
  })

  describe("SKIP_ACTIONS", () => {
    test("skips the expected read-only actions", () => {
      for (const a of ["get", "find", "list", "analyze", "export", "verify"]) {
        expect(SKIP_ACTIONS.has(a)).toBe(true)
      }
    })

    test("does not skip create / update / import / delete", () => {
      for (const a of ["create", "update", "import", "delete"]) {
        expect(SKIP_ACTIONS.has(a)).toBe(false)
      }
    })
  })
})
