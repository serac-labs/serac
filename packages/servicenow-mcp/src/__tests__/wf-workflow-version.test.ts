/**
 * wf_activity.workflow_version and wf_context.workflow_version reference
 * wf_workflow_version. resolveWorkflowVersion is the decision both write tools
 * share: name → published version, 32-hex version id as-is, 32-hex workflow id
 * → published version, fail when none.
 *
 * The client is a stand-in so the decision can be tested without an instance
 * and without mock.module (bun test shares one process; a module stub leaks).
 * A real instance 404s GET wf_workflow_version/<workflow-id> and 404s
 * GET wf_workflow/<version-id>, so the stand-in must not answer the latter
 * as a workflow record.
 */

import { describe, expect, test } from "bun:test"
import { ErrorType, SnowFlowError } from "../servicenow-mcp-unified/shared/error-handler"
import { resolveWorkflowVersion } from "../servicenow-mcp-unified/shared/workflow-version"

const WORKFLOW_SYS_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const VERSION_SYS_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const OTHER_VERSION_SYS_ID = "cccccccccccccccccccccccccccccccc"

type Call = { url: string; params?: Record<string, string | number> }

function notFound(): never {
  throw Object.assign(new Error("Not Found"), { response: { status: 404 } })
}

function makeClient(
  opts: {
    versionsById?: Record<string, { sys_id: string; name?: string; workflow?: string }>
    publishedByWorkflow?: Record<string, { sys_id: string; name?: string; workflow?: string } | null>
    workflowsByName?: Record<string, { sys_id: string; name: string } | null>
  } = {},
) {
  const versionsById = opts.versionsById ?? {
    [VERSION_SYS_ID]: { sys_id: VERSION_SYS_ID, name: "Incident Approval", workflow: WORKFLOW_SYS_ID },
    [OTHER_VERSION_SYS_ID]: { sys_id: OTHER_VERSION_SYS_ID, name: "Incident Approval", workflow: WORKFLOW_SYS_ID },
  }
  const publishedByWorkflow =
    opts.publishedByWorkflow === undefined
      ? { [WORKFLOW_SYS_ID]: { sys_id: VERSION_SYS_ID, name: "Incident Approval", workflow: WORKFLOW_SYS_ID } }
      : opts.publishedByWorkflow
  const workflowsByName =
    opts.workflowsByName === undefined
      ? { "Incident Approval": { sys_id: WORKFLOW_SYS_ID, name: "Incident Approval" } }
      : opts.workflowsByName

  const calls: Call[] = []
  return {
    calls,
    async get(url: string, config?: { params?: Record<string, string | number> }) {
      calls.push({ url, params: config?.params })

      const versionId = url.match(/\/wf_workflow_version\/([a-f0-9]{32})$/)?.[1]
      if (versionId) {
        const row = versionsById[versionId]
        if (!row) notFound()
        return { data: { result: row } }
      }

      if (url.includes("wf_workflow_version")) {
        const query = String(config?.params?.sysparm_query ?? "")
        const workflowId = query.match(/workflow=([a-f0-9]{32})/)?.[1]
        const row = workflowId ? publishedByWorkflow[workflowId] : undefined
        return { data: { result: row ? [row] : [] } }
      }

      if (url.includes("/wf_workflow/") && !url.includes("sysparm_query")) {
        // A real instance 404s wf_workflow/<version-id>. Do not invent a record.
        notFound()
      }

      if (url.endsWith("/wf_workflow") || url.includes("/wf_workflow?")) {
        const query = String(config?.params?.sysparm_query ?? "")
        const name = query.startsWith("name=") ? query.slice("name=".length) : ""
        const row = name ? workflowsByName[name] : undefined
        return { data: { result: row ? [row] : [] } }
      }

      return { data: { result: [] } }
    },
  }
}

function isPublishedVersionLookup(call: Call, workflowId: string): boolean {
  return (
    call.url.includes("wf_workflow_version") &&
    !/\/wf_workflow_version\/[a-f0-9]{32}$/.test(call.url) &&
    String(call.params?.sysparm_query ?? "").includes(`workflow=${workflowId}`) &&
    String(call.params?.sysparm_query ?? "").includes("published=true")
  )
}

