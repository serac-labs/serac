/**
 * snow_github_deploy - GitHub → ServiceNow Deployment Pipeline (Enterprise)
 *
 * Deploys files directly from a GitHub repository to ServiceNow without
 * file content passing through the LLM context window. Content flows:
 *
 *   tool process → proxyToolCall('github_get_content') → enterprise server → GitHub API
 *   tool process → getAuthenticatedClient() → ServiceNow Table API
 *
 * Three deployment modes:
 * 1. Single file: Deploy one file to a specific artifact field
 * 2. Directory → Widget: Auto-map directory files to widget fields via FILE_MAPPINGS
 * 3. Bulk: Deploy all matching files in a directory as separate artifacts
 *
 * Requires enterprise license with 'github' feature enabled.
 * GitHub PAT is managed server-side via the enterprise portal.
 */

import { type MCPToolDefinition, type ServiceNowContext, type ToolResult } from "../../shared/types.js"
import { getAuthenticatedClient } from "../../shared/auth.js"
import { createSuccessResult, createErrorResult } from "../../shared/error-handler.js"
import { proxyToolCall } from "../../../enterprise-proxy/proxy.js"
import {
  ARTIFACT_TABLE_MAP,
  ARTIFACT_IDENTIFIER_FIELD,
  FILE_MAPPINGS,
  DEFAULT_FILE_EXTENSIONS,
} from "./shared/artifact-constants.js"

export const toolDefinition: MCPToolDefinition = {
  name: "snow_github_deploy",
  description: `Deploy files directly from GitHub to ServiceNow — content never passes through LLM context.

Three modes:
1. Single file: source_path → one artifact field
2. Directory → Widget: source_directory auto-maps files (template.html→template, server.js→script, etc.)
3. Bulk: source_directory + bulk=true → each file becomes a separate artifact

Requires: Enterprise license with 'github' feature. GitHub PAT is managed server-side.

Supported target types: widget, script_include, business_rule, client_script, ui_action, scheduled_job, fix_script, etc.`,
  category: "development",
  subcategory: "deployment",
  use_cases: ["github", "deployment", "pipeline", "widgets", "scripts"],
  complexity: "intermediate",
  frequency: "high",

  permission: "write",
  allowedRoles: ["developer", "admin"],
  inputSchema: {
    type: "object",
    properties: {
      owner: {
        type: "string",
        description: "GitHub owner or organization",
      },
      repo: {
        type: "string",
        description: "Repository name",
      },
      branch: {
        type: "string",
        description: 'Branch name (default: "main")',
      },
      source_path: {
        type: "string",
        description: '[Mode 1] Path to a single file in the repo (e.g. "scripts/MyScript.js")',
      },
      source_directory: {
        type: "string",
        description: '[Mode 2/3] Path to a directory in the repo (e.g. "widgets/my_widget/")',
      },
      target_type: {
        type: "string",
        description: "ServiceNow artifact type",
        enum: [
          "sp_widget",
          "widget",
          "sp_page",
          "page",
          "sys_ux_page",
          "uib_page",
          "script_include",
          "business_rule",
          "client_script",
          "ui_policy",
          "ui_action",
          "rest_message",
          "scheduled_job",
          "transform_map",
          "fix_script",
          "flow",
          "application",
        ],
      },
      target_identifier: {
        type: "string",
        description: "[Mode 1/2] Name or ID of the target artifact in ServiceNow",
      },
      target_sys_id: {
        type: "string",
        description: "Alternative: sys_id of the target artifact",
      },
      target_field: {
        type: "string",
        description: '[Mode 1] Which field to update (auto-detected if omitted, e.g. "script", "template")',
      },
      upsert: {
        type: "boolean",
        description: "Create artifact if it does not exist (default: true)",
      },
      bulk: {
        type: "boolean",
        description: "[Mode 3] Deploy each file in directory as a separate artifact (default: false)",
      },
      file_extension_filter: {
        type: "string",
        description: '[Mode 3] Filter files by extension in bulk mode (e.g. ".js")',
      },
      field_mapping: {
        type: "object",
        description: '[Mode 2] Custom filename→field mapping override (e.g. {"my-template.html": "template"})',
      },
      dry_run: {
        type: "boolean",
        description: "Preview what would be deployed without actually deploying (default: false)",
      },
    },
    required: ["owner", "repo", "target_type"],
  },
}

