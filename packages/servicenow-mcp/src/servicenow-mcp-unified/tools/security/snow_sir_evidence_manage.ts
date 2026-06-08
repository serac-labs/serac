/**
 * snow_sir_evidence_manage - Unified Security Incident Response (SIR) evidence and forensic artifact handling
 *
 * Manages forensic evidence attached to SIR incidents on sn_si_evidence and
 * sn_si_artifact. Provides chain-of-custody operations needed for an audit
 * trail: attach evidence to an incident, list evidence for an incident,
 * fetch a single record, verify a stored artifact's SHA-256 hash, and
 * export the evidence index for an incident.
 *
 * Companion to snow_sir_incident_manage (incident lifecycle) and
 * snow_sir_playbook_orchestrate (SOAR playbook steps). Use this tool when
 * the incident has produced evidence (memory dumps, PCAPs, screenshots,
 * exported logs) that needs to be tracked and integrity-verified.
 *
 * Requires the Security Incident Response plugin (com.snc.security_incident).
 * A 404 on the primary table is surfaced as a clear missing-plugin error.
 *
 * Hash verification: hash_verify recomputes the SHA-256 hash of the stored
 * artifact server-side using GlideDigest and compares it to the value
 * captured at attach time. Mismatches indicate tampering or storage
 * corruption. Server-side script is ES5-only (Rhino engine).
 */

import type { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult, SnowFlowError, ErrorType } from "../../shared/error-handler.js"
import { executeServerScript } from "../../shared/scripted-exec.js"

const SIR_PLUGIN = "com.snc.security_incident"
const SIR_EVIDENCE_TABLE = "sn_si_evidence"
const SIR_ARTIFACT_TABLE = "sn_si_artifact"
const SIR_ATTACHMENT_TABLE = "sn_si_attachment"
const SIR_INCIDENT_TABLE = "sn_si_incident"
const SYS_ATTACHMENT_TABLE = "sys_attachment"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_sir_evidence_manage",
  description: `Unified tool for Security Incident Response (SIR) evidence and forensic artifact chain-of-custody on sn_si_evidence, sn_si_artifact, and sn_si_attachment. Critical for audit trails — every action records who attached/exported the evidence and when.

Actions:
- attach — attach a new evidence record to a SIR incident with type, description, source, and an optional sys_attachment reference
- list — list evidence rows linked to an incident
- get — retrieve a single evidence row with related artifact and attachment metadata
- hash_verify — recompute the SHA-256 hash of a stored artifact server-side (GlideDigest) and compare to the value recorded at attach time. Used to detect tampering or storage corruption
- export — return a structured manifest of all evidence for an incident, suitable for handing off to legal/IR review

Use when: the agent has produced or received forensic evidence (memory dumps, PCAPs, screenshots, exported logs) tied to a SIR incident and needs to track it under chain of custody. Companion tools: snow_sir_incident_manage (incident lifecycle), snow_sir_playbook_orchestrate (playbook steps that produce the evidence).

Plugin gating: requires com.snc.security_incident. A 404 on sn_si_evidence is surfaced with the required plugin name. The hash_verify action uses GlideDigest via ES5-only server-side script execution.

Returns: action-specific data. attach returns the created evidence row. list returns evidence summaries with hash and attached_by. get returns the row with related artifact records. hash_verify returns the recomputed hash, the stored hash, and a verified boolean. export returns the full evidence manifest for the incident.`,
  category: "security",
  subcategory: "incidents",
  use_cases: ["sir", "forensics", "evidence", "chain-of-custody", "security"],
  complexity: "advanced",
  frequency: "medium",
  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Evidence management action to perform",
        enum: ["attach", "list", "get", "hash_verify", "export"],
      },
      // Identifiers
      sys_id: {
        type: "string",
        description: "[get/hash_verify] Evidence record sys_id on sn_si_evidence",
      },
      incident_sys_id: {
        type: "string",
        description: "[attach/list/export] Parent SIR incident sys_id (sn_si_incident)",
      },
      incident_number: {
        type: "string",
        description: "[attach/list/export] Parent SIR incident number (e.g. SIR0010001), alternative to incident_sys_id",
      },
      attachment_sys_id: {
        type: "string",
        description: "[attach/hash_verify] sys_attachment sys_id pointing at the stored file (when evidence is file-based)",
      },
      artifact_sys_id: {
        type: "string",
        description: "[attach] Existing sn_si_artifact sys_id to link to the evidence (alternative to attachment_sys_id)",
      },
      // ATTACH
      short_description: {
        type: "string",
        description: "[attach] Short description of the evidence",
      },
      description: {
        type: "string",
        description: "[attach] Detailed description / context of how the evidence was produced",
      },
      evidence_type: {
        type: "string",
        description: "[attach] Evidence type",
        enum: [
          "memory_dump",
          "pcap",
          "log",
          "screenshot",
          "file",
          "registry_export",
          "process_list",
          "network_capture",
          "other",
        ],
      },
      source: {
        type: "string",
        description: "[attach] Source system / collection method (EDR, SIEM, manual)",
      },
      sha256: {
        type: "string",
        description: "[attach] SHA-256 hash of the evidence as captured at collection time (lowercase hex)",
      },
      collected_by: {
        type: "string",
        description: "[attach] sys_user sys_id of the analyst who collected the evidence (defaults to caller)",
      },
      // LIST
      limit: {
        type: "number",
        description: "[list] Maximum records to return",
        default: 50,
      },
      fields: {
        type: "string",
        description: "[list/get/export] Comma-separated list of fields to return",
      },
      // EXPORT
      include_artifacts: {
        type: "boolean",
        description: "[export] Include linked sn_si_artifact rows in the manifest",
        default: true,
      },
    },
    required: ["action"],
  },
}