function isVersionById(call: Call, sysId: string): boolean {
  return call.url.endsWith(`/wf_workflow_version/${sysId}`)
}

function isWorkflowById(call: Call, sysId: string): boolean {
  return /\/wf_workflow\/[a-f0-9]{32}$/.test(call.url) && call.url.endsWith(sysId)
}

describe("resolveWorkflowVersion", () => {
  test("a name GETs the published version", async () => {
    const client = makeClient()
    const resolved = await resolveWorkflowVersion(client, "Incident Approval")

    expect(resolved.versionSysId).toBe(VERSION_SYS_ID)
    expect(resolved.versionSysId).not.toBe(WORKFLOW_SYS_ID)
    expect(resolved.workflowSysId).toBe(WORKFLOW_SYS_ID)
    expect(client.calls.some((call) => isPublishedVersionLookup(call, WORKFLOW_SYS_ID))).toBe(true)
    expect(
      client.calls.some((call) => String(call.params?.sysparm_query ?? "").includes("name=Incident Approval")),
    ).toBe(true)
  })

  test("a missing published version is NOT_FOUND and does not invent an id", async () => {
    const client = makeClient({ publishedByWorkflow: { [WORKFLOW_SYS_ID]: null } })

    let error: unknown
    try {
      await resolveWorkflowVersion(client, "Incident Approval")
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(SnowFlowError)
    expect((error as SnowFlowError).type).toBe(ErrorType.NOT_FOUND)
    expect((error as SnowFlowError).message).toMatch(/published version/i)
    expect(client.calls.some((call) => isPublishedVersionLookup(call, WORKFLOW_SYS_ID))).toBe(true)
  })

  test("a 32-hex version sys_id is used as-is after GET wf_workflow_version/<id>", async () => {
    const client = makeClient()
    const resolved = await resolveWorkflowVersion(client, OTHER_VERSION_SYS_ID)

    expect(resolved.versionSysId).toBe(OTHER_VERSION_SYS_ID)
    expect(client.calls.some((call) => isVersionById(call, OTHER_VERSION_SYS_ID))).toBe(true)
    expect(client.calls.some((call) => isPublishedVersionLookup(call, OTHER_VERSION_SYS_ID))).toBe(false)
    expect(client.calls.some((call) => isWorkflowById(call, OTHER_VERSION_SYS_ID))).toBe(false)
  })

  test("a 32-hex workflow sys_id 404s as a version and resolves the published version", async () => {
    const client = makeClient()
    const resolved = await resolveWorkflowVersion(client, WORKFLOW_SYS_ID)

    expect(resolved.versionSysId).toBe(VERSION_SYS_ID)
    expect(resolved.versionSysId).not.toBe(WORKFLOW_SYS_ID)
    expect(client.calls.some((call) => isVersionById(call, WORKFLOW_SYS_ID))).toBe(true)
    expect(client.calls.some((call) => isPublishedVersionLookup(call, WORKFLOW_SYS_ID))).toBe(true)
  })

  test("a 32-hex workflow sys_id with no published version is NOT_FOUND", async () => {
    const client = makeClient({ publishedByWorkflow: { [WORKFLOW_SYS_ID]: null } })

    let error: unknown
    try {
      await resolveWorkflowVersion(client, WORKFLOW_SYS_ID)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(SnowFlowError)
    expect((error as SnowFlowError).type).toBe(ErrorType.NOT_FOUND)
    expect((error as SnowFlowError).message).toMatch(/published version/i)
  })

  test("an unknown name is NOT_FOUND", async () => {
    const client = makeClient({ workflowsByName: {} })

    let error: unknown
    try {
      await resolveWorkflowVersion(client, "No Such Workflow")
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(SnowFlowError)
    expect((error as SnowFlowError).type).toBe(ErrorType.NOT_FOUND)
    expect((error as SnowFlowError).message).toMatch(/Workflow not found/)
  })
})