export async function execute(args: any, context: ServiceNowContext): Promise<ToolResult> {
  const {
    owner,
    repo,
    branch = "main",
    source_path,
    source_directory,
    target_type,
    target_identifier,
    target_sys_id,
    target_field,
    upsert = true,
    bulk = false,
    file_extension_filter,
    field_mapping,
    dry_run = false,
  } = args

  // Enterprise feature gate
  if (!context.enterprise?.features?.includes("github")) {
    return createErrorResult(
      'GitHub integration requires an enterprise license with the "github" feature enabled.\n\n' +
        "Upgrade at https://portal.serac.build or contact support.",
    )
  }

  // Validate artifact type
  const tableName = ARTIFACT_TABLE_MAP[target_type]
  if (!tableName) {
    return createErrorResult(
      `Unsupported target_type: ${target_type}. Valid types: ${Object.keys(ARTIFACT_TABLE_MAP).join(", ")}`,
    )
  }

  // Determine mode
  if (source_path) {
    return await deploySingleFile(args, context, tableName)
  } else if (source_directory && bulk) {
    return await deployBulk(args, context, tableName)
  } else if (source_directory) {
    return await deployDirectory(args, context, tableName)
  } else {
    return createErrorResult("Provide either source_path (single file) or source_directory (directory/bulk mode).")
  }
}

// ==================== MODE 1: SINGLE FILE ====================
async function deploySingleFile(args: any, context: ServiceNowContext, tableName: string): Promise<ToolResult> {
  const {
    owner,
    repo,
    branch = "main",
    source_path,
    target_type,
    target_identifier,
    target_sys_id,
    target_field,
    upsert = true,
    dry_run = false,
  } = args

  if (!target_identifier && !target_sys_id) {
    return createErrorResult("target_identifier or target_sys_id is required for single-file mode.")
  }

  // Fetch file content from GitHub via enterprise proxy
  let fileContent: string
  try {
    const result = await proxyToolCall("github_get_content", {
      owner,
      repo,
      path: source_path,
      ref: branch,
    })

    // GitHub API returns base64-encoded content for files
    if (result.content && result.encoding === "base64") {
      fileContent = Buffer.from(result.content, "base64").toString("utf-8")
    } else if (typeof result.content === "string") {
      fileContent = result.content
    } else if (typeof result === "string") {
      fileContent = result
    } else {
      return createErrorResult(`Unexpected response format from GitHub for ${source_path}. Expected file content.`)
    }
  } catch (error: any) {
    return createErrorResult(`Failed to fetch ${source_path} from ${owner}/${repo}: ${error.message}`)
  }

  // Determine target field
  const resolvedField = target_field || autoDetectField(source_path, tableName)
  if (!resolvedField) {
    return createErrorResult(
      `Cannot auto-detect target field for "${source_path}" on ${target_type}. Specify target_field explicitly.`,
    )
  }

  if (dry_run) {
    return createSuccessResult({
      mode: "single_file",
      dry_run: true,
      source: { owner, repo, branch, path: source_path, size: fileContent.length },
      target: {
        type: target_type,
        table: tableName,
        identifier: target_identifier || target_sys_id,
        field: resolvedField,
      },
      message: "Dry run — no changes made.",
    })
  }

  // Deploy to ServiceNow
  const client = await getAuthenticatedClient(context)
  const deployResult = await upsertArtifact(
    client,
    context,
    tableName,
    target_type,
    target_sys_id,
    target_identifier,
    { [resolvedField]: fileContent },
    upsert,
  )

  return createSuccessResult({
    mode: "single_file",
    deployed: true,
    source: { owner, repo, branch, path: source_path, size: fileContent.length },
    target: {
      type: target_type,
      table: tableName,
      sys_id: deployResult.sys_id,
      name: deployResult.name,
      field: resolvedField,
      action: deployResult.action,
    },
    url: `${context.instanceUrl}/nav_to.do?uri=${tableName}.do?sys_id=${deployResult.sys_id}`,
  })
}