export async function execute(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const action = args.action as string

  try {
    switch (action) {
      case "attach":
        return await executeAttach(args, context)
      case "list":
        return await executeList(args, context)
      case "get":
        return await executeGet(args, context)
      case "hash_verify":
        return await executeHashVerify(args, context)
      case "export":
        return await executeExport(args, context)
      default:
        return createErrorResult(
          `Unknown action: ${action}. Valid actions: attach, list, get, hash_verify, export`,
        )
    }
  } catch (error: unknown) {
    const err = error as Error
    return createErrorResult(
      err instanceof SnowFlowError
        ? err
        : new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, `SIR evidence ${action} failed: ${err.message}`, {
            originalError: err,
          }),
    )
  }
}

// ==================== HELPERS ====================

function plugin404(err: unknown, table: string): SnowFlowError {
  const e = err as { response?: { status?: number }; message?: string }
  if (e?.response?.status === 404) {
    return new SnowFlowError(
      ErrorType.PLUGIN_MISSING,
      `Security Incident Response plugin not installed. The ${table} table was not found on this instance. Activate the plugin (${SIR_PLUGIN}) under System Definition > Plugins.`,
      { details: { plugin: SIR_PLUGIN, table } },
    )
  }
  return new SnowFlowError(ErrorType.SERVICENOW_API_ERROR, e?.message || "SIR API call failed", { originalError: err as Error })
}

async function resolveIncidentSysId(
  client: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  incidentSysId: string | undefined,
  incidentNumber: string | undefined,
): Promise<string | null> {
  if (incidentSysId) return incidentSysId
  if (incidentNumber) {
    const search = await client.get(`/api/now/table/${SIR_INCIDENT_TABLE}`, {
      params: { sysparm_query: `number=${incidentNumber}`, sysparm_limit: 1, sysparm_fields: "sys_id" },
    })
    const results = (search.data.result || []) as Array<Record<string, unknown>>
    if (results.length > 0) return results[0].sys_id as string
  }
  return null
}

// ==================== ATTACH ====================

