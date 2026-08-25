/**
 * snow_create_workflow_activity and snow_start_workflow write workflow_version.
 * That column references wf_workflow_version. A name lookup that stops at
 * wf_workflow therefore posts a sys_id that is not a version, and the activity
 * / context is created against nothing.
 *
 * The client is a stand-in: getAuthenticatedClient is stubbed so execute()
 * runs without an instance, and the assertions are on the URLs and POST body.
 */

import { describe, expect, mock, test } from "bun:test"

const WORKFLOW_SYS_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const VERSION_SYS_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const HEX_VERSION_SYS_ID = "cccccccccccccccccccccccccccccccc"
const ACTIVITY_SYS_ID = "dddddddddddddddddddddddddddddddd"
const CONTEXT_SYS_ID = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
const RECORD_SYS_ID = "ffffffffffffffffffffffffffffffff"

type Call = { method: "get" | "post"; url: string; params?: unknown; body?: unknown }

let nextClient: {
  get: (url: string, config?: { params?: Record<string, string> }) => Promise<any>
  post: (url: string, body: unknown) => Promise<any>
  calls: Call[]
}

mock.module("../servicenow-mcp-unified/shared/auth.js", () => ({
  getAuthenticatedClient: async () => nextClient,
}))

const { execute: createActivity } = await import(
  "../servicenow-mcp-unified/tools/automation/snow_create_workflow_activity"
)
const { execute: startWorkflow } = await import("../servicenow-mcp-unified/tools/workflow/snow_start_workflow")

const context = {
  instanceUrl: "https://example.service-now.com",
  clientId: "id",
  clientSecret: "secret",
}

function fullUrl(call: Call): string {
  let assembled = call.url
  if (call.params && typeof call.params === "object") {
    const params = new URLSearchParams(call.params as Record<string, string>)
    const query = params.toString()
    if (query) assembled = `${call.url}?${query}`
  }
  try {
    return decodeURIComponent(assembled.replace(/\+/g, " "))
  } catch {
    return assembled
  }
}

function isWorkflowNameLookup(call: Call, name: string): boolean {
  const u = fullUrl(call)
  return (
    call.method === "get" &&
    u.includes("/wf_workflow") &&
    !u.includes("wf_workflow_version") &&
    u.includes(`name=${name}`)
  )
}

function isPublishedVersionLookup(call: Call, workflowId: string): boolean {
  const u = fullUrl(call)
  return (
    call.method === "get" &&
    u.includes("wf_workflow_version") &&
    u.includes(`workflow=${workflowId}`) &&
    u.includes("published=true")
  )
}

function makeClient(opts: { publishedVersion?: string | null } = {}) {
  const calls: Call[] = []
  const publishedVersion = opts.publishedVersion === undefined ? VERSION_SYS_ID : opts.publishedVersion
  const client = {
    calls,
    async get(url: string, config?: { params?: Record<string, string> }) {
      calls.push({ method: "get", url, params: config?.params })
      const u = fullUrl({ method: "get", url, params: config?.params })

      if (u.includes("wf_workflow_version")) {
        if (publishedVersion) {
          return { data: { result: [{ sys_id: publishedVersion, published: "true" }] } }
        }
        return { data: { result: [] } }
      }

      if (/\/wf_workflow\/[a-f0-9]{32}/.test(u) && !u.includes("sysparm_query")) {
        return {
          data: { result: { sys_id: WORKFLOW_SYS_ID, name: "Incident Approval", table: "incident", active: "true" } },
        }
      }

      if (u.includes("wf_workflow")) {
        return {
          data: {
            result: [{ sys_id: WORKFLOW_SYS_ID, name: "Incident Approval", table: "incident", active: "true" }],
          },
        }
      }

      if (u.includes(`/api/now/table/incident/${RECORD_SYS_ID}`)) {
        return { data: { result: { sys_id: RECORD_SYS_ID } } }
      }

      return { data: { result: [] } }
    },
    async post(url: string, body: unknown) {
      calls.push({ method: "post", url, body })
      if (url.includes("wf_activity")) {
        return { data: { result: { sys_id: ACTIVITY_SYS_ID, name: (body as { name?: string }).name } } }
      }
      if (url.includes("wf_context")) {
        return { data: { result: { sys_id: CONTEXT_SYS_ID } } }
      }
      return { data: { result: {} } }
    },
  }
  return client
}