// ==================== MODE 2: DIRECTORY → WIDGET ====================
async function deployDirectory(args: any, context: ServiceNowContext, tableName: string): Promise<ToolResult> {
  const {
    owner,
    repo,
    branch = "main",
    source_directory,
    target_type,
    target_identifier,
    target_sys_id,
    field_mapping,
    upsert = true,
    dry_run = false,
  } = args

  if (!target_identifier && !target_sys_id) {
    return createErrorResult("target_identifier or target_sys_id is required for directory mode.")
  }

  // List directory contents from GitHub
  let dirEntries: any[]
  try {
    const result = await proxyToolCall("github_get_content", {
      owner,
      repo,
      path: source_directory,
      ref: branch,
    })
    dirEntries = Array.isArray(result) ? result : []
  } catch (error: any) {
    return createErrorResult(`Failed to list ${source_directory} in ${owner}/${repo}: ${error.message}`)
  }

  // Build file→field mapping: custom override or auto-map via FILE_MAPPINGS
  const fileMappings = FILE_MAPPINGS[tableName] || {}
  const resolvedMapping: Record<string, string> = {} // filename → field

  for (const entry of dirEntries) {
    if (entry.type !== "file") continue
    const filename = entry.name || entry.path?.split("/").pop()
    if (!filename) continue

    // Check custom field_mapping first
    if (field_mapping && field_mapping[filename]) {
      resolvedMapping[filename] = field_mapping[filename]
      continue
    }

    // Auto-map via FILE_MAPPINGS
    for (const [field, filenames] of Object.entries(fileMappings)) {
      if ((filenames as string[]).includes(filename)) {
        resolvedMapping[filename] = field
        break
      }
    }
  }

  if (Object.keys(resolvedMapping).length === 0) {
    return createErrorResult(
      `No files in ${source_directory} matched field mappings for ${target_type}. ` +
        `Expected files: ${JSON.stringify(fileMappings)}. ` +
        `Found: ${dirEntries
          .filter((e: any) => e.type === "file")
          .map((e: any) => e.name)
          .join(", ")}`,
    )
  }

  if (dry_run) {
    return createSuccessResult({
      mode: "directory",
      dry_run: true,
      source: { owner, repo, branch, directory: source_directory },
      mapping: resolvedMapping,
      target: { type: target_type, table: tableName, identifier: target_identifier || target_sys_id },
      message: "Dry run — no changes made.",
    })
  }

  // Fetch each mapped file and combine into one update payload
  const updatePayload: Record<string, string> = {}
  const fetchedFiles: string[] = []

  for (const [filename, field] of Object.entries(resolvedMapping)) {
    const filePath = source_directory.replace(/\/$/, "") + "/" + filename
    try {
      const result = await proxyToolCall("github_get_content", {
        owner,
        repo,
        path: filePath,
        ref: branch,
      })

      let content: string
      if (result.content && result.encoding === "base64") {
        content = Buffer.from(result.content, "base64").toString("utf-8")
      } else if (typeof result.content === "string") {
        content = result.content
      } else if (typeof result === "string") {
        content = result
      } else {
        continue
      }

      updatePayload[field] = content
      fetchedFiles.push(`${filename} → ${field} (${content.length} chars)`)
    } catch (error: any) {
      fetchedFiles.push(`${filename} → ${field} (FAILED: ${error.message})`)
    }
  }

  if (Object.keys(updatePayload).length === 0) {
    return createErrorResult("Failed to fetch any matched files from GitHub.")
  }

  // Deploy combined payload to ServiceNow
  const client = await getAuthenticatedClient(context)
  const deployResult = await upsertArtifact(
    client,
    context,
    tableName,
    target_type,
    target_sys_id,
    target_identifier,
    updatePayload,
    upsert,
  )

  return createSuccessResult({
    mode: "directory",
    deployed: true,
    source: { owner, repo, branch, directory: source_directory },
    files: fetchedFiles,
    fields_updated: Object.keys(updatePayload),
    target: {
      type: target_type,
      table: tableName,
      sys_id: deployResult.sys_id,
      name: deployResult.name,
      action: deployResult.action,
    },
    url: `${context.instanceUrl}/nav_to.do?uri=${tableName}.do?sys_id=${deployResult.sys_id}`,
  })
}