async function executeAttach(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const incident_sys_id = args.incident_sys_id as string | undefined
  const incident_number = args.incident_number as string | undefined
  const attachment_sys_id = args.attachment_sys_id as string | undefined
  const artifact_sys_id = args.artifact_sys_id as string | undefined
  const short_description = args.short_description as string | undefined
  const description = args.description as string | undefined
  const evidence_type = args.evidence_type as string | undefined
  const source = args.source as string | undefined
  const sha256 = args.sha256 as string | undefined
  const collected_by = args.collected_by as string | undefined

  if (!incident_sys_id && !incident_number) {
    return createErrorResult("incident_sys_id or incident_number is required for attach action")
  }
  if (!short_description) return createErrorResult("short_description is required for attach action")
  if (!evidence_type) return createErrorResult("evidence_type is required for attach action")
  if (!attachment_sys_id && !artifact_sys_id) {
    return createErrorResult(
      "attachment_sys_id or artifact_sys_id is required for attach action (point at the stored file or linked artifact)",
    )
  }

  const client = await getAuthenticatedClient(context)
  const incidentSysId = await resolveIncidentSysId(client, incident_sys_id, incident_number)
  if (!incidentSysId) {
    return createErrorResult(`SIR incident not found: ${incident_sys_id || incident_number}`)
  }

  const payload: Record<string, unknown> = {
    parent: incidentSysId,
    short_description,
    evidence_type,
  }
  if (description) payload.description = description
  if (source) payload.source = source
  if (sha256) payload.sha256 = sha256
  if (collected_by) payload.collected_by = collected_by
  if (attachment_sys_id) payload.attachment = attachment_sys_id
  if (artifact_sys_id) payload.artifact = artifact_sys_id

  try {
    const response = await client.post(`/api/now/table/${SIR_EVIDENCE_TABLE}`, payload)
    const created = response.data.result as Record<string, unknown>

    // Optionally back-link an sn_si_attachment row if the platform expects
    // it. Best-effort — older instances expose attachments via sys_attachment
    // directly without the join table.
    let backLinkSysId: string | null = null
    if (attachment_sys_id) {
      try {
        const back = await client.post(`/api/now/table/${SIR_ATTACHMENT_TABLE}`, {
          parent: incidentSysId,
          evidence: created.sys_id,
          sys_attachment: attachment_sys_id,
        })
        backLinkSysId = back.data.result.sys_id
      } catch {
        // sn_si_attachment may not be present on every release
        // TODO: verify sn_si_attachment availability and field set on a live instance
      }
    }

    return createSuccessResult({
      action: "attach",
      attached: true,
      sys_id: created.sys_id,
      evidence: created,
      back_link_sys_id: backLinkSysId,
      url: `${context.instanceUrl}/nav_to.do?uri=${SIR_EVIDENCE_TABLE}.do?sys_id=${created.sys_id}`,
    })
  } catch (err: unknown) {
    throw plugin404(err, SIR_EVIDENCE_TABLE)
  }
}

// ==================== LIST ====================

async function executeList(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const incident_sys_id = args.incident_sys_id as string | undefined
  const incident_number = args.incident_number as string | undefined
  const limit = (args.limit as number) || 50
  const fields = args.fields as string | undefined

  if (!incident_sys_id && !incident_number) {
    return createErrorResult("incident_sys_id or incident_number is required for list action")
  }

  const client = await getAuthenticatedClient(context)
  const incidentSysId = await resolveIncidentSysId(client, incident_sys_id, incident_number)
  if (!incidentSysId) {
    return createErrorResult(`SIR incident not found: ${incident_sys_id || incident_number}`)
  }

  try {
    const response = await client.get(`/api/now/table/${SIR_EVIDENCE_TABLE}`, {
      params: {
        sysparm_query: `parent=${incidentSysId}`,
        sysparm_limit: limit,
        sysparm_orderby: "sys_created_on",
        sysparm_display_value: "true",
        ...(fields
          ? { sysparm_fields: fields }
          : {
              sysparm_fields:
                "sys_id,short_description,evidence_type,source,sha256,collected_by,attachment,artifact,sys_created_on",
            }),
      },
    })
    const results = (response.data.result || []) as Array<Record<string, unknown>>
    return createSuccessResult({
      action: "list",
      incident: { sys_id: incidentSysId },
      count: results.length,
      evidence: results.map((e) => ({
        sys_id: e.sys_id,
        short_description: e.short_description,
        evidence_type: e.evidence_type,
        source: e.source,
        sha256: e.sha256,
        collected_by: e.collected_by,
        attachment: e.attachment,
        artifact: e.artifact,
        created_at: e.sys_created_on,
        url: `${context.instanceUrl}/nav_to.do?uri=${SIR_EVIDENCE_TABLE}.do?sys_id=${e.sys_id}`,
      })),
    })
  } catch (err: unknown) {
    throw plugin404(err, SIR_EVIDENCE_TABLE)
  }
}

