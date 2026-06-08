/**
 * snow_blast_radius_artifact_dependencies - Analyze what an artifact depends on
 *
 * Forward dependency analysis: for a given artifact (business rule, client script, etc.),
 * analyze its script body to determine what fields it reads/writes, what tables it queries,
 * and what script includes it calls.
 */

import { MCPToolDefinition, ServiceNowContext, ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import { ARTIFACT_TABLE_MAP } from "./shared/metadata-tables.js"
import { analyzeScript } from "./shared/script-analyzer.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_blast_radius_artifact_dependencies",
  description: `Forward dependency analysis for a single artifact: what does it read, write, and depend on?

Use to understand what fields a business rule touches, what tables a script include queries, which script includes an artifact calls, and the artifact's complexity/risk profile.

Example: "What does this business rule touch?"

Returns:
- Fields read and written (with line numbers)
- Tables queried via GlideRecord
- Script includes called (deep mode also resolves them to sys_id/scope/active)
- Glide APIs used
- Risk assessment: low / medium / high complexity`,
  category: "blast-radius",
  subcategory: "artifact-analysis",
  use_cases: ["impact-analysis", "code-review", "dependency-analysis"],
  complexity: "advanced",
  frequency: "high",
  permission: "read",
  allowedRoles: ["developer", "stakeholder", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      artifact_type: {
        type: "string",
        enum: ["business_rule", "client_script", "ui_action", "ui_policy", "script_include", "acl", "flow", "widget"],
        description: "Type of artifact to analyze",
      },
      artifact_sys_id: {
        type: "string",
        description: "sys_id of the artifact",
      },
      analysis_depth: {
        type: "string",
        enum: ["shallow", "deep"],
        description: "shallow = field refs only; deep = also resolves script include calls (default: deep)",
        default: "deep",
      },
    },
    required: ["artifact_type", "artifact_sys_id"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const { artifact_type, artifact_sys_id, analysis_depth = "deep" } = args

  if (!artifact_type || !artifact_sys_id) {
    return createErrorResult("artifact_type and artifact_sys_id are required")
  }

  const mapping = ARTIFACT_TABLE_MAP[artifact_type]
  if (!mapping) {
    return createErrorResult(`Unknown artifact type: ${artifact_type}. Valid types: ${Object.keys(ARTIFACT_TABLE_MAP).join(", ")}`)
  }

  try {
    const client = await getAuthenticatedClient(context)

    // Fetch the artifact record
    const response = await client.get(`/api/now/table/${mapping.table}/${artifact_sys_id}`)
    const artifact = response.data.result

    if (!artifact) {
      return createErrorResult(`Artifact not found: ${artifact_type} with sys_id ${artifact_sys_id}`)
    }

    // Extract and analyze all script fields
    const allScripts = mapping.scriptFields
      .map((field) => artifact[field] || "")
      .filter((s) => s.trim() !== "")
      .join("\n\n// --- Next script field ---\n\n")

    const contextTable = mapping.tableField
      ? (artifact[mapping.tableField]?.value || artifact[mapping.tableField] || undefined)
      : undefined

    const analysis = analyzeScript(allScripts, contextTable)

    // Deep analysis: resolve script include references
    let resolvedIncludes: any[] = []
    if (analysis_depth === "deep" && analysis.script_includes_called.length > 0) {
      const includePromises = analysis.script_includes_called.map(async (si) => {
        try {
          const siResponse = await client.get(`/api/now/table/sys_script_include`, {
            params: {
              sysparm_query: `name=${si.name}^ORapi_nameLIKE${si.name}`,
              sysparm_fields: "sys_id,name,api_name,active,sys_scope",
              sysparm_limit: 1,
            },
          })
          const siRecord = siResponse.data.result?.[0]
          return {
            name: si.name,
            methods_called: si.methods_called,
            resolved: siRecord ? {
              sys_id: siRecord.sys_id,
              api_name: siRecord.api_name,
              active: siRecord.active,
              scope: siRecord.sys_scope?.value || siRecord.sys_scope,
            } : null,
          }
        } catch {
          return { name: si.name, methods_called: si.methods_called, resolved: null }
        }
      })

      resolvedIncludes = await Promise.allSettled(includePromises).then((results) =>
        results
          .filter((r) => r.status === "fulfilled")
          .map((r) => (r as PromiseFulfilledResult<any>).value)
      )
    }

    // Calculate risk assessment
    const fieldCount = analysis.fields_read.length + analysis.fields_written.length
    const tableCount = analysis.tables_queried.length
    const crossScope = resolvedIncludes.some((si) =>
      si.resolved?.scope && si.resolved.scope !== (artifact.sys_scope?.value || artifact.sys_scope)
    )

    let complexity: "low" | "medium" | "high" = "low"
    if (fieldCount > 10 || tableCount > 3 || crossScope) {
      complexity = "high"
    } else if (fieldCount > 5 || tableCount > 1) {
      complexity = "medium"
    }

    const result = {
      artifact: {
        sys_id: artifact.sys_id,
        name: artifact.name || artifact.short_description || "Unknown",
        type: artifact_type,
        table: contextTable,
        active: artifact.active,
        scope: artifact.sys_scope?.value || artifact.sys_scope,
      },
      dependencies: {
        fields_read: analysis.fields_read,
        fields_written: analysis.fields_written,
        tables_queried: analysis.tables_queried.map((t) => ({
          table: t.table,
          operations: ["query"], // Basic detection; could be enhanced
        })),
        script_includes_called: resolvedIncludes.length > 0
          ? resolvedIncludes
          : analysis.script_includes_called,
        glide_apis_used: analysis.glide_apis_used,
      },
      risk_assessment: {
        field_count: fieldCount,
        table_count: tableCount,
        cross_scope_references: crossScope,
        complexity,
      },
    }

    const summary = `Artifact "${result.artifact.name}" (${artifact_type}): ${analysis.fields_read.length} fields read, ${analysis.fields_written.length} fields written, ${tableCount} tables queried, ${analysis.script_includes_called.length} script includes. Complexity: ${complexity}`

    return createSuccessResult(result, {
      apiCalls: 1 + (analysis_depth === "deep" ? analysis.script_includes_called.length : 0),
    }, summary)
  } catch (error: any) {
    return createErrorResult(error.message)
  }
}

export const version = "1.0.0"
export const author = "Serac Blast Radius"