// ==================== MODE 3: BULK ====================
async function deployBulk(args: any, context: ServiceNowContext, tableName: string): Promise<ToolResult> {
  const {
    owner,
    repo,
    branch = "main",
    source_directory,
    target_type,
    file_extension_filter,
    upsert = true,
    dry_run = false,
  } = args

  // Determine extension filter
  const extFilter = file_extension_filter || DEFAULT_FILE_EXTENSIONS[tableName] || ".js"

  // List directory contents
  let dirEntries: any[]
  try {
    const result = await proxyToolCall("github_get_content", {
      owner,
      repo,
      path: source_directory,
      ref: branch,
    })
    dirEntries = Array.isArray(result) ? result : []
  } catch (error: any) {
    return createErrorResult(`Failed to list ${source_directory} in ${owner}/${repo}: ${error.message}`)
  }

  // Filter files by extension
  const matchedFiles = dirEntries.filter((entry: any) => {
    if (entry.type !== "file") return false
    const name = entry.name || entry.path?.split("/").pop() || ""
    return name.endsWith(extFilter)
  })

  if (matchedFiles.length === 0) {
    return createErrorResult(
      `No files matching "${extFilter}" found in ${source_directory}. ` +
        `Found: ${
          dirEntries
            .filter((e: any) => e.type === "file")
            .map((e: any) => e.name)
            .join(", ") || "(empty)"
        }`,
    )
  }

  if (dry_run) {
    return createSuccessResult({
      mode: "bulk",
      dry_run: true,
      source: { owner, repo, branch, directory: source_directory },
      files: matchedFiles.map((f: any) => ({
        filename: f.name,
        artifact_name: deriveArtifactName(f.name),
        size: f.size,
      })),
      filter: extFilter,
      target: { type: target_type, table: tableName },
      message: `Dry run — would deploy ${matchedFiles.length} files.`,
    })
  }

  // Deploy each file as a separate artifact
  const client = await getAuthenticatedClient(context)
  const results: any[] = []
  let successCount = 0
  let failCount = 0

  // Determine which field to populate based on artifact type
  const scriptField = getDefaultScriptField(tableName)

  for (const file of matchedFiles) {
    const filename = file.name || file.path?.split("/").pop()
    const artifactName = deriveArtifactName(filename)
    const filePath = source_directory.replace(/\/$/, "") + "/" + filename

    try {
      // Fetch file content
      const result = await proxyToolCall("github_get_content", {
        owner,
        repo,
        path: filePath,
        ref: branch,
      })

      let content: string
      if (result.content && result.encoding === "base64") {
        content = Buffer.from(result.content, "base64").toString("utf-8")
      } else if (typeof result.content === "string") {
        content = result.content
      } else if (typeof result === "string") {
        content = result
      } else {
        results.push({ filename, artifact_name: artifactName, success: false, error: "Unexpected response format" })
        failCount++
        continue
      }

      // Upsert to ServiceNow
      const deployResult = await upsertArtifact(
        client,
        context,
        tableName,
        target_type,
        undefined,
        artifactName,
        { [scriptField]: content, name: artifactName },
        upsert,
      )

      results.push({
        filename,
        artifact_name: artifactName,
        success: true,
        sys_id: deployResult.sys_id,
        action: deployResult.action,
        size: content.length,
      })
      successCount++
    } catch (error: any) {
      results.push({
        filename,
        artifact_name: artifactName,
        success: false,
        error: error.message,
      })
      failCount++
    }
  }

  return createSuccessResult({
    mode: "bulk",
    deployed: true,
    source: { owner, repo, branch, directory: source_directory, filter: extFilter },
    target: { type: target_type, table: tableName },
    summary: {
      total: matchedFiles.length,
      success: successCount,
      failed: failCount,
    },
    results,
  })
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Auto-detect the ServiceNow field based on file extension and artifact type
 */
function autoDetectField(filePath: string, tableName: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase()
  const filename = filePath.split("/").pop()?.toLowerCase() || ""

  // Check FILE_MAPPINGS for exact filename match
  const mappings = FILE_MAPPINGS[tableName]
  if (mappings) {
    for (const [field, filenames] of Object.entries(mappings)) {
      if ((filenames as string[]).some((f) => filename === f || filename.endsWith(f))) {
        return field
      }
    }
  }

  // Fallback: extension-based detection
  if (ext === "html") return "template"
  if (ext === "css") return "css"
  if (ext === "json" && filename.includes("option")) return "option_schema"
  if (ext === "js") return getDefaultScriptField(tableName)

  return null
}

/**
 * Get the default script field name for a given table
 */
function getDefaultScriptField(tableName: string): string {
  // Widgets use 'script' for server-side (confusingly, not 'server_script')
  if (tableName === "sp_widget") return "script"
  return "script"
}

/**
 * Derive artifact name from filename (strip extension)
 */
function deriveArtifactName(filename: string): string {
  // Remove extension
  const lastDot = filename.lastIndexOf(".")
  return lastDot > 0 ? filename.substring(0, lastDot) : filename
}

/**
 * Find or create an artifact in ServiceNow
 */
async function upsertArtifact(
  client: any,
  context: ServiceNowContext,
  tableName: string,
  artifactType: string,
  sysId: string | undefined,
  identifier: string | undefined,
  fields: Record<string, string>,
  upsert: boolean,
): Promise<{ sys_id: string; name: string; action: "created" | "updated" }> {
  const identifierField = ARTIFACT_IDENTIFIER_FIELD[tableName] || "name"

  // Try to find existing artifact
  let existingArtifact: any = null

  if (sysId) {
    try {
      const response = await client.get(`/api/now/table/${tableName}/${sysId}`, {
        params: { sysparm_fields: "sys_id,name,id" },
      })
      existingArtifact = response.data.result
    } catch (e) {
      // Not found by sys_id
    }
  }

  if (!existingArtifact && identifier) {
    const queryParts = [`${identifierField}=${identifier}`]
    if (tableName === "sp_widget") {
      queryParts.push(`id=${identifier}`)
    }
    queryParts.push(`name=${identifier}`)

    try {
      const response = await client.get(`/api/now/table/${tableName}`, {
        params: {
          sysparm_query: queryParts.join("^OR"),
          sysparm_fields: "sys_id,name,id",
          sysparm_limit: 1,
        },
      })

      if (response.data.result && response.data.result.length > 0) {
        existingArtifact = response.data.result[0]
      }
    } catch (e) {
      // Not found
    }
  }

  if (existingArtifact) {
    // Update existing
    const updateResponse = await client.patch(`/api/now/table/${tableName}/${existingArtifact.sys_id}`, fields)
    return {
      sys_id: existingArtifact.sys_id,
      name: updateResponse.data.result?.name || existingArtifact.name || existingArtifact.id || identifier || "",
      action: "updated",
    }
  }

  if (!upsert) {
    throw new Error(`Artifact '${identifier || sysId}' not found and upsert=false.`)
  }

  // Create new artifact
  // Ensure identifier fields are set
  const createData: Record<string, any> = { ...fields }
  if (identifier) {
    if (identifierField === "id") {
      createData.id = identifier
      if (!createData.name) createData.name = identifier
    } else {
      createData[identifierField] = identifier
    }
  }

  const createResponse = await client.post(`/api/now/table/${tableName}`, createData)
  const created = createResponse.data.result

  return {
    sys_id: created.sys_id,
    name: created.name || created.id || identifier || "",
    action: "created",
  }
}

export const version = "1.0.0"
export const author = "Serac Enterprise GitHub Pipeline"