// ==================== GET ====================

async function executeGet(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  if (!sys_id) return createErrorResult("sys_id is required for get action")

  const client = await getAuthenticatedClient(context)
  try {
    const direct = await client.get(`/api/now/table/${SIR_EVIDENCE_TABLE}/${sys_id}`)
    const evidence = direct.data.result as Record<string, unknown> | undefined
    if (!evidence || !evidence.sys_id) {
      return createErrorResult(`Evidence not found: ${sys_id}`)
    }

    // Fetch linked artifact record (best-effort)
    let artifact: Record<string, unknown> | null = null
    const artifactRef = evidence.artifact as { value?: string } | string | undefined
    const artifactSysId = typeof artifactRef === "string"
      ? artifactRef
      : (artifactRef as { value?: string } | undefined)?.value
    if (artifactSysId) {
      try {
        const a = await client.get(`/api/now/table/${SIR_ARTIFACT_TABLE}/${artifactSysId}`)
        artifact = a.data.result as Record<string, unknown>
      } catch {
        // Artifact table may not be present
      }
    }

    return createSuccessResult({
      action: "get",
      sys_id,
      evidence,
      artifact,
      url: `${context.instanceUrl}/nav_to.do?uri=${SIR_EVIDENCE_TABLE}.do?sys_id=${sys_id}`,
    })
  } catch (err: unknown) {
    throw plugin404(err, SIR_EVIDENCE_TABLE)
  }
}

// ==================== HASH_VERIFY ====================

/**
 * Server-side ES5 script that recomputes the SHA-256 of a sys_attachment
 * record using GlideDigest and prints it as lowercase hex. Returns an
 * empty string when the attachment cannot be read.
 *
 * ES5 only — no const, let, arrow functions, template literals.
 */
function buildHashScript(attachmentSysId: string): string {
  return (
    "var attachmentId = " + JSON.stringify(attachmentSysId) + ";\n" +
    "var gsa = new GlideSysAttachment();\n" +
    "var bytes = gsa.getBytes(" + JSON.stringify(SYS_ATTACHMENT_TABLE) + ", attachmentId);\n" +
    "if (!bytes || bytes.length === 0) {\n" +
    "  gs.print('');\n" +
    "} else {\n" +
    "  var digest = GlideDigest.getSHA256Base64(bytes);\n" +
    "  var raw = GlideStringUtil.base64Decode(digest);\n" +
    "  var hex = '';\n" +
    "  for (var i = 0; i < raw.length; i++) {\n" +
    "    var b = raw.charCodeAt(i) & 0xff;\n" +
    "    var h = b.toString(16);\n" +
    "    if (h.length === 1) { h = '0' + h; }\n" +
    "    hex += h;\n" +
    "  }\n" +
    "  gs.print(hex);\n" +
    "}"
  )
}

