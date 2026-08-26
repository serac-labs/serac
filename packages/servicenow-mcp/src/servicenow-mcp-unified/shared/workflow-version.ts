/**
 * wf_activity.workflow_version and wf_context.workflow_version reference
 * wf_workflow_version, not wf_workflow. Callers hand us a name, a workflow
 * sys_id, or a version sys_id — this is the one place that tells them apart.
 *
 * A 32-hex value is GET wf_workflow_version/<id> first. A real instance 404s
 * that URL for a workflow id (and 404s wf_workflow/<id> for a version id), so
 * a miss is "not a version", not "not a workflow". The published version of
 * that workflow is then resolved with workflow=<id>^published=true.
 */

import { ErrorType, SnowFlowError } from "./error-handler.js"

const SYS_ID = /^[a-f0-9]{32}$/

export type WorkflowTableClient = {
  get: (url: string, config?: { params?: Record<string, string | number> }) => Promise<{ data?: { result?: unknown } }>
}

export type ResolvedWorkflowVersion = {
  versionSysId: string
  workflowSysId?: string
  name?: string
}

export async function resolveWorkflowVersion(
  client: WorkflowTableClient,
  input: string,
): Promise<ResolvedWorkflowVersion> {
  if (SYS_ID.test(input)) {
    const version = await fetchById(client, "wf_workflow_version", input, "sys_id,name,workflow,published")
    if (version) return fromVersionRow(version)
    return fetchPublishedVersion(client, input, input)
  }

  const workflow = await fetchWorkflowByName(client, input)
  if (!workflow) {
    throw new SnowFlowError(ErrorType.NOT_FOUND, `Workflow not found: ${input}`, { retryable: false })
  }
  const resolved = await fetchPublishedVersion(client, workflow.sys_id, input)
  return { ...resolved, workflowSysId: workflow.sys_id, name: workflow.name ?? resolved.name }
}

function fromVersionRow(row: Record<string, unknown>): ResolvedWorkflowVersion {
  const versionSysId = asSysId(row.sys_id)
  if (!versionSysId) {
    throw new SnowFlowError(ErrorType.NOT_FOUND, "Workflow version record has no sys_id", { retryable: false })
  }
  return {
    versionSysId,
    workflowSysId: asRefSysId(row.workflow),
    name: asString(row.name),
  }
}

async function fetchPublishedVersion(
  client: WorkflowTableClient,
  workflowSysId: string,
  label: string,
): Promise<ResolvedWorkflowVersion> {
  const response = await client.get("/api/now/table/wf_workflow_version", {
    params: {
      sysparm_query: `workflow=${workflowSysId}^published=true`,
      sysparm_fields: "sys_id,name,workflow,published",
      sysparm_limit: 1,
    },
  })
  const row = firstRow(response.data?.result)
  const versionSysId = asSysId(row.sys_id)
  if (!versionSysId) {
    throw new SnowFlowError(ErrorType.NOT_FOUND, `No published version for workflow: ${label}`, { retryable: false })
  }
  return {
    versionSysId,
    workflowSysId: asRefSysId(row.workflow) ?? workflowSysId,
    name: asString(row.name),
  }
}

async function fetchWorkflowByName(client: WorkflowTableClient, name: string) {
  const response = await client.get("/api/now/table/wf_workflow", {
    params: {
      sysparm_query: `name=${name}`,
      sysparm_fields: "sys_id,name,table,active",
      sysparm_limit: 1,
    },
  })
  const row = firstRow(response.data?.result)
  const sys_id = asSysId(row.sys_id)
  if (!sys_id) return null
  return { sys_id, name: asString(row.name) }
}

async function fetchById(client: WorkflowTableClient, table: string, sysId: string, fields: string) {
  const response = await client
    .get(`/api/now/table/${table}/${sysId}`, { params: { sysparm_fields: fields } })
    .catch((error: unknown) => {
      if (statusOf(error) === 404) return null
      throw error
    })
  const row = asRecord(response?.data?.result)
  if (!asSysId(row.sys_id)) return null
  return row
}

function firstRow(result: unknown): Record<string, unknown> {
  if (Array.isArray(result)) return asRecord(result[0])
  return asRecord(result)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value
  return undefined
}

function asSysId(value: unknown): string | undefined {
  if (typeof value === "string" && SYS_ID.test(value)) return value
  return undefined
}

function asRefSysId(value: unknown): string | undefined {
  if (typeof value === "string") return asSysId(value)
  return asSysId(asRecord(value).value)
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const status = (error as { response?: { status?: unknown } }).response?.status
  if (typeof status === "number") return status
  return undefined
}