describe("snow_create_workflow_activity workflow_version", () => {
  test("name lookup GETs the published version and POSTs that sys_id", async () => {
    const client = makeClient()
    nextClient = client

    const result = await createActivity(
      { name: "Manager approval", workflowName: "Incident Approval", activityType: "approval" },
      context,
    )

    expect(result.success).toBe(true)
    expect(client.calls.some((call) => isWorkflowNameLookup(call, "Incident Approval"))).toBe(true)
    expect(client.calls.some((call) => isPublishedVersionLookup(call, WORKFLOW_SYS_ID))).toBe(true)

    const post = client.calls.find((call) => call.method === "post" && call.url.includes("wf_activity"))
    expect(post).toBeDefined()
    expect((post!.body as { workflow_version: string }).workflow_version).toBe(VERSION_SYS_ID)
    expect((post!.body as { workflow_version: string }).workflow_version).not.toBe(WORKFLOW_SYS_ID)
  })

  test("missing published version errors instead of writing a dangling reference", async () => {
    const client = makeClient({ publishedVersion: null })
    nextClient = client

    const result = await createActivity(
      { name: "Manager approval", workflowName: "Incident Approval", activityType: "approval" },
      context,
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/published version/i)
    expect(client.calls.some((call) => call.method === "post")).toBe(false)
  })

  test("a 32-hex version sys_id skips the name lookup", async () => {
    const client = makeClient()
    nextClient = client

    const result = await createActivity(
      { name: "Manager approval", workflowName: HEX_VERSION_SYS_ID, activityType: "approval" },
      context,
    )

    expect(result.success).toBe(true)
    expect(client.calls.some((call) => isWorkflowNameLookup(call, HEX_VERSION_SYS_ID))).toBe(false)
    expect(client.calls.some((call) => call.method === "get" && fullUrl(call).includes("wf_workflow"))).toBe(false)

    const post = client.calls.find((call) => call.method === "post" && call.url.includes("wf_activity"))
    expect((post!.body as { workflow_version: string }).workflow_version).toBe(HEX_VERSION_SYS_ID)
  })
})

describe("snow_start_workflow workflow_version", () => {
  test("name lookup GETs the published version and POSTs that sys_id on wf_context", async () => {
    const client = makeClient()
    nextClient = client

    const result = await startWorkflow(
      { workflow_name: "Incident Approval", table: "incident", record_sys_id: RECORD_SYS_ID },
      context,
    )

    expect(result.success).toBe(true)
    expect(result.data?.started).toBe(true)
    expect(client.calls.some((call) => isWorkflowNameLookup(call, "Incident Approval"))).toBe(true)
    expect(client.calls.some((call) => isPublishedVersionLookup(call, WORKFLOW_SYS_ID))).toBe(true)

    const post = client.calls.find((call) => call.method === "post" && call.url.includes("wf_context"))
    expect(post).toBeDefined()
    expect((post!.body as { workflow_version: string }).workflow_version).toBe(VERSION_SYS_ID)
    expect((post!.body as { workflow_version: string }).workflow_version).not.toBe(WORKFLOW_SYS_ID)
  })

  test("missing published version errors instead of writing a dangling reference", async () => {
    const client = makeClient({ publishedVersion: null })
    nextClient = client

    const result = await startWorkflow(
      { workflow_name: "Incident Approval", table: "incident", record_sys_id: RECORD_SYS_ID },
      context,
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/published version/i)
    expect(client.calls.some((call) => call.method === "post" && call.url.includes("wf_context"))).toBe(false)
  })

  test("a 32-hex version sys_id skips the name lookup and is posted on wf_context", async () => {
    const client = makeClient()
    nextClient = client

    const result = await startWorkflow(
      { workflow_sys_id: HEX_VERSION_SYS_ID, table: "incident", record_sys_id: RECORD_SYS_ID },
      context,
    )

    expect(result.success).toBe(true)
    expect(client.calls.some((call) => isWorkflowNameLookup(call, HEX_VERSION_SYS_ID))).toBe(false)

    const post = client.calls.find((call) => call.method === "post" && call.url.includes("wf_context"))
    expect((post!.body as { workflow_version: string }).workflow_version).toBe(HEX_VERSION_SYS_ID)
  })
})