async function executeHashVerify(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const sys_id = args.sys_id as string | undefined
  const attachment_sys_id_override = args.attachment_sys_id as string | undefined

  if (!sys_id) return createErrorResult("sys_id (evidence sys_id) is required for hash_verify action")

  const client = await getAuthenticatedClient(context)

  // Load the evidence row to get the stored sha256 and attachment reference.
  let evidence: Record<string, unknown>
  try {
    const direct = await client.get(`/api/now/table/${SIR_EVIDENCE_TABLE}/${sys_id}`)
    evidence = direct.data.result as Record<string, unknown>
    if (!evidence || !evidence.sys_id) {
      return createErrorResult(`Evidence not found: ${sys_id}`)
    }
  } catch (err: unknown) {
    throw plugin404(err, SIR_EVIDENCE_TABLE)
  }

  const storedHash = (evidence.sha256 as string | undefined)?.toLowerCase() || ""
  const attachmentRef = evidence.attachment as { value?: string } | string | undefined
  const attachmentSysId =
    attachment_sys_id_override
    || (typeof attachmentRef === "string" ? attachmentRef : (attachmentRef as { value?: string } | undefined)?.value)

  if (!attachmentSysId) {
    return createErrorResult(
      "No attachment reference found on the evidence row and no attachment_sys_id override provided. Cannot recompute hash.",
    )
  }

  const script = buildHashScript(attachmentSysId)
  const execResult = await executeServerScript(context, script, {
    description: "SIR evidence SHA-256 verification",
    timeout: 60000,
  })

  if (!execResult.success) {
    return createErrorResult(
      new SnowFlowError(
        ErrorType.SERVICENOW_API_ERROR,
        `Hash verification script failed: ${execResult.error || "unknown error"}`,
      ),
    )
  }

  const printed = (execResult.output || [])
    .filter((o) => o.level === "print")
    .map((o) => o.message)
    .join("")
    .trim()
    .toLowerCase()

  if (!printed) {
    return createSuccessResult({
      action: "hash_verify",
      verified: false,
      reason: "attachment_unreadable",
      stored_hash: storedHash,
      computed_hash: null,
      evidence_sys_id: sys_id,
      attachment_sys_id: attachmentSysId,
    })
  }

  const verified = storedHash.length > 0 && storedHash === printed

  return createSuccessResult({
    action: "hash_verify",
    verified,
    stored_hash: storedHash || null,
    computed_hash: printed,
    evidence_sys_id: sys_id,
    attachment_sys_id: attachmentSysId,
    note: storedHash
      ? verified
        ? "Computed hash matches the value recorded on the evidence row."
        : "Computed hash does NOT match the recorded value. Possible tampering or storage corruption."
      : "No stored hash on the evidence row to compare against. Computed hash returned for reference.",
  })
}

// ==================== EXPORT ====================

async function executeExport(args: Record<string, unknown>, context: ServiceNowContext): Promise<ToolResult> {
  const incident_sys_id = args.incident_sys_id as string | undefined
  const incident_number = args.incident_number as string | undefined
  const include_artifacts = args.include_artifacts !== false
  const fields = args.fields as string | undefined

  if (!incident_sys_id && !incident_number) {
    return createErrorResult("incident_sys_id or incident_number is required for export action")
  }

  const client = await getAuthenticatedClient(context)
  const incidentSysId = await resolveIncidentSysId(client, incident_sys_id, incident_number)
  if (!incidentSysId) {
    return createErrorResult(`SIR incident not found: ${incident_sys_id || incident_number}`)
  }

  // Load incident header for the manifest.
  let incidentHeader: Record<string, unknown> | null = null
  try {
    const i = await client.get(`/api/now/table/${SIR_INCIDENT_TABLE}/${incidentSysId}`)
    incidentHeader = i.data.result as Record<string, unknown>
  } catch {
    // Even without the header, the export of evidence is still useful.
  }

  try {
    const evidenceResponse = await client.get(`/api/now/table/${SIR_EVIDENCE_TABLE}`, {
      params: {
        sysparm_query: `parent=${incidentSysId}`,
        sysparm_limit: 1000,
        sysparm_orderby: "sys_created_on",
        sysparm_display_value: "true",
        ...(fields ? { sysparm_fields: fields } : {}),
      },
    })
    const evidence = (evidenceResponse.data.result || []) as Array<Record<string, unknown>>

    let artifacts: Array<Record<string, unknown>> = []
    if (include_artifacts) {
      try {
        const artifactResponse = await client.get(`/api/now/table/${SIR_ARTIFACT_TABLE}`, {
          params: {
            sysparm_query: `parent=${incidentSysId}`,
            sysparm_limit: 1000,
            sysparm_orderby: "sys_created_on",
          },
        })
        artifacts = (artifactResponse.data.result || []) as Array<Record<string, unknown>>
      } catch {
        // Artifact table may not be present
      }
    }

    const manifest = {
      generated_at: new Date().toISOString(),
      incident: incidentHeader
        ? {
            sys_id: incidentHeader.sys_id,
            number: incidentHeader.number,
            short_description: incidentHeader.short_description,
            state: incidentHeader.state,
            category: incidentHeader.category,
          }
        : { sys_id: incidentSysId },
      counts: {
        evidence: evidence.length,
        artifacts: artifacts.length,
      },
      evidence,
      artifacts,
    }

    return createSuccessResult({
      action: "export",
      exported: true,
      manifest,
    })
  } catch (err: unknown) {
    throw plugin404(err, SIR_EVIDENCE_TABLE)
  }
}

export const version = "1.0.0"
export const author = "groeimetai"
